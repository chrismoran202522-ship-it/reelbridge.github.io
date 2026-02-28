const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypal = require('@paypal/checkout-server-sdk');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// PayPal setup - FIXED: Use LiveEnvironment for production
const Environment = process.env.NODE_ENV === 'production' 
    ? paypal.core.LiveEnvironment 
    : paypal.core.SandboxEnvironment;

const paypalEnvironment = new Environment(
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET
);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnvironment);

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// JWT middleware
const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// Admin middleware
const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    next();
};

// ==================== DATABASE SCHEMA UPDATES ====================
async function runSchemaUpdates() {
    const client = await pool.connect();
    try {
        console.log('🔧 Running database schema updates...');
        
        // Check if columns exist and add them if they don't
        const checkColumn = async (table, column) => {
            const result = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = $1 AND column_name = $2
            `, [table, column]);
            return result.rows.length > 0;
        };
        
        // Add business information columns
        const columnsToAdd = [
            { name: 'business_name', type: 'VARCHAR(255)' },
            { name: 'contact_name', type: 'VARCHAR(255)' },
            { name: 'phone', type: 'VARCHAR(50)' },
            { name: 'website', type: 'VARCHAR(255)' },
            { name: 'industry', type: 'VARCHAR(100)' },
            { name: 'tax_id', type: 'VARCHAR(50)' },
            { name: 'referral_source', type: 'VARCHAR(100)' },
            { name: 'marketing_consent', type: 'BOOLEAN DEFAULT false' },
            { name: 'address_street', type: 'VARCHAR(255)' },
            { name: 'address_city', type: 'VARCHAR(100)' },
            { name: 'address_state', type: 'VARCHAR(100)' },
            { name: 'address_zip', type: 'VARCHAR(20)' },
            { name: 'address_country', type: 'VARCHAR(100) DEFAULT \'US\'' },
            { name: 'features', type: 'JSONB DEFAULT \'{}\'' }
        ];
        
        for (const col of columnsToAdd) {
            const exists = await checkColumn('users', col.name);
            if (!exists) {
                await client.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
                console.log(`✅ Added column: ${col.name}`);
            }
        }
        
        // Update status check constraint
        try {
            await client.query(`
                ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check
            `);
            await client.query(`
                ALTER TABLE users ADD CONSTRAINT users_status_check 
                CHECK (status IN ('pending', 'active', 'suspended', 'cancelled'))
            `);
            console.log('✅ Updated status constraint');
        } catch (e) {
            console.log('⚠️ Status constraint may already exist');
        }
        
        console.log('✅ Schema updates complete');
    } catch (error) {
        console.error('❌ Schema update error:', error);
        throw error;
    } finally {
        client.release();
    }
}

// ==================== DATABASE INITIALIZATION ====================
async function initDatabase() {
    // Run schema updates first
    await runSchemaUpdates();
    
    const client = await pool.connect();
    try {
        // Create tables if they don't exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255),
                role VARCHAR(20) DEFAULT 'customer',
                package VARCHAR(50),
                billing_cycle VARCHAR(20),
                posts_remaining INTEGER DEFAULT 0,
                posts_used INTEGER DEFAULT 0,
                posts_published INTEGER DEFAULT 0,
                platforms TEXT[],
                is_active BOOLEAN DEFAULT true,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                force_password_change BOOLEAN DEFAULT false,
                paypal_order_id VARCHAR(255),
                stripe_customer_id VARCHAR(255),
                business_name VARCHAR(255),
                contact_name VARCHAR(255),
                phone VARCHAR(50),
                website VARCHAR(255),
                industry VARCHAR(100),
                tax_id VARCHAR(50),
                referral_source VARCHAR(100),
                marketing_consent BOOLEAN DEFAULT false,
                address_street VARCHAR(255),
                address_city VARCHAR(100),
                address_state VARCHAR(100),
                address_zip VARCHAR(20),
                address_country VARCHAR(100) DEFAULT 'US',
                features JSONB DEFAULT '{}'
            );
            
            CREATE TABLE IF NOT EXISTS scheduled_posts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                platforms TEXT[] NOT NULL,
                media_urls TEXT[],
                scheduled_time TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                published_at TIMESTAMP,
                engagement_stats JSONB
            );
            
            CREATE TABLE IF NOT EXISTS social_accounts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                platform VARCHAR(50) NOT NULL,
                account_username VARCHAR(255),
                profile_url TEXT,
                access_token TEXT,
                refresh_token TEXT,
                is_active BOOLEAN DEFAULT true,
                connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS ai_generated_content (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                topic VARCHAR(255),
                content TEXT,
                platforms TEXT[],
                used BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS admin_logs (
                id SERIAL PRIMARY KEY,
                action VARCHAR(255),
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                details JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS package_config (
                id SERIAL PRIMARY KEY,
                package_name VARCHAR(50) UNIQUE NOT NULL,
                price_monthly INTEGER NOT NULL,
                price_quarterly INTEGER,
                posts_limit INTEGER DEFAULT 0,
                platforms_limit INTEGER DEFAULT 0,
                features JSONB DEFAULT '{}',
                is_active BOOLEAN DEFAULT true,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Create admin if not exists
        const admin = await client.query('SELECT * FROM users WHERE role = $1', ['admin']);
        if (admin.rows.length === 0) {
            const hash = await bcrypt.hash('123456', 10);
            await client.query(
                `INSERT INTO users (
                    email, password_hash, role, force_password_change, is_active, status,
                    business_name, contact_name, phone, address_street, address_city, address_state, address_zip
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                    'cmoran@reelbridge.site', hash, 'admin', true, true, 'active',
                    'ReelBridge Admin', 'Admin User', '506-271-7605', '123 Admin St', 'Admin City', 'Admin State', '00000'
                ]
            );
            console.log('✅ Admin created: cmoran@reelbridge.site / 123456');
        }
        
        // Initialize default packages if not exists
        const packages = await client.query('SELECT * FROM package_config');
        if (packages.rows.length === 0) {
            await client.query(`
                INSERT INTO package_config (package_name, price_monthly, posts_limit, platforms_limit, features) VALUES
                ('starter', 254, 30, 3, '{"ai_content": true, "basic_analytics": true, "basic_dashboard": true}'),
                ('growth', 509, 75, 6, '{"ai_content": true, "ai_video": true, "auto_engagement": true, "priority_support": true, "basic_dashboard": true, "analytics_advanced": true}'),
                ('professional', 849, 999999, 10, '{"ai_content": true, "ai_video": true, "ai_image": true, "dedicated_manager": true, "unlimited": true, "basic_dashboard": true, "analytics_advanced": true, "content_scheduler": true}'),
                ('custom', 99, 50, 3, '{"base": true, "basic_dashboard": true}')
            `);
            console.log('✅ Default packages created');
        }
        
        console.log('✅ Database ready');
    } finally {
        client.release();
    }
}

// ==================== AUTH ====================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (user.status === 'pending') {
            return res.status(403).json({ error: 'Account pending admin approval' });
        }
        
        if (!user.is_active || user.status === 'suspended') {
            return res.status(403).json({ error: 'Account suspended' });
        }
        
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
        
        const token = jwt.sign(
            { 
                userId: user.id, 
                email: user.email, 
                role: user.role, 
                package: user.package, 
                forcePasswordChange: user.force_password_change 
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                package: user.package,
                postsRemaining: user.posts_remaining,
                postsUsed: user.posts_used,
                platforms: user.platforms,
                forcePasswordChange: user.force_password_change,
                features: user.features
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/change-password', authenticateToken, async (req, res) => {
    const { newPassword } = req.body;
    try {
        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1, force_password_change = false WHERE id = $2', [hash, req.user.userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== USER REGISTRATION ====================
app.post('/api/register', async (req, res) => {
    const {
        email,
        password,
        businessName,
        contactName,
        phone,
        website,
        industry,
        address,
        taxId,
        referral,
        marketingConsent
    } = req.body;

    try {
        // Check if user exists
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hash = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            `INSERT INTO users (
                email, password_hash, role, package, status,
                business_name, contact_name, phone, website, industry,
                address_street, address_city, address_state, address_zip, address_country,
                tax_id, referral_source, marketing_consent,
                posts_remaining, posts_used, posts_published,
                features, is_active, force_password_change, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, NOW())
            RETURNING id`,
            [
                email, hash, 'customer', 'starter', 'pending',
                businessName, contactName, phone, website, industry,
                address.street, address.city, address.state, address.zip, address.country,
                taxId, referral, marketingConsent,
                0, 0, 0,
                JSON.stringify({ basic_dashboard: true }),
                false, false
            ]
        );

        // Log the registration
        await pool.query(
            `INSERT INTO admin_logs (action, user_id, details) VALUES ($1, $2, $3)`,
            ['user_registered', result.rows[0].id, { email, businessName, industry }]
        );

        res.status(201).json({ 
            success: true, 
            message: 'Account created successfully. Please wait for admin approval.',
            userId: result.rows[0].id 
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== PACKAGES ====================
app.get('/api/packages', async (req, res) => {
    try {
        const packages = await pool.query('SELECT * FROM package_config WHERE is_active = true ORDER BY price_monthly');
        res.json(packages.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PAYMENTS ====================
app.post('/api/create-stripe-intent', async (req, res) => {
    const { package, amount, email, billingCycle, features } = req.body;
    const postsMap = { 'starter': 30, 'growth': 75, 'professional': 999999, 'custom': features?.posts || 50 };
    
    try {
        const intent = await stripe.paymentIntents.create({
            amount: amount * 100,
            currency: 'usd',
            receipt_email: email,
            metadata: { package, billingCycle, customer_email: email, posts_limit: postsMap[package] || 50 }
        });
        res.json({ clientSecret: intent.client_secret });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/create-paypal-order', async (req, res) => {
    const { package, amount, billingCycle, features } = req.body;
    
    console.log('Creating PayPal order:', { package, amount, billingCycle });
    
    const request = new paypal.orders.OrdersCreateRequest();
    request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
            amount: { 
                currency_code: 'USD', 
                value: amount.toString() 
            },
            description: `Reel Bridge ${package}`,
            custom_id: JSON.stringify({ package, billingCycle, features })
        }]
    });
    
    try {
        const order = await paypalClient.execute(request);
        console.log('PayPal order created:', order.result.id);
        res.json({ orderId: order.result.id });
    } catch (error) {
        console.error('PayPal order creation error:', error);
        res.status(500).json({ error: error.message, details: error.statusCode });
    }
});

app.post('/api/capture-paypal-order', async (req, res) => {
    const { orderId, email, password } = req.body;
    
    console.log('Capturing PayPal order:', orderId);
    
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    
    try {
        const capture = await paypalClient.execute(request);
        console.log('PayPal capture status:', capture.result.status);
        
        if (capture.result.status === 'COMPLETED') {
            const customData = JSON.parse(capture.result.purchase_units[0].payments.captures[0].custom_id);
            const { package, billingCycle, features } = customData;
            
            const hash = await bcrypt.hash(password, 10);
            const postsMap = { 'starter': 30, 'growth': 75, 'professional': 999999, 'custom': features?.posts || 50 };
            
            const result = await pool.query(
                `INSERT INTO users (
                    email, password_hash, package, billing_cycle, posts_remaining, 
                    platforms, paypal_order_id, status, is_active
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
                [
                    email, hash, package, billingCycle, postsMap[package] || 50, 
                    getPlatforms(package, features), orderId, 'active', true
                ]
            );
            
            await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, 
                ['purchase', { email, package, amount: capture.result.purchase_units[0].payments.captures[0].amount.value, method: 'paypal' }]);
            
            console.log('User created successfully:', email);
            res.json({ success: true, userId: result.rows[0].id });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (error) {
        console.error('PayPal capture error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    if (event.type === 'payment_intent.succeeded') {
        const payment = event.data.object;
        const { package, billingCycle, customer_email, posts_limit } = payment.metadata;
        
        const tempPass = Math.random().toString(36).slice(-8);
        const hash = await bcrypt.hash(tempPass, 10);
        
        try {
            await pool.query(
                `INSERT INTO users (
                    email, password_hash, package, billing_cycle, posts_remaining, 
                    platforms, stripe_customer_id, status, is_active
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    customer_email, hash, package, billingCycle, parseInt(posts_limit), 
                    getPlatforms(package), payment.customer, 'active', true
                ]
            );
            console.log(`New user: ${customer_email}, Password: ${tempPass}`);
            
            await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, 
                ['purchase', { email: customer_email, package, method: 'stripe' }]);
        } catch (e) {
            console.error(e);
        }
    }
    res.json({received: true});
});

function getPlatforms(pkg, features = null) {
    const map = {
        'starter': ['instagram', 'facebook', 'twitter'],
        'growth': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube'],
        'professional': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube', 'pinterest', 'threads'],
        'custom': features?.platforms ? 
            ['instagram', 'facebook', 'twitter'].slice(0, features.platforms) : 
            ['instagram', 'facebook', 'twitter']
    };
    return map[pkg] || map['starter'];
}

// ==================== USER DASHBOARD ====================
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query(
            `SELECT id, email, package, posts_remaining, posts_used, posts_published, 
                    platforms, created_at, business_name, features, status
             FROM users WHERE id = $1`, 
            [req.user.userId]
        );
        const posts = await pool.query(
            'SELECT * FROM scheduled_posts WHERE user_id = $1 ORDER BY scheduled_time DESC', 
            [req.user.userId]
        );
        const accounts = await pool.query(
            'SELECT * FROM social_accounts WHERE user_id = $1 AND is_active = true', 
            [req.user.userId]
        );
        
        res.json({ 
            profile: {
                ...user.rows[0],
                email: user.rows[0].email,
                package: user.rows[0].package,
                posts_remaining: user.rows[0].posts_remaining,
                posts_used: user.rows[0].posts_used
            }, 
            posts: posts.rows, 
            accounts: accounts.rows 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/connect-account', authenticateToken, async (req, res) => {
    const { platform, accountUsername, profileUrl } = req.body;
    try {
        await pool.query(
            `INSERT INTO social_accounts (user_id, platform, account_username, profile_url, access_token, is_active)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, platform) DO UPDATE SET 
                account_username = $3, 
                profile_url = $4,
                access_token = $5, 
                is_active = $6,
                connected_at = NOW()`,
            [req.user.userId, platform, accountUsername, profileUrl, 'connected_' + Date.now(), true]
        );
        res.json({ success: true, message: `${platform} connected` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== AI CONTENT GENERATION ====================
app.post('/api/generate-content', authenticateToken, async (req, res) => {
    const { topic, platforms, tone = 'professional' } = req.body;
    
    const templates = {
        professional: [
            `Excited to share insights about ${topic}! 🚀 What are your thoughts? #${topic.replace(/\s+/g, '')}`,
            `Just published new content about ${topic}. Check it out! 👆 #BusinessGrowth`,
            `${topic} is changing the game. Here's what you need to know... 💡`
        ],
        casual: [
            `Obsessed with ${topic} right now! 🔥 Who else?`,
            `Quick tip about ${topic}... thank me later 😎`,
            `Can we talk about ${topic}? 👀`
        ],
        promotional: [
            `🚨 Limited time: Master ${topic} with our proven system! Link in bio 👆`,
            `Stop struggling with ${topic}. We found the solution 🎯`,
            `Double your ${topic} results in 30 days. Guaranteed. 💪`
        ]
    };
    
    const selected = templates[tone] || templates.professional;
    const content = selected[Math.floor(Math.random() * selected.length)];
    
    try {
        await pool.query(
            `INSERT INTO ai_generated_content (user_id, topic, content, platforms) VALUES ($1, $2, $3, $4)`,
            [req.user.userId, topic, content, platforms]
        );
    } catch (e) {
        console.error(e);
    }
    
    res.json({ 
        success: true, 
        content,
        hashtags: [`#${topic.replace(/\s+/g, '')}`, '#Trending', '#Business'],
        bestTimes: ['9:00 AM', '12:00 PM', '6:00 PM']
    });
});

// ==================== POST SCHEDULING & AUTO-PUBLISHING ====================
app.post('/api/schedule-post', authenticateToken, async (req, res) => {
    const { content, platforms, mediaUrls, scheduledTime } = req.body;
    
    try {
        const user = await pool.query('SELECT posts_remaining FROM users WHERE id = $1', [req.user.userId]);
        
        if (user.rows[0].posts_remaining <= 0) {
            return res.status(403).json({ error: 'Post limit reached. Upgrade your package.' });
        }
        
        const result = await pool.query(
            `INSERT INTO scheduled_posts (user_id, content, platforms, media_urls, scheduled_time)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.user.userId, content, platforms, mediaUrls || [], scheduledTime]
        );
        
        await pool.query(
            'UPDATE users SET posts_remaining = posts_remaining - 1, posts_used = posts_used + 1 WHERE id = $1',
            [req.user.userId]
        );
        
        res.json({ success: true, postId: result.rows[0].id, message: 'Post scheduled! Will auto-publish.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== AUTO-PUBLISH CRON JOB ====================
cron.schedule('*/5 * * * *', async () => {
    console.log('🤖 Auto-publishing posts...');
    
    try {
        const pending = await pool.query(`
            SELECT sp.*, u.email, u.package 
            FROM scheduled_posts sp
            JOIN users u ON sp.user_id = u.id
            WHERE sp.status = 'pending' 
            AND sp.scheduled_time <= NOW()
            AND u.is_active = true
            AND u.status = 'active'
        `);
        
        for (const post of pending.rows) {
            try {
                const accounts = await pool.query(
                    'SELECT platform FROM social_accounts WHERE user_id = $1 AND is_active = true',
                    [post.user_id]
                );
                
                const connectedPlatforms = accounts.rows.map(a => a.platform);
                const postPlatforms = post.platforms.filter(p => connectedPlatforms.includes(p));
                
                if (postPlatforms.length === 0) {
                    console.log(`No connected accounts for post ${post.id}`);
                    continue;
                }
                
                console.log(`📤 Publishing to ${postPlatforms.join(', ')} for user ${post.user_id}`);
                
                await pool.query(
                    'UPDATE scheduled_posts SET status = $1, published_at = NOW() WHERE id = $2',
                    ['published', post.id]
                );
                
                await pool.query(
                    'UPDATE users SET posts_published = posts_published + 1 WHERE id = $1',
                    [post.user_id]
                );
                
                console.log(`✅ Published post ${post.id}`);
                
            } catch (err) {
                await pool.query('UPDATE scheduled_posts SET status = $1 WHERE id = $2', ['failed', post.id]);
                console.error(`❌ Failed post ${post.id}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Cron error:', error);
    }
});

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_users,
