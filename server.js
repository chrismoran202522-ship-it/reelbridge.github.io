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

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 20,
    keepAlive: true
});

// PayPal setup
const Environment = process.env.NODE_ENV === 'production' 
    ? paypal.core.LiveEnvironment 
    : paypal.core.SandboxEnvironment;

const paypalEnvironment = new Environment(
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET
);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnvironment);

// CORS configuration
app.use(cors({ 
    origin: [
        'https://reelbridge.pages.dev',
        'https://reelbridge.site',
        'https://www.reelbridge.site',
        'http://localhost:3000',
        'http://localhost:5500'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());

// JWT middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Admin middleware
const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// ==================== DATABASE SCHEMA UPDATES ====================
async function runSchemaUpdates() {
    const client = await pool.connect();
    try {
        console.log('🔧 Running database schema updates...');
        
        const checkColumn = async (table, column) => {
            const result = await client.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = $1 AND column_name = $2
            `, [table, column]);
            return result.rows.length > 0;
        };
        
        // Users table columns
        const userColumnsToAdd = [
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
            { name: 'features', type: 'JSONB DEFAULT \'{}\'' },
            { name: 'language', type: 'VARCHAR(10) DEFAULT \'en\'' },
            { name: 'admin_notes', type: 'TEXT' }
        ];
        
        for (const col of userColumnsToAdd) {
            const exists = await checkColumn('users', col.name);
            if (!exists) {
                await client.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
                console.log(`✅ Added column: ${col.name}`);
            }
        }
        
        // Scheduled posts columns for enhanced features
        const postColumns = [
            { name: 'industry', type: 'VARCHAR(50)' },
            { name: 'post_type', type: 'VARCHAR(50)' },
            { name: 'tone', type: 'VARCHAR(20) DEFAULT \'professional\'' },
            { name: 'target_audience', type: 'VARCHAR(100)' },
            { name: 'call_to_action', type: 'VARCHAR(100)' },
            { name: 'is_recurring', type: 'BOOLEAN DEFAULT false' },
            { name: 'recurrence_pattern', type: 'VARCHAR(50)' },
            { name: 'recurrence_end_date', type: 'TIMESTAMP' },
            { name: 'parent_post_id', type: 'INTEGER REFERENCES scheduled_posts(id)' },
            { name: 'platforms_data', type: 'JSONB DEFAULT \'{}\'' },
            { name: 'is_recalled', type: 'BOOLEAN DEFAULT false' },
            { name: 'recalled_at', type: 'TIMESTAMP' },
            { name: 'recall_reason', type: 'TEXT' },
            { name: 'updated_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
        ];
        
        for (const col of postColumns) {
            const exists = await checkColumn('scheduled_posts', col.name);
            if (!exists) {
                await client.query(`ALTER TABLE scheduled_posts ADD COLUMN ${col.name} ${col.type}`);
                console.log(`✅ Added column: ${col.name}`);
            }
        }
        
        // Create messages table
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                subject VARCHAR(255),
                content TEXT NOT NULL,
                is_read BOOLEAN DEFAULT false,
                parent_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create media uploads table
        await client.query(`
            CREATE TABLE IF NOT EXISTS media_uploads (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                filename VARCHAR(255),
                file_url TEXT,
                file_type VARCHAR(50),
                file_size INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create post instances table for recurring posts
        await client.query(`
            CREATE TABLE IF NOT EXISTS post_instances (
                id SERIAL PRIMARY KEY,
                parent_post_id INTEGER REFERENCES scheduled_posts(id) ON DELETE CASCADE,
                scheduled_time TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                published_at TIMESTAMP,
                is_recalled BOOLEAN DEFAULT false
            )
        `);
        
        // Update status constraint
        try {
            await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check`);
            await client.query(`ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('pending', 'active', 'suspended', 'cancelled'))`);
        } catch (e) {
            // Constraint may already exist
        }
        
        console.log('✅ Schema updates complete');
    } catch (error) {
        console.error('❌ Schema update error:', error);
    } finally {
        client.release();
    }
}

// ==================== DATABASE INITIALIZATION ====================
async function initDatabase() {
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
                platform_limit INTEGER DEFAULT 3,
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
                features JSONB DEFAULT '{}',
                language VARCHAR(10) DEFAULT 'en',
                admin_notes TEXT
            );
            
            CREATE TABLE IF NOT EXISTS scheduled_posts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                platforms TEXT[] NOT NULL,
                platforms_data JSONB DEFAULT '{}',
                media_urls TEXT[],
                media_ids INTEGER[],
                scheduled_time TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                published_at TIMESTAMP,
                engagement_stats JSONB,
                industry VARCHAR(50),
                post_type VARCHAR(50),
                tone VARCHAR(20) DEFAULT 'professional',
                target_audience VARCHAR(100),
                call_to_action VARCHAR(100),
                is_recurring BOOLEAN DEFAULT false,
                recurrence_pattern VARCHAR(50),
                recurrence_end_date TIMESTAMP,
                parent_post_id INTEGER REFERENCES scheduled_posts(id),
                is_recalled BOOLEAN DEFAULT false,
                recalled_at TIMESTAMP,
                recall_reason TEXT
            );
            
            CREATE TABLE IF NOT EXISTS social_accounts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                platform VARCHAR(50) NOT NULL,
                account_username VARCHAR(255),
                profile_url TEXT,
                access_token TEXT,
                refresh_token TEXT,
                page_id VARCHAR(255),
                page_name VARCHAR(255),
                is_active BOOLEAN DEFAULT true,
                connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, platform)
            );
            
            CREATE TABLE IF NOT EXISTS ai_generated_content (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                topic VARCHAR(255),
                content TEXT,
                platforms TEXT[],
                industry VARCHAR(50),
                post_type VARCHAR(50),
                tone VARCHAR(20),
                target_audience VARCHAR(100),
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
                platforms_limit INTEGER DEFAULT 3,
                features JSONB DEFAULT '{}',
                is_active BOOLEAN DEFAULT true,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Create default admin if none exists
        const admin = await client.query('SELECT * FROM users WHERE role = $1', ['admin']);
        if (admin.rows.length === 0) {
            const hash = await bcrypt.hash('AdminTemp123!', 10);
            await client.query(
                `INSERT INTO users (email, password_hash, role, force_password_change, is_active, status, business_name, contact_name, phone, platform_limit, posts_remaining) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                ['admin@reelbridge.site', hash, 'admin', true, true, 'active', 'ReelBridge Admin', 'Admin User', '555-0000', 99, 999999]
            );
            console.log('✅ Default admin created: admin@reelbridge.site / AdminTemp123!');
        }
        
        // Create default packages if none exist
        const packages = await client.query('SELECT * FROM package_config');
        if (packages.rows.length === 0) {
            await client.query(`
                INSERT INTO package_config (package_name, price_monthly, posts_limit, platforms_limit, features) VALUES
                ('starter', 254, 30, 3, '{"ai_content": true, "basic_analytics": true, "basic_dashboard": true}'),
                ('growth', 509, 75, 6, '{"ai_content": true, "ai_video": true, "auto_engagement": true, "priority_support": true, "basic_dashboard": true, "analytics_advanced": true}'),
                ('professional', 849, 999999, 16, '{"ai_content": true, "ai_video": true, "ai_image": true, "dedicated_manager": true, "unlimited": true, "basic_dashboard": true, "analytics_advanced": true, "content_scheduler": true}'),
                ('custom', 99, 50, 3, '{"base": true, "basic_dashboard": true}')
            `);
            console.log('✅ Default packages created');
        }
        
        console.log('✅ Database ready');
    } finally {
        client.release();
    }
}

// ==================== AUTHENTICATION ROUTES ====================

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    try {
        const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
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
                forcePasswordChange: user.force_password_change, 
                language: user.language 
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
                platformLimit: user.platform_limit,
                forcePasswordChange: user.force_password_change,
                features: user.features,
                language: user.language
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/change-password', authenticateToken, async (req, res) => {
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    try {
        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, force_password_change = false WHERE id = $2', 
            [hash, req.user.userId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/update-language', authenticateToken, async (req, res) => {
    const { language } = req.body;
    
    try {
        await pool.query('UPDATE users SET language = $1 WHERE id = $2', [language, req.user.userId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Update language error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== USER REGISTRATION ====================

app.post('/api/register', async (req, res) => {
    const { 
        email, password, businessName, contactName, phone, website, 
        industry, address, taxId, referral, marketingConsent, language 
    } = req.body;

    if (!email || !password || !businessName || !contactName || !phone || !industry) {
        return res.status(400).json({ error: 'Required fields missing' });
    }

    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
        const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hash = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            `INSERT INTO users (
                email, password_hash, role, package, status, business_name, contact_name, 
                phone, website, industry, address_street, address_city, address_state, 
                address_zip, address_country, tax_id, referral_source, marketing_consent, 
                posts_remaining, posts_used, posts_published, features, is_active, 
                force_password_change, language, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW()) 
            RETURNING id`,
            [
                email.toLowerCase(), hash, 'customer', 'starter', 'pending', 
                businessName, contactName, phone, website, industry, 
                address?.street, address?.city, address?.state, address?.zip, address?.country || 'US',
                taxId, referral, marketingConsent || false, 0, 0, 0, 
                JSON.stringify({ basic_dashboard: true }), false, false, 
                language || 'en'
            ]
        );

        await pool.query(
            `INSERT INTO admin_logs (action, user_id, details) VALUES ($1, $2, $3)`,
            ['user_registered', result.rows[0].id, { email, businessName, industry }]
        );

        res.status(201).json({ 
            success: true, 
            message: 'Account created. Please wait for admin approval.',
            userId: result.rows[0].id 
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== PACKAGES ====================

app.get('/api/packages', async (req, res) => {
    try {
        const packages = await pool.query(
            'SELECT * FROM package_config WHERE is_active = true ORDER BY price_monthly'
        );
        res.json(packages.rows);
    } catch (error) {
        console.error('Packages error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== PAYMENT ROUTES ====================

app.post('/api/create-stripe-intent', async (req, res) => {
    const { package, amount, email, billingCycle, features } = req.body;
    
    const postsMap = { starter: 30, growth: 75, professional: 999999, custom: features?.posts || 50 };
    const platformMap = { starter: 3, growth: 6, professional: 16, custom: features?.platforms || 3 };
    
    try {
        const intent = await stripe.paymentIntents.create({
            amount: amount * 100,
            currency: 'usd',
            receipt_email: email,
            metadata: { 
                package, 
                billingCycle, 
                customer_email: email, 
                posts_limit: postsMap[package] || 50, 
                platform_limit: platformMap[package] || 3 
            }
        });
        res.json({ clientSecret: intent.client_secret });
    } catch (error) {
        console.error('Stripe intent error:', error);
        res.status(500).json({ error: 'Payment setup failed' });
    }
});

app.post('/api/create-paypal-order', async (req, res) => {
    const { package, amount, billingCycle, features } = req.body;
    
    const request = new paypal.orders.OrdersCreateRequest();
    request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
            amount: { currency_code: 'USD', value: amount.toString() },
            description: `Reel Bridge ${package}`,
            custom_id: JSON.stringify({ package, billingCycle, features })
        }]
    });
    
    try {
        const order = await paypalClient.execute(request);
        res.json({ orderId: order.result.id });
    } catch (error) {
        console.error('PayPal order error:', error);
        res.status(500).json({ error: 'Payment setup failed' });
    }
});

app.post('/api/capture-paypal-order', async (req, res) => {
    const { orderId, email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    
    try {
        const capture = await paypalClient.execute(request);
        
        if (capture.result.status === 'COMPLETED') {
            const customData = JSON.parse(capture.result.purchase_units[0].payments.captures[0].custom_id || '{}');
            const { package, billingCycle, features } = customData;
            
            const hash = await bcrypt.hash(password, 10);
            const postsMap = { starter: 30, growth: 75, professional: 999999, custom: features?.posts || 50 };
            const platformMap = { starter: 3, growth: 6, professional: 16, custom: features?.platforms || 3 };
            
            const result = await pool.query(
                `INSERT INTO users (
                    email, password_hash, package, billing_cycle, posts_remaining, 
                    platform_limit, platforms, paypal_order_id, status, is_active,
                    business_name, contact_name
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
                RETURNING id`,
                [
                    email.toLowerCase(), hash, package, billingCycle, 
                    postsMap[package] || 50, platformMap[package] || 3, 
                    getPlatforms(package, features), orderId, 'active', true,
                    email.split('@')[0], email.split('@')[0]
                ]
            );
            
            await pool.query(
                `INSERT INTO admin_logs (action, details) VALUES ($1, $2)`,
                ['purchase', { 
                    email, 
                    package, 
                    amount: capture.result.purchase_units[0].payments.captures[0].amount.value, 
                    method: 'paypal' 
                }]
            );
            
            res.json({ success: true, userId: result.rows[0].id });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (error) {
        console.error('PayPal capture error:', error);
        res.status(500).json({ error: 'Payment processing failed' });
    }
});

// Stripe webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    if (event.type === 'payment_intent.succeeded') {
        const payment = event.data.object;
        const { 
            package, billingCycle, customer_email, posts_limit, platform_limit 
        } = payment.metadata;
        
        const tempPass = Math.random().toString(36).slice(-10);
        const hash = await bcrypt.hash(tempPass, 10);
        
        try {
            await pool.query(
                `INSERT INTO users (
                    email, password_hash, package, billing_cycle, posts_remaining, 
                    platform_limit, platforms, stripe_customer_id, status, is_active,
                    force_password_change, business_name, contact_name
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                    customer_email.toLowerCase(), hash, package, billingCycle, 
                    parseInt(posts_limit), parseInt(platform_limit) || 3, 
                    getPlatforms(package), payment.customer, 'active', true, true,
                    customer_email.split('@')[0], customer_email.split('@')[0]
                ]
            );
            
            await pool.query(
                `INSERT INTO admin_logs (action, details) VALUES ($1, $2)`,
                ['purchase', { email: customer_email, package, method: 'stripe' }]
            );
            
            // TODO: Send email with temporary password
            console.log(`New user created: ${customer_email}, temp pass: ${tempPass}`);
        } catch (e) {
            console.error('Webhook user creation error:', e);
        }
    }
    res.json({ received: true });
});

function getPlatforms(pkg, features = null) {
    const map = {
        starter: ['instagram', 'facebook', 'twitter'],
        growth: ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube'],
        professional: ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube', 'pinterest', 'threads', 'snapchat', 'twitch', 'reddit', 'tumblr', 'medium', 'yelp', 'google_business', 'whatsapp'],
        custom: features?.platforms ? 
            ['instagram', 'facebook', 'twitter', 'tiktok', 'linkedin', 'youtube', 'pinterest', 'threads', 'snapchat', 'twitch'].slice(0, features.platforms) : 
            ['instagram', 'facebook', 'twitter']
    };
    return map[pkg] || map.starter;
}

// ==================== AI CONTENT GENERATION ====================

async function generateWithAI(params) {
    const { topic, industry, postType, tone, targetAudience, callToAction, includeHashtags, includeEmoji } = params;
    
    if (!process.env.OPENAI_API_KEY) {
        return null;
    }
    
    try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        
        const industryNames = {
            automotive: 'automotive/car dealership',
            realestate: 'real estate',
            medical: 'medical/healthcare',
            restaurant: 'restaurant/food service',
            fitness: 'fitness/gym',
            legal: 'legal services',
            salon: 'beauty/salon',
            retail: 'retail/fashion',
            technology: 'technology/software',
            general: 'general business'
        };
        
        const systemPrompt = `You are a professional social media content creator specializing in ${industryNames[industry] || 'business'} content.
Create engaging, platform-appropriate social media posts.
Tone: ${tone}
Post type: ${postType}
${targetAudience ? `Target audience: ${targetAudience}` : ''}
${callToAction ? `Include call to action: ${callToAction}` : ''}
${includeEmoji ? 'Use appropriate emojis.' : 'No emojis.'}
${includeHashtags ? 'Include relevant hashtags at the end.' : 'No hashtags.'}
Provide exactly 3 variations of the post, numbered 1-2-3.`;

        const userPrompt = `Create a social media post about: ${topic}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.8,
            max_tokens: 800
        });

        const content = completion.choices[0].message.content;
        const variations = content.split(/\d+[\.\)]\s*/).filter(v => v.trim().length > 20).slice(0, 3);
        
        return {
            content: variations[0] || content,
            variations: variations.length >= 3 ? variations : [content, content, content]
        };
    } catch (error) {
        console.error('OpenAI generation failed:', error);
        return null;
    }
}

app.post('/api/generate-content', authenticateToken, async (req, res) => {
    const { 
        topic, platforms, industry = 'general', postType = 'promotional',
        tone = 'professional', targetAudience = '', callToAction = '',
        includeHashtags = true, includeEmoji = true
    } = req.body;
    
    // Try real AI first
    const aiResult = await generateWithAI({
        topic, industry, postType, tone, targetAudience, callToAction, includeHashtags, includeEmoji
    });
    
    if (aiResult) {
        try {
            await pool.query(
                `INSERT INTO ai_generated_content 
                (user_id, topic, content, platforms, industry, post_type, tone, target_audience) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [req.user.userId, topic, aiResult.content, platforms, industry, postType, tone, targetAudience]
            );
        } catch (e) {
            console.error('Save AI content error:', e);
        }
        
        return res.json({
            success: true,
            content: aiResult.content,
            variations: aiResult.variations,
            source: 'ai',
            industry,
            postType,
            tone
        });
    }
    
    // Fallback to templates
    const industryTemplates = {
        automotive: {
            promotional: [
                "🚗 Ready to upgrade? {topic}! Check out our latest inventory with unbeatable prices. Limited time offers available! 🏃‍♂️💨",
                "💰 Trade-in special! {topic}. Get top dollar for your vehicle and drive away in your dream car today!",
                "🎉 Flash Sale Alert! {topic}. Don't miss out - these deals won't last long! Visit us or call now."
            ],
            educational: [
                "🚗 Did you know? {topic}. Understanding your vehicle better helps you make informed decisions.",
                "⚙️ Maintenance Monday: {topic}. Regular upkeep saves you money long-term. Schedule your service today!",
                "🔧 Pro Tip: {topic}. Our certified technicians are here to help with all your automotive needs."
            ],
            engagement: [
                "📸 Show us your ride! {topic}. Drop a photo in the comments - we love seeing our community's vehicles!",
                "🤔 What's your dream car? {topic}. Tell us in the comments! 👇",
                "🏆 Customer spotlight: {topic}. We love hearing from happy customers! Share your experience with us."
            ],
            seasonal: [
                "❄️ Winter is coming! {topic}. Make sure your vehicle is ready for the cold months ahead.",
                "☀️ Summer road trip ready? {topic}. Get your vehicle checked before you hit the road!"
            ],
            trust: [
                "🎓 Meet our certified technicians: {topic}. Expert care for your vehicle every time.",
                "🏆 Award-winning service: {topic}. Trusted by thousands of happy customers!"
            ]
        },
        realestate: {
            promotional: [
                "🔥 Just Listed! {topic}. This stunning property won't last long - schedule your showing today!",
                "💎 Price Improvement! {topic}. Now's your chance to own this incredible property at an unbeatable value!",
                "🏡 Open House This Weekend! {topic}. Join us Saturday & Sunday 1-4 PM. Don't miss it!"
            ],
            educational: [
                "🏠 Market insight: {topic}. Stay informed to make the best real estate decisions.",
                "📊 Did you know? {topic}. Understanding the market helps buyers and sellers alike.",
                "💡 First-time buyer tip: {topic}. We're here to guide you through every step!"
            ],
            engagement: [
                "🎯 Guess the price! {topic}. Drop your guess in the comments! Closest without going over wins!",
                "📸 Home goals! {topic}. Which feature is your must-have? Let us know! 👇",
                "🏆 Sold! Congratulations to our clients! {topic}. Another happy homeowner!"
            ],
            seasonal: [
                "🌸 Spring market is heating up! {topic}. Now is the perfect time to buy or sell!",
                "🏠 New Year, New Home? {topic}. Start 2026 in your dream property!"
            ],
            trust: [
                "🎓 Meet our agents: {topic}. Local experts with proven results.",
                "⭐ 5-Star Review: {topic}. See why clients love working with us!"
            ]
        },
        medical: {
            promotional: [
                "📅 Now accepting new patients! {topic}. Experience compassionate, quality care close to home.",
                "🎉 Special offer: {topic}. Limited time wellness packages available - invest in your health!",
                "🏥 Expanded services! {topic}. We're growing to better serve our community's health needs."
            ],
            educational: [
                "💙 Health Tip: {topic}. Small changes make a big difference in your wellness journey.",
                "🩺 Did you know? {topic}. Stay informed about your health - knowledge is power!",
                "⚕️ Prevention is key: {topic}. Regular check-ups help catch issues early."
            ],
            engagement: [
                "❓ Health Q&A: {topic}. Drop your questions below - our experts will answer! 👇",
                "💪 Wellness Wednesday: {topic}. Share your healthy habits in the comments!",
                "🌟 Patient success story: {topic}. Real results, real people!"
            ],
            trust: [
                "🎓 Meet Dr. [Name]: {topic}. Our team brings expertise and compassion to every patient interaction.",
                "🏆 Award-winning care: {topic}. Recognized for excellence in patient satisfaction!"
            ],
            seasonal: [
                "🍂 Flu season prep: {topic}. Protect yourself and your family this season.",
                "☀️ Summer health tips: {topic}. Stay healthy and active all summer long!"
            ]
        },
        restaurant: {
            promotional: [
                "🍽️ Tonight's special: {topic}! Join us for an unforgettable dining experience. Reservations recommended!",
                "🎉 Happy Hour 4-7 PM! {topic}. Great drinks, great prices, great vibes!",
                "🍰 Weekend brunch is back! {topic}. Bottomless mimosas and mouthwatering dishes await!"
            ],
            educational: [
                "👨‍🍳 Chef's secret: {topic}. Learn what makes

