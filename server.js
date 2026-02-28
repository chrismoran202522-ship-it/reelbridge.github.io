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

// ==================== DATABASE ====================
async function initDatabase() {
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
                status VARCHAR(20) DEFAULT 'pending',
                posts_remaining INTEGER DEFAULT 0,
                posts_used INTEGER DEFAULT 0,
                posts_published INTEGER DEFAULT 0,
                platforms TEXT[],
                is_active BOOLEAN DEFAULT false,
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
                user_id INTEGER REFERENCES users(id),
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
                user_id INTEGER REFERENCES users(id),
                platform VARCHAR(50) NOT NULL,
                account_username VARCHAR(255),
                profile_url VARCHAR(500),
                access_token TEXT,
                refresh_token TEXT,
                is_active BOOLEAN DEFAULT true,
                connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS ai_generated_content (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                topic VARCHAR(255),
                content TEXT,
                platforms TEXT[],
                used BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS admin_logs (
                id SERIAL PRIMARY KEY,
                action VARCHAR(255),
                user_id INTEGER,
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
                `INSERT INTO users (email, password_hash, role, force_password_change, is_active, status)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['cmoran@reelbridge.site', hash, 'admin', true, true, 'active']
            );
            console.log('✅ Admin: cmoran / 123456');
        }
        
        // Initialize default packages if not exists
        const packages = await client.query('SELECT * FROM package_config');
        if (packages.rows.length === 0) {
            await client.query(`
                INSERT INTO package_config (package_name, price_monthly, posts_limit, platforms_limit, features) VALUES
                ('starter', 254, 30, 3, '{"ai_content": true, "basic_analytics": true}'),
                ('growth', 509, 75, 6, '{"ai_video": true, "auto_engagement": true, "priority_support": true}'),
                ('professional', 849, 999999, 10, '{"ai_video_image": true, "dedicated_manager": true, "unlimited": true}'),
                ('custom', 99, 50, 3, '{"base": true}')
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
        if (!user.is_active) return res.status(403).json({ error: 'Account suspended' });
        
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
        
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role, package: user.package, forcePasswordChange: user.force_password_change },
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
                forcePasswordChange: user.force_password_change
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
                false, true
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
                    platforms, paypal_order_id, status, is_active, features
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
                [
                    email, hash, package, billingCycle, postsMap[package] || 50, 
                    getPlatforms(package, features), orderId, 'active', true, 
                    JSON.stringify(getDefaultFeatures(package))
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
                    platforms, stripe_customer_id, status, is_active, features
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    customer_email, hash, package, billingCycle, parseInt(posts_limit), 
                    getPlatforms(package), payment.customer, 'active', true,
                    JSON.stringify(getDefaultFeatures(package))
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
        'custom': features?.platforms ? ['instagram', 'facebook', 'twitter'].slice(0, features.platforms) :
