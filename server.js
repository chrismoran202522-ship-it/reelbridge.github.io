const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypal = require('@paypal/checkout-server-sdk');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// PayPal setup
const paypalEnvironment = new paypal.core.SandboxEnvironment(
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET
);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnvironment);

// Middleware
app.use(cors({ origin: '*' })); // Allow all origins for now
app.use(express.json());
app.use(express.static('public'));

// JWT Authentication middleware
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

// ==================== DATABASE SETUP ====================
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
                platforms TEXT[],
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                force_password_change BOOLEAN DEFAULT false,
                paypal_order_id VARCHAR(255),
                stripe_customer_id VARCHAR(255)
            );
            
            CREATE TABLE IF NOT EXISTS scheduled_posts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                content TEXT NOT NULL,
                platforms TEXT[] NOT NULL,
                media_urls TEXT[],
                scheduled_time TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                postiz_job_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                published_at TIMESTAMP,
                analytics JSONB
            );
            
            CREATE TABLE IF NOT EXISTS social_accounts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                platform VARCHAR(50) NOT NULL,
                account_name VARCHAR(255),
                access_token TEXT,
                refresh_token TEXT,
                expires_at TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS custom_packages (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                base_price INTEGER DEFAULT 99,
                features JSONB,
                total_price INTEGER,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS admin_logs (
                id SERIAL PRIMARY KEY,
                action VARCHAR(255),
                details JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Create default admin account
        const adminExists = await client.query('SELECT * FROM users WHERE role = $1', ['admin']);
        if (adminExists.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('123456', 10);
            await client.query(
                `INSERT INTO users (email, password_hash, role, force_password_change, is_active)
                 VALUES ($1, $2, $3, $4, $5)`,
                ['cmoran@reelbridge.site', hashedPassword, 'admin', true, true]
            );
            console.log('✅ Default admin created: cmoran / 123456');
        }
        
        console.log('✅ Database initialized');
    } finally {
        client.release();
    }
}

// ==================== AUTHENTICATION ROUTES ====================

// Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (!user.is_active) {
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
                forcePasswordChange: user.force_password_change
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Change password
app.post('/api/change-password', authenticateToken, async (req, res) => {
    const { newPassword } = req.body;
    
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, force_password_change = false WHERE id = $2',
            [hashedPassword, req.user.userId]
        );
        
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PAYMENT ROUTES ====================

// Create Stripe payment intent
app.post('/api/create-stripe-intent', async (req, res) => {
    const { package, amount, email, billingCycle, features } = req.body;
    
    const postsMap = {
        'starter': 30,
        'growth': 75,
        'professional': 999999,
        'custom': features?.posts || 50
    };
    
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount * 100,
            currency: 'usd',
            receipt_email: email,
            metadata: {
                package: package,
                billingCycle: billingCycle,
                customer_email: email,
                posts_limit: postsMap[package] || 50
            }
        });
        
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create PayPal order
app.post('/api/create-paypal-order', async (req, res) => {
    const { package, amount, billingCycle, features } = req.body;
    
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
            amount: {
                currency_code: 'USD',
                value: amount.toString(),
                breakdown: {
                    item_total: {
                        currency_code: 'USD',
                        value: amount.toString()
                    }
                }
            },
            description: `Reel Bridge ${package} Package - ${billingCycle}`,
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

// Capture PayPal payment
app.post('/api/capture-paypal-order', async (req, res) => {
    const { orderId, email, password } = req.body;
    
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});
    
    try {
        const capture = await paypalClient.execute(request);
        
        if (capture.result.status === 'COMPLETED') {
            const customData = JSON.parse(capture.result.purchase_units[0].payments.captures[0].custom_id);
            const { package, billingCycle, features } = customData;
            
            const hashedPassword = await bcrypt.hash(password, 10);
            const postsMap = {
                'starter': 30,
                'growth': 75,
                'professional': 999999,
                'custom': features?.posts || 50
            };
            
            const result = await pool.query(
                `INSERT INTO users (email, password_hash, package, billing_cycle, posts_remaining, platforms, paypal_order_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING id`,
                [
                    email,
                    hashedPassword,
                    package,
                    billingCycle,
                    postsMap[package] || 50,
                    getPlatformsForPackage(package, features),
                    orderId
                ]
            );
            
            if (package === 'custom' && features) {
                await pool.query(
                    `INSERT INTO custom_packages (user_id, base_price, features, total_price)
                     VALUES ($1, $2, $3, $4)`,
                    [result.rows[0].id, 99, JSON.stringify(features), amount]
                );
            }
            
            await pool.query(
                `INSERT INTO admin_logs (action, details) VALUES ($1, $2)`,
                ['new_purchase', { email, package, amount, method: 'paypal' }]
            );
            
            res.json({ 
                success: true, 
                message: 'Payment successful! Account created.',
                userId: result.rows[0].id
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stripe webhook
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const { package, billingCycle, customer_email, posts_limit } = paymentIntent.metadata;
        
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(tempPassword, 10);
        
        try {
            await pool.query(
                `INSERT INTO users (email, password_hash, package, billing_cycle, posts_remaining, platforms, stripe_customer_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    customer_email,
                    hashedPassword,
                    package,
                    billingCycle,
                    parseInt(posts_limit),
                    getPlatformsForPackage(package),
                    paymentIntent.customer
                ]
            );
            
            console.log(`New user: ${customer_email}, Temp pass: ${tempPassword}`);
            
            await pool.query(
                `INSERT INTO admin_logs (action, details) VALUES ($1, $2)`,
                ['new_purchase', { email: customer_email, package, amount: paymentIntent.amount, method: 'stripe' }]
            );
            
        } catch (dbError) {
            console.error('Database error:', dbError);
        }
    }
    
    res.json({received: true});
});

function getPlatformsForPackage(pkg, features = null) {
    const map = {
        'starter': ['instagram', 'facebook', 'twitter'],
        'growth': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube'],
        'professional': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube', 'pinterest', 'threads'],
        'custom': features?.platforms || ['instagram', 'facebook', 'twitter']
    };
    return map[pkg] || map['starter'];
}

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await pool.query(`
            SELECT u.*, 
                   COUNT(p.id) as total_posts,
                   COUNT(CASE WHEN p.status = 'published' THEN 1 END) as published_posts
            FROM users u
            LEFT JOIN scheduled_posts p ON u.id = p.user_id
            WHERE u.role = 'customer'
            GROUP BY u.id
            ORDER BY u.created_at DESC
        `);
        
        res.json(users.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_users,
                COUNT(CASE WHEN package = 'starter' THEN 1 END) as starter_users,
                COUNT(CASE WHEN package = 'growth' THEN 1 END) as growth_users,
                COUNT(CASE WHEN package = 'professional' THEN 1 END) as pro_users,
                COUNT(CASE WHEN package = 'custom' THEN 1 END) as custom_users,
                SUM(posts_used) as total_posts_used,
                COUNT(CASE WHEN last_login > NOW() - INTERVAL '7 days' THEN 1 END) as active_this_week
            FROM users
            WHERE role = 'customer'
        `);
        
        const revenue = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN paypal_order_id IS NOT NULL THEN total_price END), 0) as paypal_revenue,
                COALESCE(SUM(CASE WHEN stripe_customer_id IS NOT NULL THEN 
                    CASE package 
                        WHEN 'starter' THEN 254 
                        WHEN 'growth' THEN 509 
                        WHEN 'professional' THEN 849 
                        ELSE 99 
                    END 
                END), 0) as stripe_revenue
            FROM users
            LEFT JOIN custom_packages cp ON users.id = cp.user_id
            WHERE role = 'customer'
        `);
        
        const recentActivity = await pool.query(`
            SELECT * FROM admin_logs 
            ORDER BY created_at DESC 
            LIMIT 20
        `);
        
        res.json({
            users: stats.rows[0],
            revenue: revenue.rows[0],
            recentActivity: recentActivity.rows
        });
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
        await pool.query(
            'UPDATE users SET posts_remaining = posts_remaining + $1 WHERE id = $2',
            [postsToAdd, userId]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== USER DASHBOARD ROUTES ====================

app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query(
            'SELECT id, email, package, posts_remaining, posts_used, platforms, created_at FROM users WHERE id = $1',
            [req.user.userId]
        );
        
        const posts = await pool.query(
            `SELECT * FROM scheduled_posts 
             WHERE user_id = $1 
             ORDER BY scheduled_time DESC`,
            [req.user.userId]
        );
        
        const accounts = await pool.query(
            'SELECT * FROM social_accounts WHERE user_id = $1 AND is_active = true',
            [req.user.userId]
        );
        
        res.json({
            profile: user.rows[0],
            posts: posts.rows,
            accounts: accounts.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/schedule-post', authenticateToken, async (req, res) => {
    const { content, platforms, mediaUrls, scheduledTime } = req.body;
    
    try {
        const user = await pool.query(
            'SELECT posts_remaining FROM users WHERE id = $1',
            [req.user.userId]
        );
        
        if (user.rows[0].posts_remaining <= 0) {
            return res.status(403).json({ error: 'Post limit reached. Please upgrade.' });
        }
        
        const result = await pool.query(
            `INSERT INTO scheduled_posts (user_id, content, platforms, media_urls, scheduled_time)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.user.userId, content, platforms, mediaUrls, scheduledTime]
        );
        
        await pool.query(
            'UPDATE users SET posts_remaining = posts_remaining - 1, posts_used = posts_used + 1 WHERE id = $1',
            [req.user.userId]
        );
        
        res.json({ success: true, postId: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/connect-account', authenticateToken, async (req, res) => {
    const { platform, authCode } = req.body;
    
    try {
        await pool.query(
            `INSERT INTO social_accounts (user_id, platform, access_token, is_active)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, platform) DO UPDATE SET
             access_token = $3, is_active = $4`,
            [req.user.userId, platform, 'token_' + Date.now(), true]
        );
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/generate-content', authenticateToken, async (req, res) => {
    const { topic, platforms, tone = 'professional' } = req.body;
    
    const templates = {
        professional: `Excited to share insights about ${topic}! 🚀 What are your thoughts?`,
        casual: `Just posted about ${topic} - check it out! 👀`,
        promotional: `Discover the best of ${topic} with us! Limited time offer inside. 🔥`
    };
    
    res.json({ 
        success: true, 
        content: templates[tone] || templates.professional,
        fallback: true 
    });
});

// ==================== AUTOMATION ====================

cron.schedule('*/5 * * * *', async () => {
    console.log('Processing pending posts...');
    
    try {
        const pending = await pool.query(`
            SELECT sp.*, u.email 
            FROM scheduled_posts sp
            JOIN users u ON sp.user_id = u.id
            WHERE sp.status = 'pending' 
            AND sp.scheduled_time <= NOW()
            AND sp.scheduled_time > NOW() - INTERVAL '1 hour'
            AND u.is_active = true
        `);
        
        for (const post of pending.rows) {
            try {
                await pool.query(
                    'UPDATE scheduled_posts SET status = $1, published_at = NOW() WHERE id = $2',
                    ['published', post.id]
                );
                console.log(`Published post ${post.id}`);
            } catch (err) {
                await pool.query(
                    'UPDATE scheduled_posts SET status = $1 WHERE id = $2',
                    ['failed', post.id]
                );
            }
        }
    } catch (error) {
        console.error('Cron error:', error);
    }
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});
