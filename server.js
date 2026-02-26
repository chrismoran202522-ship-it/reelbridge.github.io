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

// PayPal setup - Use LiveEnvironment for production
const Environment = process.env.NODE_ENV === 'production' 
    ? paypal.core.LiveEnvironment 
    : paypal.core.SandboxEnvironment;

const paypalEnvironment = new Environment(
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET
);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnvironment);


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
                posts_remaining INTEGER DEFAULT 0,
                posts_used INTEGER DEFAULT 0,
                posts_published INTEGER DEFAULT 0,
                platforms TEXT[],
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                force_password_change BOOLEAN DEFAULT false,
                paypal_order_id VARCHAR(255),
                stripe_customer_id VARCHAR(255),
                is_demo BOOLEAN DEFAULT false
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
            
            CREATE TABLE IF NOT EXISTS faq_entries (
                id SERIAL PRIMARY KEY,
                category VARCHAR(50),
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                order_index INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT true
            );
        `);
        
        // Create admin if not exists
        const admin = await client.query('SELECT * FROM users WHERE role = $1', ['admin']);
        if (admin.rows.length === 0) {
            const hash = await bcrypt.hash('123456', 10);
            await client.query(
                `INSERT INTO users (email, password_hash, role, force_password_change, is_active)
                 VALUES ($1, $2, $3, $4, $5)`,
                ['cmoran@reelbridge.site', hash, 'admin', true, true]
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
                ('custom', 99, 50, 3, '{"base": true}'),
                ('free', 0, 5, 2, '{"trial": true, "limited_features": true}')
            `);
            console.log('✅ Default packages created');
        }
        
        // Initialize FAQ if not exists
        const faq = await client.query('SELECT * FROM faq_entries');
        if (faq.rows.length === 0) {
            await client.query(`
                INSERT INTO faq_entries (category, question, answer, order_index) VALUES
                ('Getting Started', 'What is Reel Bridge?', 'Reel Bridge is an AI-powered social media management platform that automates content creation, scheduling, and engagement across multiple platforms.', 1),
                ('Getting Started', 'How do I get started?', 'Sign up for a free account to explore the dashboard, or choose a paid plan to unlock full features. Connect your social accounts and start scheduling posts.', 2),
                ('Getting Started', 'Is there a free trial?', 'Yes! Create a free account to get 5 posts per month and access to basic features. No credit card required.', 3),
                ('Account', 'How do I change my password?', 'Go to your dashboard settings or click the profile menu. If you''re an admin, use the Admin Panel > Change Password option.', 4),
                ('Account', 'Can I upgrade or downgrade my plan?', 'Yes, you can change your plan anytime from your account settings. Changes take effect immediately.', 5),
                ('Billing', 'What payment methods do you accept?', 'We accept credit cards via Stripe and PayPal. All payments are secure and encrypted.', 6),
                ('Billing', 'How do I cancel my subscription?', 'You can cancel anytime from your account settings. Your access continues until the end of your billing period.', 7),
                ('Features', 'What platforms are supported?', 'We support Instagram, TikTok, Twitter/X, Facebook, LinkedIn, YouTube, Pinterest, and Threads depending on your plan.', 8),
                ('Features', 'How does AI content generation work?', 'Our AI analyzes your topic and generates engaging posts, captions, and hashtags optimized for each platform.', 9),
                ('Features', 'Can I schedule posts in advance?', 'Yes! Schedule posts days, weeks, or months ahead. Our system auto-publishes at your chosen time.', 10),
                ('Support', 'How do I contact support?', 'Growth and Professional plans include priority support. Email us at contact@reelbridge.site or use the help button.', 11),
                ('Support', 'What are your support hours?', 'Priority support is available 24/7 for paid plans. Free accounts have community support via our help center.', 12)
            `);
            console.log('✅ Default FAQ created');
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
                forcePasswordChange: user.force_password_change,
                isDemo: user.is_demo
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/register-free', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password || password.length < 8) {
        return res.status(400).json({ error: 'Valid email and password (min 8 chars) required' });
    }
    
    try {
        const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, package, posts_remaining, platforms, role, is_active)
             VALUES ($1, $2, 'free', 5, ARRAY['instagram', 'facebook'], 'customer', true)
             RETURNING id`,
            [email, hash]
        );
        
        await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, 
            ['free_signup', { email, userId: result.rows[0].id }]);
        
        res.json({ success: true, message: 'Free account created! You can now login.' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/change-password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    try {
        // Verify current password if not admin forcing change
        if (currentPassword) {
            const user = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
            if (!await bcrypt.compare(currentPassword, user.rows[0].password_hash)) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
        }
        
        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, force_password_change = false WHERE id = $2',
            [hash, req.user.userId]
        );
        
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== DEMO MODE ====================
app.post('/api/demo/start', async (req, res) => {
    try {
        // Create temporary demo user
        const demoEmail = `demo_${Date.now()}@reelbridge.temp`;
        const demoPass = await bcrypt.hash('demo123', 10);
        
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, package, posts_remaining, platforms, role, is_active, is_demo)
             VALUES ($1, $2, 'growth', 75, ARRAY['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube'], 'customer', true, true)
             RETURNING id, email`,
            [demoEmail, demoPass]
        );
        
        const token = jwt.sign(
            { userId: result.rows[0].id, email: result.rows[0].email, role: 'customer', package: 'growth', isDemo: true },
            process.env.JWT_SECRET,
            { expiresIn: '2h' }
        );
        
        // Add sample data
        await pool.query(
            `INSERT INTO scheduled_posts (user_id, content, platforms, scheduled_time, status)
             VALUES 
             ($1, 'Welcome to Reel Bridge! 🚀 This is a demo post showing how your content will look.', ARRAY['instagram', 'facebook'], NOW() + INTERVAL '1 day', 'pending'),
             ($1, 'Demo: AI-generated content example for your social media strategy.', ARRAY['twitter', 'linkedin'], NOW() + INTERVAL '2 days', 'pending')`,
            [result.rows[0].id]
        );
        
        await pool.query(
            `INSERT INTO social_accounts (user_id, platform, account_username, is_active)
             VALUES 
             ($1, 'instagram', 'demo_account', true),
             ($1, 'facebook', 'demo_page', true)`,
            [result.rows[0].id]
        );
        
        res.json({
            token,
            message: 'Demo mode activated! Explore the dashboard for 2 hours.',
            expiresIn: '2 hours'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PACKAGE CONFIGURATION (ADMIN) ====================
app.get('/api/admin/packages', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const packages = await pool.query('SELECT * FROM package_config ORDER BY price_monthly');
        res.json(packages.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/packages', authenticateToken, requireAdmin, async (req, res) => {
    const { package_name, price_monthly, price_quarterly, posts_limit, platforms_limit, features } = req.body;
    
    try {
        await pool.query(
            `INSERT INTO package_config (package_name, price_monthly, price_quarterly, posts_limit, platforms_limit, features)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (package_name) 
             DO UPDATE SET price_monthly = $2, price_quarterly = $3, posts_limit = $4, platforms_limit = $5, features = $6, updated_at = NOW()`,
            [package_name, price_monthly, price_quarterly, posts_limit, platforms_limit, JSON.stringify(features)]
        );
        
        await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, 
            ['package_update', { package_name, price_monthly }]);
        
        res.json({ success: true, message: 'Package updated' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/packages/:name', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await pool.query('UPDATE package_config SET is_active = false WHERE package_name = $1', [req.params.name]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== FAQ MANAGEMENT ====================
app.get('/api/faq', async (req, res) => {
    try {
        const faq = await pool.query(
            'SELECT * FROM faq_entries WHERE is_active = true ORDER BY category, order_index'
        );
        res.json(faq.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/faq', authenticateToken, requireAdmin, async (req, res) => {
    const { category, question, answer, order_index } = req.body;
    try {
        await pool.query(
            'INSERT INTO faq_entries (category, question, answer, order_index) VALUES ($1, $2, $3, $4)',
            [category, question, answer, order_index]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/faq/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await pool.query('UPDATE faq_entries SET is_active = false WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ADMIN IMPERSONATION ====================
app.post('/api/admin/impersonate', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    
    try {
        const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
        
        const target = user.rows[0];
        
        // Create impersonation token
        const token = jwt.sign(
            { 
                userId: target.id, 
                email: target.email, 
                role: target.role, 
                package: target.package,
                impersonatedBy: req.user.userId,
                originalAdmin: req.user.email
            },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );
        
        await pool.query(`INSERT INTO admin_logs (action, user_id, details) VALUES ($1, $2, $3)`, 
            ['impersonate', req.user.userId, { targetUser: target.email, targetId: target.id }]);
        
        res.json({
            token,
            user: {
                id: target.id,
                email: target.email,
                role: target.role,
                package: target.package,
                impersonated: true
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PAYMENTS ====================
app.get('/api/packages', async (req, res) => {
    try {
        const packages = await pool.query(
            'SELECT * FROM package_config WHERE is_active = true AND package_name != $1 ORDER BY price_monthly',
            ['free']
        );
        res.json(packages.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/create-stripe-intent', async (req, res) => {
    const { package, amount, email, billingCycle, features } = req.body;
    
    try {
        const pkg = await pool.query('SELECT * FROM package_config WHERE package_name = $1', [package]);
        const pkgData = pkg.rows[0];
        
        const intent = await stripe.paymentIntents.create({
            amount: amount * 100,
            currency: 'usd',
            receipt_email: email,
            metadata: { 
                package, 
                billingCycle, 
                customer_email: email, 
                posts_limit: pkgData?.posts_limit || 50,
                platforms_limit: pkgData?.platforms_limit || 3
            }
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
            const data = JSON.parse(capture.result.purchase_units[0].payments.captures[0].custom_id);
            const { package, billingCycle, features } = data;
            
            const pkg = await pool.query('SELECT * FROM package_config WHERE package_name = $1', [package]);
            const pkgData = pkg.rows[0];
            
            const hash = await bcrypt.hash(password, 10);
            const platforms = getPlatformsList(package, pkgData?.platforms_limit || 3);
            
            const result = await pool.query(
                `INSERT INTO users (email, password_hash, package, billing_cycle, posts_remaining, platforms, paypal_order_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [email, hash, package, billingCycle, pkgData?.posts_limit || 50, platforms, orderId]
            );
            
            await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, 
                ['purchase', { email, package, method: 'paypal' }]);
            
            res.json({ success: true, userId: result.rows[0].id });
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
        const { package, billingCycle, customer_email, posts_limit, platforms_limit } = payment.metadata;
        
        const tempPass = Math.random().toString(36).slice(-8);
        const hash = await bcrypt.hash(tempPass, 10);
        const platforms = getPlatformsList(package, parseInt(platforms_limit) || 3);
        
        try {
            await pool.query(
                `INSERT INTO users (email, password_hash, package, billing_cycle, posts_remaining, platforms, stripe_customer_id, force_password_change)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
                [customer_email, hash, package, billingCycle, parseInt(posts_limit) || 30, platforms, payment.customer]
            );
            
            console.log(`New user: ${customer_email}, Temp Password: ${tempPass}`);
            
            await pool.query(`INSERT INTO admin_logs (action, details) VALUES ($1, $2)`, 
                ['purchase', { email: customer_email, package, method: 'stripe', tempPass }]);
        } catch (e) {
            console.error(e);
        }
    }
    res.json({received: true});
});

function getPlatformsList(pkg, limit) {
    const allPlatforms = ['instagram', 'facebook', 'twitter', 'tiktok', 'linkedin', 'youtube', 'pinterest', 'threads'];
    const defaultPlatforms = {
        'starter': ['instagram', 'facebook', 'twitter'],
        'growth': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube'],
        'professional': allPlatforms,
        'custom': ['instagram', 'facebook', 'twitter'],
        'free': ['instagram', 'facebook']
    };
    return defaultPlatforms[pkg] || allPlatforms.slice(0, limit);
}

// ==================== USER DASHBOARD ====================
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query(
            'SELECT id, email, package, posts_remaining, posts_used, posts_published, platforms, created_at, is_demo FROM users WHERE id = $1', 
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
            profile: user.rows[0], 
            posts: posts.rows, 
            accounts: accounts.rows,
            isImpersonating: !!req.user.impersonatedBy
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/connect-account', authenticateToken, async (req, res) => {
    const { platform, accountUsername } = req.body;
    try {
        await pool.query(
            `INSERT INTO social_accounts (user_id, platform, account_username, access_token, is_active)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, platform) DO UPDATE SET account_username = $3, access_token = $4, is_active = $5`,
            [req.user.userId, platform, accountUsername, 'connected_' + Date.now(), true]
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
        const user = await pool.query('SELECT posts_remaining, package FROM users WHERE id = $1', [req.user.userId]);
        
        if (user.rows[0].posts_remaining <= 0) {
            return res.status(403).json({ error: 'Post limit reached. Upgrade your package.' });
        }
        
        // Check platform limit for free/demo users
        const userPlatforms = await pool.query(
            'SELECT COUNT(*) as count FROM social_accounts WHERE user_id = $1 AND is_active = true',
            [req.user.userId]
        );
        
        const pkg = await pool.query('SELECT platforms_limit FROM package_config WHERE package_name = $1', [user.rows[0].package]);
        const platformLimit = pkg.rows[0]?.platforms_limit || 3;
        
        if (userPlatforms.rows[0].count >= platformLimit && user.rows[0].package !== 'professional') {
            return res.status(403).json({ error: `Platform limit reached (${platformLimit}). Upgrade to connect more.` });
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
                COUNT(CASE WHEN package = 'starter' THEN 1 END) as starter_users,
                COUNT(CASE WHEN package = 'growth' THEN 1 END) as growth_users,
                COUNT(CASE WHEN package = 'professional' THEN 1 END) as pro_users,
                COUNT(CASE WHEN package = 'custom' THEN 1 END) as custom_users,
                COUNT(CASE WHEN package = 'free' THEN 1 END) as free_users,
                SUM(posts_used) as total_posts,
                SUM(posts_published) as published_posts,
                COUNT(CASE WHEN last_login > NOW() - INTERVAL '7 days' THEN 1 END) as active_week
            FROM users WHERE role = 'customer'
        `);
        
        const revenue = await pool.query(`
            SELECT 
                COUNT(CASE WHEN paypal_order_id IS NOT NULL THEN 1 END) as paypal_count,
                COUNT(CASE WHEN stripe_customer_id IS NOT NULL THEN 1 END) as stripe_count
            FROM users WHERE role = 'customer' AND package != 'free'
        `);
        
        const activity = await pool.query('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 20');
        
        res.json({
            users: stats.rows[0],
            revenue: { 
                paypal: revenue.rows[0].paypal_count, 
                stripe: revenue.rows[0].stripe_count 
            },
            recentActivity: activity.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await pool.query(`
            SELECT u.*, 
                   COUNT(p.id) as total_posts,
                   array_agg(DISTINCT sa.platform) as connected_platforms
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

app.post('/api/admin/user-status', authenticateToken, requireAdmin, async (req, res) => {
    const { userId, isActive } = req.body;
    try {
        await pool.query('UPDATE users SET is_active = $1 WHERE id = $2', [isActive, userId]);
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

