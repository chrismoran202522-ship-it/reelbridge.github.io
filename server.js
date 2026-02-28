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

// PayPal setup
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
        
        const checkColumn = async (table, column) => {
            const result = await client.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = $1 AND column_name = $2
            `, [table, column]);
            return result.rows.length > 0;
        };
        
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
            { name: 'features', type: 'JSONB DEFAULT \'{}\'' },
            { name: 'language', type: 'VARCHAR(10) DEFAULT \'en\'' }
        ];
        
        for (const col of columnsToAdd) {
            const exists = await checkColumn('users', col.name);
            if (!exists) {
                await client.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
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
        
        try {
            await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check`);
            await client.query(`ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('pending', 'active', 'suspended', 'cancelled'))`);
        } catch (e) {}
        
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
                language VARCHAR(10) DEFAULT 'en'
            );
            
            CREATE TABLE IF NOT EXISTS scheduled_posts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                platforms TEXT[] NOT NULL,
                media_urls TEXT[],
                media_ids INTEGER[],
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
        
        const admin = await client.query('SELECT * FROM users WHERE role = $1', ['admin']);
        if (admin.rows.length === 0) {
            const hash = await bcrypt.hash('123456', 10);
            await client.query(
                `INSERT INTO users (email, password_hash, role, force_password_change, is_active, status, business_name, contact_name, phone, platform_limit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                ['cmoran@reelbridge.site', hash, 'admin', true, true, 'active', 'ReelBridge Admin', 'Admin User', '506-271-7605', 99]
            );
            console.log('✅ Admin created');
        }
        
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
        // Case-insensitive email lookup
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
            { userId: user.id, email: user.email, role: user.role, package: user.package, forcePasswordChange: user.force_password_change, language: user.language },
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

app.post('/api/update-language', authenticateToken, async (req, res) => {
    const { language } = req.body;
    try {
        await pool.query('UPDATE users SET language = $1 WHERE id = $2', [language, req.user.userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== USER REGISTRATION ====================
app.post('/api/register', async (req, res) => {
    const { email, password, businessName, contactName, phone, website, industry, address, taxId, referral, marketingConsent, language } = req.body;

    try {
        const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hash = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, role, package, status, business_name, contact_name, phone, website, industry, address_street, address_city, address_state, address_zip, address_country, tax_id, referral_source, marketing_consent, posts_remaining, posts_used, posts_published, features, is_active, force_password_change, language, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW()) RETURNING id`,
            [email.toLowerCase(), hash, 'customer', 'starter', 'pending', businessName, contactName, phone, website, industry, address.street, address.city, address.state, address.zip, address.country, taxId, referral, marketingConsent, 0, 0, 0, JSON.stringify({ basic_dashboard: true }), false, false, language || 'en']
        );

        await pool.query(`INSERT INTO admin_logs (action, user_id, details) VALUES ($1, $2, $3)`, ['user_registered', result.rows[0].id, { email, businessName, industry }]);

        res.status(201).json({ success: true, message: 'Account created. Please wait for admin approval.', userId: result.rows[0].id });
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
    const platformMap = { 'starter': 3, 'growth': 6, 'professional': 10, 'custom': features?.platforms || 3 };
    
    try {
        const intent = await stripe.paymentIntents.create({
            amount: amount * 100,
            currency: 'usd',
            receipt_email: email,
            metadata: { package, billingCycle, customer_email: email, posts_limit: postsMap[package] || 50, platform_limit: platformMap[package] || 3 }
        });
        res.json({ clientSecret: intent.client_secret });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/capture-paypal-order', async (req, res) => {
    const { orderId, email, password } = req.body;
    
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    
    try {
        const capture = await paypalClient.execute(request);
        
        if (capture.result.status === 'COMPLETED') {
            const customData = JSON.parse(capture.result.purchase_units[0].payments.captures[0].custom_id);
            const { package, billingCycle, features } = customData;
            
            const hash = await bcrypt.hash(password, 10);
            const postsMap = { 'starter': 30, 'growth': 75, 'professional': 999999, 'custom': features?.posts || 50 };
            const platformMap = { 'starter': 3, 'growth': 6, 'professional': 10, 'custom': features?.platforms || 3 };
            
            const result = await pool.query(
                `INSERT INTO users (email, password_hash, package, billing_cycle, posts_remaining, platform_limit, platforms, paypal_order_id, status, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
                [email.toLowerCase(), hash, package, billingCycle, postsMap[package] || 50, platformMap[package] || 3, getPlatforms(package, features), orderId, 'active', true]
            );
            
            await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, ['purchase', { email, package, amount: capture.result.purchase_units[0].payments.captures[0].amount.value, method: 'paypal' }]);
            
            res.json({ success: true, userId: result.rows[0].id });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (error) {
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
        const { package, billingCycle, customer_email, posts_limit, platform_limit } = payment.metadata;
        
        const tempPass = Math.random().toString(36).slice(-8);
        const hash = await bcrypt.hash(tempPass, 10);
        
        try {
            await pool.query(
                `INSERT INTO users (email, password_hash, package, billing_cycle, posts_remaining, platform_limit, platforms, stripe_customer_id, status, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [customer_email.toLowerCase(), hash, package, billingCycle, parseInt(posts_limit), parseInt(platform_limit) || 3, getPlatforms(package), payment.customer, 'active', true]
            );
            
            await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, ['purchase', { email: customer_email, package, method: 'stripe' }]);
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
        'professional': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube', 'pinterest', 'threads', 'snapchat', 'twitch'],
        'custom': features?.platforms ? ['instagram', 'facebook', 'twitter', 'tiktok', 'linkedin', 'youtube', 'pinterest', 'threads', 'snapchat', 'twitch'].slice(0, features.platforms) : ['instagram', 'facebook', 'twitter']
    };
    return map[pkg] || map['starter'];
}

// ==================== USER DASHBOARD ====================
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query(`SELECT id, email, package, posts_remaining, posts_used, posts_published, platforms, platform_limit, created_at, business_name, contact_name, phone, features, status, language FROM users WHERE id = $1`, [req.user.userId]);
        const posts = await pool.query('SELECT * FROM scheduled_posts WHERE user_id = $1 ORDER BY scheduled_time DESC', [req.user.userId]);
        const accounts = await pool.query('SELECT * FROM social_accounts WHERE user_id = $1 AND is_active = true', [req.user.userId]);
        const unreadMessages = await pool.query('SELECT COUNT(*) FROM messages WHERE recipient_id = $1 AND is_read = false', [req.user.userId]);
        
        res.json({ 
            profile: user.rows[0], 
            posts: posts.rows, 
            accounts: accounts.rows,
            unreadMessages: parseInt(unreadMessages.rows[0].count)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== SOCIAL MEDIA OAUTH ====================
app.get('/api/oauth/:platform/url', authenticateToken, async (req, res) => {
    const { platform } = req.params;
    const userId = req.user.userId;
    
    const oauthUrls = {
        instagram: `https://api.instagram.com/oauth/authorize?client_id=${process.env.INSTAGRAM_CLIENT_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/instagram&scope=user_profile,user_media&response_type=code&state=${userId}`,
        facebook: `https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.FACEBOOK_APP_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/facebook&scope=pages_manage_posts,pages_read_engagement&state=${userId}`,
        twitter: `https://twitter.com/i/oauth2/authorize?client_id=${process.env.TWITTER_CLIENT_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/twitter&scope=tweet.read tweet.write users.read&response_type=code&state=${userId}&code_challenge=challenge&code_challenge_method=plain`,
        linkedin: `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/linkedin&scope=r_liteprofile r_basicprofile w_member_social&state=${userId}`,
        youtube: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/youtube&scope=https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly&response_type=code&state=${userId}&access_type=offline`,
        tiktok: `https://www.tiktok.com/auth/authorize?client_key=${process.env.TIKTOK_CLIENT_KEY}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/tiktok&scope=user.info.basic,video.upload&response_type=code&state=${userId}`,
        pinterest: `https://www.pinterest.com/oauth/?client_id=${process.env.PINTEREST_APP_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/pinterest&scope=boards:read,pins:read,pins:write&response_type=code&state=${userId}`,
        threads: `https://threads.net/oauth/authorize?client_id=${process.env.THREADS_APP_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/threads&scope=threads_basic,threads_content_publish&response_type=code&state=${userId}`,
        snapchat: `https://accounts.snapchat.com/accounts/oauth2/authorize?client_id=${process.env.SNAPCHAT_CLIENT_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/snapchat&scope=snapchat-marketing-api&response_type=code&state=${userId}`,
        twitch: `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/twitch&scope=channel:manage:broadcast user:read:email&response_type=code&state=${userId}`
    };
    
    res.json({ url: oauthUrls[platform] || null });
});

app.post('/api/oauth/:platform/callback', async (req, res) => {
    const { platform } = req.params;
    const { code, state: userId } = req.body;
    
    try {
        // Exchange code for access token (implementation varies by platform)
        const tokenResponse = await exchangeCodeForToken(platform, code);
        
        // Get account info
        const accountInfo = await getAccountInfo(platform, tokenResponse.access_token);
        
        // Store in database
        await pool.query(
            `INSERT INTO social_accounts (user_id, platform, account_username, profile_url, access_token, refresh_token, page_id, page_name, is_active) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (user_id, platform) DO UPDATE SET 
                account_username = $3, profile_url = $4, access_token = $5, refresh_token = $6, 
                page_id = $7, page_name = $8, is_active = true, connected_at = NOW()`,
            [userId, platform, accountInfo.username, accountInfo.profileUrl, tokenResponse.access_token, tokenResponse.refresh_token, accountInfo.pageId, accountInfo.pageName, true]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).json({ error: error.message });
    }
});

async function exchangeCodeForToken(platform, code) {
    // Platform-specific token exchange implementations
    // This is a simplified version - each platform has different requirements
    const tokenUrls = {
        instagram: 'https://api.instagram.com/oauth/access_token',
        facebook: 'https://graph.facebook.com/v18.0/oauth/access_token',
        twitter: 'https://api.twitter.com/2/oauth2/token',
        linkedin: 'https://www.linkedin.com/oauth/v2/accessToken',
        youtube: 'https://oauth2.googleapis.com/token',
        tiktok: 'https://open-api.tiktok.com/oauth/access_token/',
        pinterest: 'https://api.pinterest.com/v5/oauth/token',
        threads: 'https://graph.threads.net/oauth/access_token',
        snapchat: 'https://accounts.snapchat.com/accounts/oauth2/token',
        twitch: 'https://id.twitch.tv/oauth2/token'
    };
    
    // Implementation would use axios to make the actual token exchange
    // Return mock for now - implement per platform as needed
    return { access_token: 'mock_token_' + Date.now(), refresh_token: 'mock_refresh_' + Date.now() };
}

async function getAccountInfo(platform, accessToken) {
    // Platform-specific API calls to get account info
    return { username: 'user_' + Date.now(), profileUrl: `https://${platform}.com/user`, pageId: 'page_' + Date.now(), pageName: 'My Page' };
}

app.post('/api/connect-account', authenticateToken, async (req, res) => {
    const { platform, accountUsername, profileUrl, pageId, pageName } = req.body;
    try {
        // Check platform limit
        const user = await pool.query('SELECT platform_limit, (SELECT COUNT(*) FROM social_accounts WHERE user_id = $1 AND is_active = true) as connected_count FROM users WHERE id = $1', [req.user.userId]);
        
        if (parseInt(user.rows[0].connected_count) >= user.rows[0].platform_limit) {
            return res.status(403).json({ error: 'Platform limit reached. Upgrade your package to connect more accounts.' });
        }
        
        await pool.query(
            `INSERT INTO social_accounts (user_id, platform, account_username, profile_url, page_id, page_name, access_token, is_active) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, platform) DO UPDATE SET 
                account_username = $3, profile_url = $4, page_id = $5, page_name = $6, access_token = $7, is_active = true, connected_at = NOW()`,
            [req.user.userId, platform, accountUsername, profileUrl, pageId, pageName, 'connected_' + Date.now(), true]
        );
        res.json({ success: true, message: `${platform} connected` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== MEDIA UPLOADS ====================
app.post('/api/upload-media', authenticateToken, async (req, res) => {
    const { filename, fileData, fileType } = req.body;
    
    try {
        // In production, upload to S3 or similar storage
        // For now, store base64 or save to filesystem
        const fileUrl = `/uploads/${Date.now()}_${filename}`;
        
        const result = await pool.query(
            `INSERT INTO media_uploads (user_id, filename, file_url, file_type, file_size) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.user.userId, filename, fileUrl, fileType, Buffer.byteLength(fileData, 'base64')]
        );
        
        res.json({ success: true, mediaId: result.rows[0].id, fileUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user/media', authenticateToken, async (req, res) => {
    try {
        const media = await pool.query('SELECT * FROM media_uploads WHERE user_id = $1 ORDER BY created_at DESC', [req.user.userId]);
        res.json(media.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== AI CONTENT ====================
app.post('/api/generate-content', authenticateToken, async (req, res) => {
    const { topic, platforms, tone = 'professional' } = req.body;
    
    const templates = {
        professional: [`Excited to share insights about ${topic}! 🚀 #${topic.replace(/\s+/g, '')}`, `Just published new content about ${topic}. Check it out! 👆`, `${topic} is changing the game. Here's what you need to know... 💡`],
        casual: [`Obsessed with ${topic} right now! 🔥`, `Quick tip about ${topic}... 😎`, `Can we talk about ${topic}? 👀`],
        promotional: [`🚨 Limited time: Master ${topic}! Link in bio 👆`, `Stop struggling with ${topic}. We found the solution 🎯`, `Double your ${topic} results in 30 days. 💪`]
    };
    
    const selected = templates[tone] || templates.professional;
    const content = selected[Math.floor(Math.random() * selected.length)];
    
    try {
        await pool.query(`INSERT INTO ai_generated_content (user_id, topic, content, platforms) VALUES ($1, $2, $3, $4)`, [req.user.userId, topic, content, platforms]);
    } catch (e) {
        console.error(e);
    }
    
    res.json({ success: true, content, hashtags: [`#${topic.replace(/\s+/g, '')}`, '#Trending'], bestTimes: ['9:00 AM', '12:00 PM', '6:00 PM'] });
});

// ==================== POST SCHEDULING ====================
app.post('/api/schedule-post', authenticateToken, async (req, res) => {
    const { content, platforms, mediaUrls, mediaIds, scheduledTime } = req.body;
    
    try {
        const user = await pool.query('SELECT posts_remaining FROM users WHERE id = $1', [req.user.userId]);
        
        if (user.rows[0].posts_remaining <= 0) {
            return res.status(403).json({ error: 'Post limit reached. Upgrade your package.' });
        }
        
        const result = await pool.query(
            `INSERT INTO scheduled_posts (user_id, content, platforms, media_urls, media_ids, scheduled_time) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.user.userId, content, platforms, mediaUrls || [], mediaIds || [], scheduledTime]
        );
        
        await pool.query('UPDATE users SET posts_remaining = posts_remaining - 1, posts_used = posts_used + 1 WHERE id = $1', [req.user.userId]);
        
        res.json({ success: true, postId: result.rows[0].id, message: 'Post scheduled!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== MESSAGING SYSTEM ====================
app.get('/api/messages', authenticateToken, async (req, res) => {
    try {
        const messages = await pool.query(`
            SELECT m.*, 
                sender.email as sender_email, sender.business_name as sender_business,
                recipient.email as recipient_email, recipient.business_name as recipient_business
            FROM messages m
            JOIN users sender ON m.sender_id = sender.id
            JOIN users recipient ON m.recipient_id = recipient.id
            WHERE m.sender_id = $1 OR m.recipient_id = $1
            ORDER BY m.created_at DESC
        `, [req.user.userId]);
        
        res.json(messages.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/messages/conversation/:userId', authenticateToken, async (req, res) => {
    try {
        const messages = await pool.query(`
            SELECT m.*, sender.email as sender_email, sender.role as sender_role
            FROM messages m
            JOIN users sender ON m.sender_id = sender.id
            WHERE (m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1)
            ORDER BY m.created_at ASC
        `, [req.user.userId, req.params.userId]);
        
        // Mark as read
        await pool.query('UPDATE messages SET is_read = true WHERE recipient_id = $1 AND sender_id = $2', [req.user.userId, req.params.userId]);
        
        res.json(messages.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/messages/send', authenticateToken, async (req, res) => {
    const { recipientId, subject, content, parentId } = req.body;
    
    try {
        const result = await pool.query(
            `INSERT INTO messages (sender_id, recipient_id, subject, content, parent_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.user.userId, recipientId, subject, content, parentId || null]
        );
        
        res.json({ success: true, message: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/clients', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const clients = await pool.query(`SELECT id, email, business_name, contact_name FROM users WHERE role = 'customer' ORDER BY business_name`);
        res.json(clients.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== AUTO-PUBLISH CRON ====================
cron.schedule('*/5 * * * *', async () => {
    console.log('🤖 Auto-publishing...');
    
    try {
        const pending = await pool.query(`
            SELECT sp.*, u.email, u.package FROM scheduled_posts sp
            JOIN users u ON sp.user_id = u.id
            WHERE sp.status = 'pending' AND sp.scheduled_time <= NOW() AND u.is_active = true AND u.status = 'active'
        `);
        
        for (const post of pending.rows) {
            try {
                const accounts = await pool.query('SELECT platform, access_token, page_id FROM social_accounts WHERE user_id = $1 AND is_active = true', [post.user_id]);
                
                for (const account of accounts.rows) {
                    if (post.platforms.includes(account.platform)) {
                        await publishToPlatform(account.platform, account.access_token, account.page_id, post.content, post.media_urls);
                    }
                }
                
                await pool.query('UPDATE scheduled_posts SET status = $1, published_at = NOW() WHERE id = $2', ['published', post.id]);
                await pool.query('UPDATE users SET posts_published = posts_published + 1 WHERE id = $1', [post.user_id]);
                
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

async function publishToPlatform(platform, accessToken, pageId, content, mediaUrls) {
    // Platform-specific publishing implementations
    console.log(`Publishing to ${platform}...`);
    // Implementation would use platform APIs (Facebook Graph API, Twitter API, etc.)
}

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT COUNT(*) as total_users, COUNT(CASE WHEN package = 'starter' THEN 1 END) as starter_users, COUNT(CASE WHEN package = 'growth' THEN 1 END) as growth_users, COUNT(CASE WHEN package = 'professional' THEN 1 END) as professional_users, COUNT(CASE WHEN package = 'custom' THEN 1 END) as custom_users, SUM(posts_used) as total_posts, SUM(posts_published) as published_posts, COUNT(CASE WHEN last_login > NOW() - INTERVAL '7 days' THEN 1 END) as active_week FROM users WHERE role = 'customer'
        `);
        
        const revenue = await pool.query(`SELECT COUNT(CASE WHEN paypal_order_id IS NOT NULL THEN 1 END) as paypal_revenue, COUNT(CASE WHEN stripe_customer_id IS NOT NULL THEN 1 END) as stripe_revenue FROM users WHERE role = 'customer'`);
        
        const activity = await pool.query('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 20');
        
        res.json({ users: stats.rows[0], revenue: revenue.rows[0], recentActivity: activity.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await pool.query(`
            SELECT u.*, COUNT(p.id) as total_posts, array_agg(DISTINCT sa.platform) as connected_platforms,
                (SELECT COUNT(*) FROM messages WHERE recipient_id = u.id AND is_read = false) as unread_messages
            FROM users u 
            LEFT JOIN scheduled_posts p ON u.id = p.user_id 
            LEFT JOIN social_accounts sa ON u.id = sa.user_id AND sa.is_active = true 
            WHERE u.role = 'customer' 
            GROUP BY u.id 
            ORDER BY u.created_at DESC
        `);
        res.json(users.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.*, array_agg(DISTINCT sa.platform) as connected_platforms,
                array_agg(DISTINCT jsonb_build_object('id', sa.id, 'platform', sa.platform, 'username', sa.account_username, 'page_name', sa.page_name)) as accounts
            FROM users u 
            LEFT JOIN social_accounts sa ON u.id = sa.user_id AND sa.is_active = true 
            WHERE u.id = $1 AND u.role = 'customer' 
            GROUP BY u.id
        `, [req.params.id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Get user's posts
        const posts = await pool.query('SELECT * FROM scheduled_posts WHERE user_id = $1 ORDER BY scheduled_time DESC LIMIT 10', [req.params.id]);
        
        // Get user's messages
        const messages = await pool.query(`
            SELECT m.*, sender.email as sender_email
            FROM messages m
            JOIN users sender ON m.sender_id = sender.id
            WHERE m.sender_id = $1 OR m.recipient_id = $1
            ORDER BY m.created_at DESC LIMIT 20
        `, [req.params.id]);
        
        res.json({ ...result.rows[0], posts: posts.rows, messages: messages.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/admin/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { businessName, contactName, phone, email, package: pkg, postsRemaining, platformLimit, status, forcePasswordChange, features, notes } = req.body;

    try {
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (businessName !== undefined) { updates.push(`business_name = $${paramCount++}`); values.push(businessName); }
        if (contactName !== undefined) { updates.push(`contact_name = $${paramCount++}`); values.push(contactName); }
        if (phone !== undefined) { updates.push(`phone = $${paramCount++}`); values.push(phone); }
        if (email !== undefined) { updates.push(`email = $${paramCount++}`); values.push(email.toLowerCase()); }
        if (pkg !== undefined) { updates.push(`package = $${paramCount++}`); values.push(pkg); }
        if (postsRemaining !== undefined) { updates.push(`posts_remaining = $${paramCount++}`); values.push(postsRemaining); }
        if (platformLimit !== undefined) { updates.push(`platform_limit = $${paramCount++}`); values.push(platformLimit); }
        if (status !== undefined) { updates.push(`status = $${paramCount++}`); updates.push(`is_active = $${paramCount++}`); values.push(status); values.push(status === 'active'); }
        if (forcePasswordChange !== undefined) { updates.push(`force_password_change = $${paramCount++}`); values.push(forcePasswordChange); }
        if (features !== undefined) { updates.push(`features = $${paramCount++}`); values.push(JSON.stringify(features)); }
        if (notes !== undefined) { updates.push(`admin_notes = $${paramCount++}`); values.push(notes); }

        values.push(req.params.id);

        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        const result = await pool.query(query, values);

        await pool.query(`INSERT INTO admin_logs (action, user_id, details) VALUES ($1, $2, $3)`, ['user_updated', req.params.id, { updatedBy: req.user.userId, changes: Object.keys(req.body) }]);

        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM scheduled_posts WHERE user_id = $1', [req.params.id]);
        await pool.query('DELETE FROM social_accounts WHERE user_id = $1', [req.params.id]);
        await pool.query('DELETE FROM ai_generated_content WHERE user_id = $1', [req.params.id]);
        await pool.query('DELETE FROM messages WHERE sender_id = $1 OR recipient_id = $1', [req.params.id]);
        await pool.query('DELETE FROM media_uploads WHERE user_id = $1', [req.params.id]);
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        
        await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, ['user_deleted', { deletedUserId: req.params.id, deletedBy: req.user.userId }]);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/reset-password', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    
    try {
        const tempPassword = Math.random().toString(36).slice(-10);
        const hash = await bcrypt.hash(tempPassword, 10);
        
        await pool.query('UPDATE users SET password_hash = $1, force_password_change = true WHERE id = $2', [hash, userId]);
        
        await pool.query(`INSERT INTO admin_logs (action, user_id, details) VALUES ($1, $2, $3)`, ['password_reset', userId, { resetBy: req.user.userId }]);
        
        res.json({ success: true, tempPassword });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/user-status', authenticateToken, requireAdmin, async (req, res) => {
    const { userId, isActive } = req.body;
    try {
        await pool.query('UPDATE users SET is_active = $1, status = $2 WHERE id = $3', [isActive, isActive ? 'active' : 'suspended', userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/add-posts', authenticateToken, requireAdmin, async (req, res) => {
    const { userId, postsToAdd } = req.body;
    try {
        await pool.query('UPDATE users SET posts_remaining = posts_remaining + $1 WHERE id = $2', [postsToAdd, userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
initDatabase().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});

