const express = require('express');
const stripe = require('stripe')('sk_test_YOUR_SECRET_KEY');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');
const app = express();

// Database setup (PostgreSQL for production)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/reelbridge'
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ==================== POSTIZ INTEGRATION ====================
// Postiz is self-hosted - replace with your Postiz instance URL
const POSTIZ_URL = process.env.POSTIZ_URL || 'http://localhost:4200';
const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY || 'your-postiz-api-key';

// Social Media Platforms Config
const PLATFORMS = {
    instagram: { maxChars: 2200, supportsVideo: true },
    tiktok: { maxChars: 2200, supportsVideo: true },
    twitter: { maxChars: 280, supportsVideo: true },
    facebook: { maxChars: 63206, supportsVideo: true },
    linkedin: { maxChars: 3000, supportsVideo: true },
    youtube: { maxChars: 5000, supportsVideo: true }
};

// ==================== DATABASE SETUP ====================
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                package VARCHAR(50) NOT NULL,
                billing_cycle VARCHAR(20) NOT NULL,
                posts_remaining INTEGER DEFAULT 0,
                platforms TEXT[],
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                stripe_customer_id VARCHAR(255)
            );
            
            CREATE TABLE IF NOT EXISTS scheduled_posts (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id),
                content TEXT NOT NULL,
                platforms TEXT[] NOT NULL,
                media_urls TEXT[],
                scheduled_time TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                postiz_job_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                published_at TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS social_accounts (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id),
                platform VARCHAR(50) NOT NULL,
                account_name VARCHAR(255),
                access_token TEXT,
                refresh_token TEXT,
                expires_at TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            );
        `);
        console.log('Database initialized');
    } finally {
        client.release();
    }
}

// ==================== STRIPE PAYMENT HANDLING ====================
app.post('/create-payment-intent', async (req, res) => {
    const { package, amount, email, billingCycle } = req.body;
    
    // Calculate posts based on package
    const postsMap = {
        'starter': 30,
        'growth': 75,
        'professional': 999999 // Unlimited
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
                posts_limit: postsMap[package]
            }
        });
        
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Webhook for successful payments
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const { package, billingCycle, customer_email, posts_limit } = paymentIntent.metadata;
        
        // Create customer in database
        try {
            await pool.query(
                `INSERT INTO customers (email, package, billing_cycle, posts_remaining, platforms, stripe_customer_id)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (email) DO UPDATE SET
                 package = $2, billing_cycle = $3, posts_remaining = posts_remaining + $4`,
                [
                    customer_email,
                    package,
                    billingCycle,
                    parseInt(posts_limit),
                    getPlatformsForPackage(package),
                    paymentIntent.customer
                ]
            );
            
            // Send welcome email with onboarding link
            await sendOnboardingEmail(customer_email, package);
            
        } catch (dbError) {
            console.error('Database error:', dbError);
        }
    }
    
    res.json({received: true});
});

function getPlatformsForPackage(pkg) {
    const map = {
        'starter': ['instagram', 'facebook', 'twitter'],
        'growth': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube'],
        'professional': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube', 'pinterest', 'threads']
    };
    return map[pkg] || map['starter'];
}

// ==================== SOCIAL MEDIA API ROUTES ====================

// Connect social account
app.post('/api/connect-account', async (req, res) => {
    const { email, platform, authCode } = req.body;
    
    try {
        // Exchange auth code for access token (platform-specific OAuth)
        const tokens = await exchangeAuthCode(platform, authCode);
        
        const customer = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
        if (!customer.rows.length) return res.status(404).json({ error: 'Customer not found' });
        
        await pool.query(
            `INSERT INTO social_accounts (customer_id, platform, access_token, refresh_token, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (customer_id, platform) DO UPDATE SET
             access_token = $3, refresh_token = $4, expires_at = $5`,
            [customer.rows[0].id, platform, tokens.access_token, tokens.refresh_token, tokens.expires_at]
        );
        
        res.json({ success: true, message: `${platform} connected successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Schedule a post
app.post('/api/schedule-post', async (req, res) => {
    const { email, content, platforms, mediaUrls, scheduledTime } = req.body;
    
    try {
        const customer = await pool.query('SELECT id, posts_remaining FROM customers WHERE email = $1', [email]);
        if (!customer.rows.length) return res.status(404).json({ error: 'Customer not found' });
        
        if (customer.rows[0].posts_remaining <= 0) {
            return res.status(403).json({ error: 'Post limit reached. Please upgrade your plan.' });
        }
        
        // Validate content length for each platform
        for (const platform of platforms) {
            if (content.length > PLATFORMS[platform].maxChars) {
                return res.status(400).json({ 
                    error: `Content too long for ${platform}. Max ${PLATFORMS[platform].maxChars} characters.` 
                });
            }
        }
        
        // Create post in Postiz
        const postizResponse = await axios.post(`${POSTIZ_URL}/api/posts`, {
            content,
            platforms,
            mediaUrls,
            scheduledAt: scheduledTime,
            timezone: 'America/New_York'
        }, {
            headers: { 'Authorization': `Bearer ${POSTIZ_API_KEY}` }
        });
        
        // Save to database
        const result = await pool.query(
            `INSERT INTO scheduled_posts (customer_id, content, platforms, media_urls, scheduled_time, postiz_job_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [customer.rows[0].id, content, platforms, mediaUrls, scheduledTime, postizResponse.data.id]
        );
        
        // Decrement posts remaining
        await pool.query(
            'UPDATE customers SET posts_remaining = posts_remaining - 1 WHERE id = $1',
            [customer.rows[0].id]
        );
        
        res.json({ 
            success: true, 
            postId: result.rows[0].id,
            message: 'Post scheduled successfully',
            scheduledTime 
        });
        
    } catch (error) {
        console.error('Scheduling error:', error);
        res.status(500).json({ error: 'Failed to schedule post' });
    }
});

// Get scheduled posts
app.get('/api/posts/:email', async (req, res) => {
    try {
        const customer = await pool.query('SELECT id FROM customers WHERE email = $1', [req.params.email]);
        if (!customer.rows.length) return res.status(404).json({ error: 'Customer not found' });
        
        const posts = await pool.query(
            `SELECT * FROM scheduled_posts 
             WHERE customer_id = $1 
             ORDER BY scheduled_time DESC`,
            [customer.rows[0].id]
        );
        
        res.json(posts.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Auto-generate content with AI
app.post('/api/generate-content', async (req, res) => {
    const { topic, platforms, tone = 'professional' } = req.body;
    
    try {
        // Use Postiz AI or external AI service
        const response = await axios.post(`${POSTIZ_URL}/api/ai/generate`, {
            topic,
            platforms,
            tone,
            variations: platforms.length
        }, {
            headers: { 'Authorization': `Bearer ${POSTIZ_API_KEY}` }
        });
        
        res.json({
            success: true,
            content: response.data.content,
            suggestedHashtags: response.data.hashtags,
            bestTimes: response.data.bestTimes
        });
    } catch (error) {
        // Fallback to template-based generation
        const content = generateTemplateContent(topic, platforms, tone);
        res.json({ success: true, content, fallback: true });
    }
});

// ==================== AUTOMATION ENGINE ====================

// Cron job: Process pending posts every 5 minutes
cron.schedule('*/5 * * * *', async () => {
    console.log('Checking for pending posts...');
    
    try {
        const pendingPosts = await pool.query(
            `SELECT sp.*, c.email, c.platforms as allowed_platforms
             FROM scheduled_posts sp
             JOIN customers c ON sp.customer_id = c.id
             WHERE sp.status = 'pending' 
             AND sp.scheduled_time <= NOW()
             AND sp.scheduled_time > NOW() - INTERVAL '1 hour'`
        );
        
        for (const post of pendingPosts.rows) {
            try {
                // Publish via Postiz
                await axios.post(`${POSTIZ_URL}/api/posts/${post.postiz_job_id}/publish`, {}, {
                    headers: { 'Authorization': `Bearer ${POSTIZ_API_KEY}` }
                });
                
                // Update status
                await pool.query(
                    'UPDATE scheduled_posts SET status = $1, published_at = NOW() WHERE id = $2',
                    ['published', post.id]
                );
                
                console.log(`Published post ${post.id} for ${post.email}`);
                
            } catch (publishError) {
                await pool.query(
                    'UPDATE scheduled_posts SET status = $1 WHERE id = $2',
                    ['failed', post.id]
                );
                console.error(`Failed to publish post ${post.id}:`, publishError.message);
            }
        }
    } catch (error) {
        console.error('Cron job error:', error);
    }
});

// Daily analytics sync
cron.schedule('0 2 * * *', async () => {
    console.log('Syncing analytics...');
    // Implementation for analytics aggregation
});

// ==================== HELPER FUNCTIONS ====================

async function exchangeAuthCode(platform, code) {
    // Platform-specific OAuth implementations
    const configs = {
        instagram: {
            tokenUrl: 'https://graph.instagram.com/oauth/access_token',
            clientId: process.env.INSTAGRAM_CLIENT_ID,
            clientSecret: process.env.INSTAGRAM_CLIENT_SECRET
        },
        twitter: {
            tokenUrl: 'https://api.twitter.com/2/oauth2/token',
            clientId: process.env.TWITTER_CLIENT_ID,
            clientSecret: process.env.TWITTER_CLIENT_SECRET
        }
        // Add other platforms as needed
    };
    
    const config = configs[platform];
    // Implementation for token exchange
    return { access_token: 'token', refresh_token: 'refresh', expires_at: new Date() };
}

function generateTemplateContent(topic, platforms, tone) {
    const templates = {
        professional: `Excited to share insights about ${topic}! 🚀 What are your thoughts?`,
        casual: `Just posted about ${topic} - check it out! 👀`,
        promotional: `Discover the best of ${topic} with us! Limited time offer inside. 🔥`
    };
    return templates[tone] || templates.professional;
}

async function sendOnboardingEmail(email, package) {
    // Implementation for sending onboarding email
    console.log(`Sending onboarding email to ${email} for ${package} package`);
}

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Reel Bridge server running on port ${PORT}`);
        console.log(`📱 Postiz integration: ${POSTIZ_URL}`);
    });
});
