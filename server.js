const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypal = require('@paypal/checkout-server-sdk');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const session = require('express-session');
require('dotenv').config();

const app = express();

// Body parsing middleware - MUST come before routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware for OAuth
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 600000 // 10 minutes
    }
}));

// Database configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 20,
    keepAlive: true
});

// Make db available to routes
app.locals.db = pool;

// PayPal setup
const Environment = process.env.NODE_ENV === 'production' 
    ? paypal.core.LiveEnvironment 
    : paypal.core.SandboxEnvironment;

const paypalEnvironment = new Environment(
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET
);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnvironment);

// CORS configuration - MUST be before routes
app.use(cors({ 
    origin: [
        'https://reelbridge.pages.dev',
        'https://reelbridge.site',
        'https://www.reelbridge.site',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
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

// Store OAuth states temporarily (in production, use Redis)
const oauthStates = new Map();

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

// ==================== OAUTH ROUTES (INLINE) ====================

// Generate OAuth URL for X (Twitter)
app.get('/api/oauth/twitter/url', authenticateToken, async (req, res) => {
    try {
        // Generate PKCE parameters
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto
            .createHash('sha256')
            .update(codeVerifier)
            .digest('base64url');
        
        const state = crypto.randomBytes(16).toString('hex');
        
        // Store state with user info (expires in 10 minutes)
        oauthStates.set(state, {
            userId: req.user.userId,
            codeVerifier,
            expires: Date.now() + 600000
        });
        
        // Clean up old states
        for (const [key, value] of oauthStates.entries()) {
            if (value.expires < Date.now()) {
                oauthStates.delete(key);
            }
        }
        
        const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
        authUrl.searchParams.append('response_type', 'code');
        authUrl.searchParams.append('client_id', process.env.TWITTER_CLIENT_ID);
        authUrl.searchParams.append('redirect_uri', process.env.TWITTER_CALLBACK_URL);
        authUrl.searchParams.append('scope', 'tweet.read tweet.write users.read offline.access');
        authUrl.searchParams.append('state', state);
        authUrl.searchParams.append('code_challenge', codeChallenge);
        authUrl.searchParams.append('code_challenge_method', 'S256');
        
        res.json({ url: authUrl.toString(), state });
        
    } catch (error) {
        console.error('OAuth URL generation error:', error);
        res.status(500).json({ error: 'Failed to generate OAuth URL' });
    }
});

// Handle X (Twitter) OAuth callback
app.get('/api/oauth/twitter/callback', async (req, res) => {
    const { code, state } = req.query;
    
    if (!code || !state) {
        return res.redirect('https://reelbridge.site/dashboard?error=oauth_failed&reason=missing_params');
    }
    
    // Retrieve stored state
    const storedState = oauthStates.get(state);
    
    if (!storedState) {
        return res.redirect('https://reelbridge.site/dashboard?error=oauth_failed&reason=state_not_found');
    }
    
    if (storedState.expires < Date.now()) {
        oauthStates.delete(state);
        return res.redirect('https://reelbridge.site/dashboard?error=oauth_failed&reason=state_expired');
    }
    
    try {
        // Exchange code for tokens
        const tokenResponse = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(
                    `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
                ).toString('base64')
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.TWITTER_CALLBACK_URL,
                code_verifier: storedState.codeVerifier
            })
        });
        
        const tokens = await tokenResponse.json();
        
        if (!tokens.access_token) {
            console.error('Token exchange failed:', tokens);
            throw new Error(tokens.error_description || 'No access token received');
        }
        
        // Get user info from X
        const userResponse = await fetch('https://api.twitter.com/2/users/me', {
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`
            }
        });
        
        const userData = await userResponse.json();
        
        if (!userData.data) {
            throw new Error('Failed to get user info from Twitter');
        }
        
        // Store in database
        await pool.query(`
            INSERT INTO social_accounts 
            (user_id, platform, account_username, profile_url, access_token, refresh_token, page_id, page_name, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
            ON CONFLICT (user_id, platform) 
            DO UPDATE SET 
                access_token = $5,
                refresh_token = $6,
                account_username = $3,
                profile_url = $4,
                is_active = true,
                connected_at = NOW()
        `, [
            storedState.userId,
            'twitter',
            userData.data.username,
            `https://twitter.com/${userData.data.username}`,
            tokens.access_token,
            tokens.refresh_token,
            userData.data.id,
            userData.data.name
        ]);
        
        // Clean up state
        oauthStates.delete(state);
        
        // Redirect back to frontend with success
        res.redirect(`https://reelbridge.site/dashboard?platform=twitter&connected=true&username=${userData.data.username}`);
        
    } catch (error) {
        console.error('Twitter OAuth callback error:', error);
        res.redirect(`https://reelbridge.site/dashboard?error=oauth_failed&message=${encodeURIComponent(error.message)}`);
    }
});

// Refresh token endpoint
app.post('/api/oauth/twitter/refresh', authenticateToken, async (req, res) => {
    try {
        // Get current refresh token
        const result = await pool.query(
            'SELECT refresh_token FROM social_accounts WHERE user_id = $1 AND platform = $2',
            [req.user.userId, 'twitter']
        );
        
        if (!result.rows[0]?.refresh_token) {
            return res.status(404).json({ error: 'No refresh token found' });
        }
        
        // Exchange refresh token
        const refreshResponse = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(
                    `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
                ).toString('base64')
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: result.rows[0].refresh_token
            })
        });
        
        const newTokens = await refreshResponse.json();
        
        if (!newTokens.access_token) {
            throw new Error('Failed to refresh token');
        }
        
        // Update database
        await pool.query(
            'UPDATE social_accounts SET access_token = $1, refresh_token = $2 WHERE user_id = $3 AND platform = $4',
            [newTokens.access_token, newTokens.refresh_token, req.user.userId, 'twitter']
        );
        
        res.json({ success: true, message: 'Token refreshed' });
        
    } catch (error) {
        console.error('Token refresh error:', error);
        res.status(500).json({ error: 'Failed to refresh token' });
    }
});

// Disconnect Twitter account
app.delete('/api/oauth/twitter/disconnect', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM social_accounts WHERE user_id = $1 AND platform = $2',
            [req.user.userId, 'twitter']
        );
        
        res.json({ success: true, message: 'Twitter account disconnected' });
        
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({ error: 'Failed to disconnect account' });
    }
});

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
    const templates = [
        `🚀 Exciting update about ${topic}! Stay tuned for more details. #Business #Growth`,
        `💡 Thinking about ${topic}? Here's what you need to know! Share your thoughts below. 👇`,
        `✨ New announcement: ${topic}! We're thrilled to share this with our community.`
    ];
    
    res.json({
        success: true,
        content: templates[0],
        variations: templates,
        source: 'template',
        industry,
        postType,
        tone
    });
});

// ==================== USER PROFILE & SOCIAL ACCOUNTS ====================

app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const userResult = await pool.query(
            'SELECT id, email, package, posts_remaining, posts_used, posts_published, platform_limit, features, language, business_name, contact_name FROM users WHERE id = $1',
            [req.user.userId]
        );
        
        const accountsResult = await pool.query(
            'SELECT platform, account_username, profile_url, is_active, connected_at FROM social_accounts WHERE user_id = $1',
            [req.user.userId]
        );
        
        // Count unread messages
        const messagesResult = await pool.query(
            'SELECT COUNT(*) as unread FROM messages WHERE recipient_id = $1 AND is_read = false',
            [req.user.userId]
        );
        
        res.json({
            profile: userResult.rows[0],
            accounts: accountsResult.rows,
            unreadMessages: parseInt(messagesResult.rows[0].unread)
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== SCHEDULED POSTS ====================

app.post('/api/schedule-post', authenticateToken, async (req, res) => {
    const {
        content,
        platforms,
        platformsData,
        mediaUrls,
        mediaIds,
        scheduledTime,
        industry,
        postType,
        tone,
        targetAudience,
        callToAction,
        isRecurring,
        recurrencePattern,
        recurrenceEndDate
    } = req.body;
    
    try {
        // Check posts remaining
        const userResult = await pool.query(
            'SELECT posts_remaining FROM users WHERE id = $1',
            [req.user.userId]
        );
        
        if (userResult.rows[0].posts_remaining < 1) {
            return res.status(400).json({ error: 'No posts remaining. Please upgrade your plan.' });
        }
        
        // Insert post
        const postResult = await pool.query(
            `INSERT INTO scheduled_posts (
                user_id, content, platforms, platforms_data, media_urls, media_ids,
                scheduled_time, industry, post_type, tone, target_audience, call_to_action,
                is_recurring, recurrence_pattern, recurrence_end_date
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING id`,
            [
                req.user.userId, content, platforms, JSON.stringify(platformsData || {}),
                mediaUrls || [], mediaIds || [], scheduledTime, industry, postType,
                tone, targetAudience, callToAction, isRecurring || false,
                recurrencePattern, recurrenceEndDate
            ]
        );
        
        // Decrement posts remaining
        await pool.query(
            'UPDATE users SET posts_remaining = posts_remaining - 1, posts_used = posts_used + 1 WHERE id = $1',
            [req.user.userId]
        );
        
        // If recurring, create instances
        let instancesCreated = 0;
        if (isRecurring && recurrencePattern) {
            instancesCreated = await createRecurringInstances(
                postResult.rows[0].id,
                scheduledTime,
                recurrencePattern,
                recurrenceEndDate,
                req.user.userId
            );
        }
        
        res.json({
            success: true,
            postId: postResult.rows[0].id,
            isRecurring: isRecurring || false,
            instancesCreated
        });
        
    } catch (error) {
        console.error('Schedule post error:', error);
        res.status(500).json({ error: 'Failed to schedule post' });
    }
});

async function createRecurringInstances(parentPostId, startTime, pattern, endDate, userId) {
    const instances = [];
    let currentTime = new Date(startTime);
    const endTime = endDate ? new Date(endDate) : new Date(currentTime.getTime() + 90 * 24 * 60 * 60 * 1000); // Max 90 days
    
    const patterns = {
        daily: 1,
        weekly: 7,
        biweekly: 14,
        monthly: 30
    };
    
    const daysIncrement = patterns[pattern] || 7;
    let count = 0;
    const maxInstances = 52; // Limit to prevent abuse
    
    while (currentTime < endTime && count < maxInstances) {
        currentTime = new Date(currentTime.getTime() + daysIncrement * 24 * 60 * 60 * 1000);
        
        if (currentTime < endTime) {
            instances.push(currentTime);
            count++;
        }
    }
    
    for (const instanceTime of instances) {
        await pool.query(
            `INSERT INTO post_instances (parent_post_id, scheduled_time) VALUES ($1, $2)`,
            [parentPostId, instanceTime]
        );
    }
    
    return instances.length;
}

app.get('/api/user/scheduled-posts', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT sp.*, 
                (SELECT COUNT(*) FROM post_instances WHERE parent_post_id = sp.id AND status = 'pending') as recurring_count
            FROM scheduled_posts sp
            WHERE sp.user_id = $1
            ORDER BY sp.scheduled_time ASC`,
            [req.user.userId]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('Get scheduled posts error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/recall-post/:postId', authenticateToken, async (req, res) => {
    const { postId } = req.params;
    const { reason, recallInstances } = req.body;
    
    try {
        // Verify ownership
        const postResult = await pool.query(
            'SELECT user_id, is_recurring, parent_post_id FROM scheduled_posts WHERE id = $1',
            [postId]
        );
        
        if (!postResult.rows[0] || postResult.rows[0].user_id !== req.user.userId) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        
        // Update post status
        await pool.query(
            `UPDATE scheduled_posts 
            SET is_recalled = true, recalled_at = NOW(), recall_reason = $1, status = 'cancelled'
            WHERE id = $2`,
            [reason, postId]
        );
        
        // If recurring and recallInstances is true, cancel future instances
        if (recallInstances && postResult.rows[0].is_recurring) {
            await pool.query(
                `UPDATE post_instances 
                SET status = 'cancelled', is_recalled = true
                WHERE parent_post_id = $1 AND scheduled_time > NOW()`,
                [postId]
            );
        }
        
        // Refund post credit
        await pool.query(
            'UPDATE users SET posts_remaining = posts_remaining + 1 WHERE id = $1',
            [req.user.userId]
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Recall post error:', error);
        res.status(500).json({ error: 'Failed to recall post' });
    }
});

// ==================== MESSAGES ====================

app.get('/api/messages', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.*, u.email as sender_email 
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            WHERE m.recipient_id = $1 OR m.sender_id = $1
            ORDER BY m.created_at DESC
            LIMIT 50`,
            [req.user.userId]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/messages/conversation/:clientId', authenticateToken, async (req, res) => {
    const { clientId } = req.params;
    
    try {
        const result = await pool.query(
            `SELECT m.*, u.email as sender_email 
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            WHERE (m.sender_id = $1 AND m.recipient_id = $2) 
               OR (m.sender_id = $2 AND m.recipient_id = $1)
            ORDER BY m.created_at ASC`,
            [req.user.userId, clientId]
        );
        
        // Mark messages as read
        await pool.query(
            'UPDATE messages SET is_read = true WHERE recipient_id = $1 AND sender_id = $2 AND is_read = false',
            [req.user.userId, clientId]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('Get conversation error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/messages/send', authenticateToken, async (req, res) => {
    const { recipientId, subject, content, parentId } = req.body;
    
    try {
        const result = await pool.query(
            `INSERT INTO messages (sender_id, recipient_id, subject, content, parent_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id`,
            [req.user.userId, recipientId, subject, content, parentId || null]
        );
        
        res.json({ success: true, messageId: result.rows[0].id });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const usersResult = await pool.query(`
            SELECT 
                COUNT(*) as total_users,
                COUNT(CASE WHEN last_login > NOW() - INTERVAL '7 days' THEN 1 END) as active_week,
                COUNT(CASE WHEN package = 'starter' THEN 1 END) as starter_users,
                COUNT(CASE WHEN package = 'growth' THEN 1 END) as growth_users,
                COUNT(CASE WHEN package = 'professional' THEN 1 END) as professional_users,
                COUNT(CASE WHEN package = 'custom' THEN 1 END) as custom_users
            FROM users WHERE role = 'customer'
        `);
        
        const revenueResult = await pool.query(`
            SELECT 
                COUNT(CASE WHEN paypal_order_id IS NOT NULL THEN 1 END) as paypal_revenue,
                COUNT(CASE WHEN stripe_customer_id IS NOT NULL THEN 1 END) as stripe_revenue
            FROM users
        `);
        
        const activityResult = await pool.query(
            'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 20'
        );
        
        res.json({
            users: usersResult.rows[0],
            revenue: revenueResult.rows[0],
            recentActivity: activityResult.rows
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, email, business_name, package, posts_remaining, posts_used, 
                   platform_limit, is_active, status, created_at, features
            FROM users 
            WHERE role = 'customer'
            ORDER BY created_at DESC
        `);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [req.params.id]
        );
        
        if (!result.rows[0]) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.patch('/api/admin/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    const updates = req.body;
    const allowedFields = ['business_name', 'contact_name', 'email', 'phone', 'package', 
                          'posts_remaining', 'platform_limit', 'status', 'is_active', 'features'];
    
    try {
        const setClause = [];
        const values = [];
        let paramCount = 1;
        
        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                setClause.push(`${key} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }
        
        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        
        values.push(req.params.id);
        
        await pool.query(
            `UPDATE users SET ${setClause.join(', ')} WHERE id = $${paramCount}`,
            values
        );
        
        // Log action
        await pool.query(
            `INSERT INTO admin_logs (action, user_id, details) VALUES ($1, $2, $3)`,
            ['user_updated', req.params.id, updates]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/user-status', authenticateToken, requireAdmin, async (req, res) => {
    const { userId, isActive } = req.body;
    
    try {
        await pool.query(
            'UPDATE users SET is_active = $1, status = $2 WHERE id = $3',
            [isActive, isActive ? 'active' : 'suspended', userId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/admin/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/reset-password', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const tempPass = Math.random().toString(36).slice(-10) + 'A1!';
    
    try {
        const hash = await bcrypt.hash(tempPass, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, force_password_change = true WHERE id = $2',
            [hash, userId]
        );
        
        res.json({ success: true, tempPassword: tempPass });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/clients', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, email, business_name, contact_name 
            FROM users 
            WHERE role = 'customer' AND is_active = true
            ORDER BY business_name
        `);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Get clients error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== POSTING SERVICE ====================

// Cron job for posting scheduled content
cron.schedule('*/5 * * * *', async () => {
    console.log('🕐 Checking for scheduled posts...');
    
    try {
        // Get pending posts that are due
        const postsResult = await pool.query(`
            SELECT sp.*, u.email as user_email
            FROM scheduled_posts sp
            JOIN users u ON sp.user_id = u.id
            WHERE sp.scheduled_time <= NOW()
            AND sp.status = 'pending'
            AND sp.is_recalled = false
        `);
        
        for (const post of postsResult.rows) {
            // Post to each platform
            for (const platform of post.platforms) {
                try {
                    await postToPlatform(platform, post);
                } catch (error) {
                    console.error(`Failed to post to ${platform}:`, error);
                }
            }
            
            // Update post status
            await pool.query(
                'UPDATE scheduled_posts SET status = $1, published_at = NOW() WHERE id = $2',
                ['published', post.id]
            );
            
            // Increment posts published
            await pool.query(
                'UPDATE users SET posts_published = posts_published + 1 WHERE id = $1',
                [post.user_id]
            );
        }
        
        // Handle recurring post instances
        const instancesResult = await pool.query(`
            SELECT pi.*, sp.content, sp.platforms, sp.platforms_data, sp.user_id
            FROM post_instances pi
            JOIN scheduled_posts sp ON pi.parent_post_id = sp.id
            WHERE pi.scheduled_time <= NOW()
            AND pi.status = 'pending'
            AND pi.is_recalled = false
        `);
        
        for (const instance of instancesResult.rows) {
            for (const platform of instance.platforms) {
                try {
                    await postToPlatform(platform, {
                        content: instance.content,
                        platforms_data: instance.platforms_data,
                        user_id: instance.user_id
                    });
                } catch (error) {
                    console.error(`Failed to post instance to ${platform}:`, error);
                }
            }
            
            await pool.query(
                'UPDATE post_instances SET status = $1, published_at = NOW() WHERE id = $2',
                ['published', instance.id]
            );
        }
        
    } catch (error) {
        console.error('Cron job error:', error);
    }
});

async function postToPlatform(platform, post) {
    // Get platform credentials
    const accountResult = await pool.query(
        'SELECT access_token, refresh_token FROM social_accounts WHERE user_id = $1 AND platform = $2 AND is_active = true',
        [post.user_id, platform]
    );
    
    if (!accountResult.rows[0]) {
        throw new Error(`No active ${platform} account found`);
    }
    
    const { access_token, refresh_token } = accountResult.rows[0];
    
    switch (platform) {
        case 'twitter':
            return await postToTwitter(post.content, access_token, refresh_token, post.user_id);
        // Add other platforms here as they are implemented
        default:
            console.log(`Posting to ${platform} not yet implemented`);
            return { success: false, message: 'Platform not implemented' };
    }
}

async function postToTwitter(content, accessToken, refreshToken, userId) {
    try {
        const response = await fetch('https://api.twitter.com/2/tweets', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text: content })
        });
        
        if (response.status === 401) {
            // Token expired, try to refresh
            const newToken = await refreshTwitterToken(userId, refreshToken);
            
            // Retry with new token
            const retryResponse = await fetch('https://api.twitter.com/2/tweets', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${newToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text: content })
            });
            
            if (!retryResponse.ok) {
                const error = await retryResponse.json();
                throw new Error(error.detail || 'Failed to post to Twitter after refresh');
            }
            
            return await retryResponse.json();
        }
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to post to Twitter');
        }
        
        return await response.json();
        
    } catch (error) {
        console.error('Twitter posting error:', error);
        throw error;
    }
}

async function refreshTwitterToken(userId, refreshToken) {
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(
                `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
            ).toString('base64')
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        })
    });
    
    const tokens = await response.json();
    
    if (!tokens.access_token) {
        throw new Error('Failed to refresh token');
    }
    
    // Update database
    await pool.query(
        'UPDATE social_accounts SET access_token = $1, refresh_token = $2 WHERE user_id = $3 AND platform = $4',
        [tokens.access_token, tokens.refresh_token, userId, 'twitter']
    );
    
    return tokens.access_token;
}

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📡 API URL: https://reelbridge-api.onrender.com`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
