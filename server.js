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
// Update this in server.js:
app.use(cors({ 
    origin: [
        'https://reelbridge-api.onrender.com',  // Your backend
        'https://reelbridge.pages.dev',  // Your frontend - UPDATE THIS
        'https://reelbridge.site',  // Your custom domain if you have one
        'http://localhost:3000'  // Local testing
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));


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
            { name: 'language', type: 'VARCHAR(10) DEFAULT \'en\'' }
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
            { name: 'recall_reason', type: 'TEXT' }
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
                address_city VARCHAR
(100),
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
                platforms_data JSONB DEFAULT '{}',
                media_urls TEXT[],
                media_ids INTEGER[],
                scheduled_time TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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

// ==================== AUTH ====================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
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
    const platformMap = { 'starter': 3, 'growth': 6, 'professional': 16, 'custom': features?.platforms || 3 };
    
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
            const platformMap = { 'starter': 3, 'growth': 6, 'professional': 16, 'custom': features?.platforms || 3 };
            
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
        'professional': ['instagram', 'tiktok', 'twitter', 'facebook', 'linkedin', 'youtube', 'pinterest', 'threads', 'snapchat', 'twitch', 'reddit', 'tumblr', 'medium', 'yelp', 'google_business', 'whatsapp'],
        'custom': features?.platforms ? ['instagram', 'facebook', 'twitter', 'tiktok', 'linkedin', 'youtube', 'pinterest', 'threads', 'snapchat', 'twitch'].slice(0, features.platforms) : ['instagram', 'facebook', 'twitter']
    };
    return map[pkg] || map['starter'];
}

// ==================== REAL AI CONTENT GENERATION (OpenAI Ready) ====================
// To use real AI, set OPENAI_API_KEY in environment variables
// The system will fall back to templates if no API key is provided

async function generateWithAI(params) {
    const { topic, industry, postType, tone, targetAudience, callToAction, includeHashtags, includeEmoji } = params;
    
    // Check if OpenAI is configured
    if (!process.env.OPENAI_API_KEY) {
        return null; // Fall back to templates
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
        
        // Parse variations from AI response
        const variations = content.split(/\d+[\.\)]\s*/).filter(v => v.trim().length > 20).slice(0, 3);
        
        return {
            content: variations[0] || content,
            variations: variations.length >= 3 ? variations : [content, content, content]
        };
    } catch (error) {
        console.error('OpenAI generation failed:', error);
        return null; // Fall back to templates
    }
}

app.post('/api/generate-content', authenticateToken, async (req, res) => {
    const { 
        topic, 
        platforms, 
        industry = 'general',
        postType = 'promotional',
        tone = 'professional',
        targetAudience = '',
        callToAction = '',
        includeHashtags = true,
        includeEmoji = true
    } = req.body;
    
    // Try real AI first
    const aiResult = await generateWithAI({
        topic, industry, postType, tone, targetAudience, callToAction, includeHashtags, includeEmoji
    });
    
    if (aiResult) {
        // Save to history
        try {
            await pool.query(`
                INSERT INTO ai_generated_content 
                (user_id, topic, content, platforms, industry, post_type, tone, target_audience) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [req.user.userId, topic, aiResult.content, platforms, industry, postType, tone, targetAudience]);
        } catch (e) {
            console.error(e);
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
    
    // Fall back to template-based generation
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
                "👨‍🍳 Chef's secret: {topic}. Learn what makes our dishes special!",
                "🍷 Pairing guide: {topic}. Elevate your dining experience with the perfect combination.",
                "🥗 Nutrition spotlight: {topic}. Delicious AND good for you!"
            ],
            engagement: [
                "📸 Foodie Friday: {topic}. Tag us in your photos for a chance to be featured!",
                "🗳️ Vote now! {topic}. Help us choose our next featured dish! 👇",
                "🎂 Birthday celebration! {topic}. Join us for complimentary dessert on your special day!"
            ],
            behindScenes: [
                "🔥 In the kitchen: {topic}. Fresh ingredients, passionate chefs, amazing flavors!",
                "🌾 Farm to table: {topic}. We source locally for the freshest taste!"
            ],
            seasonal: [
                "🎃 Halloween special: {topic}. Spooky delicious treats for the whole family!",
                "🦃 Holiday catering: {topic}. Let us handle the cooking this season!"
            ]
        },
        fitness: {
            promotional: [
                "🎉 New member special: {topic}! Join now and get your first month FREE!",
                "👯‍♀️ Bring a friend! {topic}. Working out is better together - both save on membership!",
                "🎯 Challenge accepted: {topic}. 30-day transformation challenge starts Monday!"
            ],
            educational: [
                "💪 Form check: {topic}. Proper technique prevents injury and maximizes results!",
                "🥗 Nutrition 101: {topic}. Fuel your body right for optimal performance!",
                "😴 Recovery matters: {topic}. Rest is when your muscles grow stronger!"
            ],
            motivational: [
                "🔥 No excuses! {topic}. Your only limit is you. Let's crush those goals together! 💪",
                "📈 Progress, not perfection: {topic}. Every workout counts - keep showing up!",
                "🏆 Transformation Tuesday: {topic}. Real members, real results!"
            ],
            engagement: [
                "🤝 Meet our community: {topic}. These members inspire us every day!",
                "📸 Share your sweat! {topic}. Tag us in your workout photos!"
            ],
            community: [
                "🏋️‍♀️ Group class alert: {topic}. Find your fitness family with us!",
                "🎽 Member milestone: {topic}. Celebrating amazing achievements in our community!"
            ]
        },
        legal: {
            promotional: [
                "📞 Free consultation: {topic}. Discuss your case with experienced attorneys - no obligation!",
                "🏆 Case result: {topic}. Another successful outcome for our client!",
                "📅 Limited time: {topic}. Estate planning package special - protect your family's future!"
            ],
            educational: [
                "⚖️ Legal insight: {topic}. Understanding your rights is the first step to protection.",
                "📋 Important update: {topic}. Stay informed about changes that may affect you.",
                "❓ Common question: {topic}. We're here to provide clarity on complex legal matters."
            ],
            trust: [
                "🎓 Meet the team: {topic}. Decades of combined experience working for you.",
                "⭐ Client review: {topic}. See why clients trust us with their most important matters."
            ],
            engagement: [
                "📊 Poll: {topic}. We want to hear your thoughts on this important issue!",
                "🎉 Client win: {topic}. Celebrating justice served for our community!"
            ],
            seasonal: [
                "📝 Year-end legal checkup: {topic}. Start the new year with your affairs in order.",
                "🏠 Spring cleaning for your legal documents: {topic}. Time for an update?"
            ]
        },
        salon: {
            promotional: [
                "💇‍♀️ New client special: {topic}! 20% off your first service - book now!",
                "🎉 Flash sale: {topic}! This weekend only - don't miss out!",
                "👰 Bridal package: {topic}. Look stunning on your special day!"
            ],
            educational: [
                "💇‍♀️ Hair care tip: {topic}. Keep your locks looking luscious between visits!",
                "💅 Nail health: {topic}. Beautiful nails start with healthy nails!",
                "✨ Skin care 101: {topic}. The right routine makes all the difference!"
            ],
            engagement: [
                "📸 Transformation Tuesday: {topic}. Before & after - we love making clients feel beautiful!",
                "🗳️ This or that: {topic}. Help us choose which style to feature next!",
                "🎨 Color of the season: {topic}. What's your go-to shade?"
            ],
            showcase: [
                "✨ Style spotlight: {topic}. Our latest creations that we absolutely love!",
                "🏆 Award-winning stylist: {topic}. Recognized excellence in our salon!"
            ],
            seasonal: [
                "🌸 Spring refresh: {topic}. New season, new look!",
                "🎄 Holiday glam: {topic}. Get party-ready with our special packages!"
            ]
        },
        retail: {
            promotional: [
                "🏷️ Sale alert: {topic}! Up to 50% off select items - shop now!",
                "🎁 New arrivals: {topic}. Be the first to shop our latest collection!",
                "💳 Member exclusive: {topic}. Extra 15% off for loyalty members!"
            ],
            educational: [
                "🛍️ Style guide: {topic}. Elevate your wardrobe with these tips!",
                "👗 Care instructions: {topic}. Make your favorites last longer!",
                "🎨 Color trends: {topic}. Stay ahead of the fashion curve!"
            ],
            engagement: [
                "🗳️ This or that? {topic}. Help us choose which style to stock more of! 👇",
                "📸 Outfit of the day: {topic}. Tag us in your looks for a chance to be featured!",
                "🎉 Customer spotlight: {topic}. Real style from real customers!"
            ],
            showcase: [
                "✨ Featured collection: {topic}. Handpicked favorites just for you!",
                "🔥 Trending now: {topic}. What's flying off our shelves this week!"
            ],
            seasonal: [
                "🍂 Fall wardrobe essentials: {topic}. Must-haves for the new season!",
                "🎁 Holiday gift guide: {topic}. Perfect presents for everyone on your list!"
            ]
        },
        technology: {
            promotional: [
                "💻 Upgrade special: {topic}! Trade in your old device for big savings!",
                "🎉 New product launch: {topic}. Be among the first to experience the future!",
                "🔧 Service special: {topic}. Keep your tech running smoothly!"
            ],
            educational: [
                "💡 Tech tip: {topic}. Get the most out of your devices!",
                "🔒 Security alert: {topic}. Protect your data with these simple steps!",
                "🚀 Innovation spotlight: {topic}. The future is here - stay ahead of the curve!"
            ],
            thoughtLeadership: [
                "🤔 Industry insight: {topic}. Our experts share their perspective on what's next.",
                "📊 Market analysis: {topic}. Understanding trends helps you make better tech decisions!"
            ],
            engagement: [
                "🗳️ Product poll: {topic}. Which feature matters most to you? Let us know!",
                "🎉 Beta access: {topic}. Be the first to try our newest innovations!"
            ],
            seasonal: [
                "🎓 Back to school tech: {topic}. Gear up for success this semester!",
                "🎄 Holiday tech gifts: {topic}. The perfect gadgets for everyone on your list!"
            ]
        },
        general: {
            promotional: [
                "🚀 Excited to share: {topic}! Check out what's new with us!",
                "💎 Special offer: {topic}! Limited time only - don't miss out!",
                "🎉 Big news: {topic}! We're thrilled to share this with our community!"
            ],
            educational: [
                "💡 Did you know? {topic}. We love sharing insights that help our customers!",
                "📚 Learn more: {topic}. Knowledge is power!"
            ],
            engagement: [
                "🤔 Question for you: {topic}? We'd love to hear your thoughts! 👇",
                "📸 Show us: {topic}! Tag us in your photos!"
            ],
            motivational: [
                "💪 Monday motivation: {topic}. Start your week strong with us!",
                "🌟 Success story: {topic}. Real results from real customers!"
            ],
            seasonal: [
                "🎆 New beginnings: {topic}. Start fresh with us this season!",
                "🎉 Holiday hours: {topic}. We're here when you need us most!"
            ]
        }
    };
    
    // Select templates based on industry and post type
    const templates = industryTemplates[industry]?.[postType] || industryTemplates.general.promotional;
    
    // Generate content
    let content = templates[0].replace('{topic}', topic);
    
    // Add call to action if provided
    if (callToAction) {
        content += ` ${callToAction}`;
    }
    
    // Generate industry-specific hashtags
    const hashtagSets = {
        automotive: ['#Auto', '#CarLife', '#Drive', '#Vehicle', '#AutoIndustry'],
        realestate: ['#RealEstate', '#Home', '#Property', '#Housing', '#Realtor'],
        medical: ['#Health', '#Wellness', '#Healthcare', '#Medical', '#HealthyLiving'],
        restaurant: ['#Foodie', '#Food', '#EatLocal', '#Restaurant', '#Delicious'],
        fitness: ['#Fitness', '#Workout', '#GymLife', '#Healthy', '#FitLife'],
        legal: ['#Legal', '#Law', '#Justice', '#Attorney', '#LegalAdvice'],
        salon: ['#Beauty', '#Salon', '#Hair', '#Style', '#Glam'],
        retail: ['#Shopping', '#Fashion', '#Style', '#Retail', '#ShopLocal'],
        technology: ['#Tech', '#Innovation', '#Digital', '#Technology', '#Future'],
        general: ['#Business', '#Success', '#Growth', '#Entrepreneur', '#Innovation']
    };
    
    const hashtags = (hashtagSets[industry] || hashtagSets.general).join(' ');
    
    // Add emoji if requested
    if (!includeEmoji) {
        content = content.replace(/[\u{1F600}-\u{1F64F}]/gu, '').replace(/[\u{1F300}-\u{1F5FF}]/gu, '').replace(/[\u{1F680}-\u{1F6FF}]/gu, '').replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '').replace(/[\u{2600}-\u{26FF}]/gu, '').replace(/[\u{2700}-\u{27BF}]/gu, '');
    }
    
    // Generate best posting times based on industry
    const bestTimesByIndustry = {
        restaurant: ['11:30 AM', '5:00 PM', '7:00 PM'],
        retail: ['12:00 PM', '3:00 PM', '7:00 PM'],
        medical: ['9:00 AM', '1:00 PM', '4:00 PM'],
        realestate: ['9:00 AM', '12:00 PM', '6:00 PM'],
        automotive: ['10:00 AM', '2:00 PM', '6:00 PM'],
        fitness: ['6:00 AM', '12:00 PM', '5:00 PM'],
        general: ['9:00 AM', '12:00 PM', '6:00 PM']
    };
    
    try {
        await pool.query(`
            INSERT INTO ai_generated_content 
            (user_id, topic, content, platforms, industry, post_type, tone, target_audience) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [req.user.userId, topic, content, platforms, industry, postType, tone, targetAudience]);
    } catch (e) {
        console.error(e);
    }
    
    res.json({
        success: true,
        content,
        hashtags: includeHashtags ? hashtags : '',
        bestTimes: bestTimesByIndustry[industry] || bestTimesByIndustry.general,
        industry,
        postType,
        tone,
        variations: templates.slice(0, 3).map(t => t.replace('{topic}', topic)),
        source: 'template'
    });
});

// ==================== ENHANCED SCHEDULING WITH RECURRENCE ====================
app.post('/api/schedule-post', authenticateToken, async (req, res) => {
    const { 
        content, 
        platforms, 
        platformsData,
        mediaUrls, 
        mediaIds, 
        scheduledTime,
        industry = 'general',
        postType = 'promotional',
        tone = 'professional',
        targetAudience = '',
        callToAction = '',
        isRecurring = false,
        recurrencePattern = null,
        recurrenceEndDate = null
    } = req.body;
    
    try {
        const user = await pool.query('SELECT posts_remaining, platform_limit FROM users WHERE id = $1', [req.user.userId]);
        
        if (user.rows[0].posts_remaining <= 0) {
            return res.status(403).json({ error: 'Post limit reached. Upgrade your package.' });
        }
        
        // Create the parent post
        const result = await pool.query(`
            INSERT INTO scheduled_posts 
            (user_id, content, platforms, platforms_data, media_urls, media_ids, scheduled_time, 
             industry, post_type, tone, target_audience, call_to_action,
             is_recurring, recurrence_pattern, recurrence_end_date, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) 
            RETURNING id
        `, [
            req.user.userId, content, platforms, JSON.stringify(platformsData || {}), 
            mediaUrls || [], mediaIds || [], scheduledTime,
            industry, postType, tone, targetAudience, callToAction,
            isRecurring, recurrencePattern, recurrenceEndDate,
            isRecurring ? 'recurring_parent' : 'pending'
        ]);
        
        const parentPostId = result.rows[0].id;
        
        // If recurring, create future instances
        let instances = [];
        if (isRecurring && recurrencePattern) {
            instances = generateRecurringInstances(scheduledTime, recurrencePattern, recurrenceEndDate);
            
            for (const instanceTime of instances) {
                await pool.query(`
                    INSERT INTO post_instances 
                    (parent_post_id, scheduled_time) 
                    VALUES ($1, $2)
                `, [parentPostId, instanceTime]);
            }
        }
        
        await pool.query(`
            UPDATE users 
            SET posts_remaining = posts_remaining - 1, posts_used = posts_used + 1 
            WHERE id = $1
        `, [req.user.userId]);
        
        res.json({ 
            success: true, 
            postId: parentPostId, 
            message: isRecurring ? 'Recurring post schedule created!' : 'Post scheduled!',
            isRecurring,
            instancesCreated: instances.length
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function generateRecurringInstances(startTime, pattern, endDate) {
    const instances = [];
    let current = new Date(startTime);
    const end = endDate ? new Date(endDate) : new Date(current.getTime() + 90 * 24 * 60 * 60 * 1000);
    
    // Skip the first one (parent post)
    if (pattern === 'daily') {
        current.setDate(current.getDate() + 1);
    } else if (pattern === 'weekly') {
        current.setDate(current.getDate() + 7);
    } else if (pattern === 'monthly') {
        current.setMonth(current.getMonth() + 1);
    } else if (pattern === 'biweekly') {
        current.setDate(current.getDate() + 14);
    }
    
    while (current <= end) {
        instances.push(current.toISOString());
        
        if (pattern === 'daily') {
            current.setDate(current.getDate() + 1);
        } else if (pattern === 'weekly') {
            current.setDate(current.getDate() + 7);
        } else if (pattern === 'monthly') {
            current.setMonth(current.getMonth() + 1);
        } else if (pattern === 'biweekly') {
            current.setDate(current.getDate() + 14);
        }
    }
    
    return instances;
}

// ==================== GET SCHEDULED POSTS WITH INSTANCES ====================
app.get('/api/user/scheduled-posts', authenticateToken, async (req, res) => {
    try {
        const posts = await pool.query(`
            SELECT 
                sp.*,
                COALESCE(pi.instance_count, 0) as instance_count,
                COALESCE(pi.instances, ARRAY[]::jsonb[]) as instances
            FROM scheduled_posts sp
            LEFT JOIN (
                SELECT 
                    parent_post_id,
                    COUNT(*) as instance_count,
                    ARRAY_AGG(
                        jsonb_build_object(
                            'id', id,
                            'scheduled_time', scheduled_time,
                            'status', status,
                            'is_recalled', is_recalled
                        ) ORDER BY scheduled_time
                    ) FILTER (WHERE status = 'pending' AND is_recalled = false) as instances
                FROM post_instances
                WHERE status = 'pending' AND is_recalled = false
                GROUP BY parent_post_id
            ) pi ON sp.id = pi.parent_post_id
            WHERE sp.user_id = $1 AND sp.is_recalled = false
            ORDER BY sp.scheduled_time DESC
        `, [req.user.userId]);
        
        res.json(posts.rows);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== RECALL A POST ====================
app.post('/api/recall-post/:postId', authenticateToken, async (req, res) => {
    const { postId } = req.params;
    const { reason, recallInstances = false } = req.body;
    
    try {
        const post = await pool.query(
            'SELECT * FROM scheduled_posts WHERE id = $1 AND user_id = $2',
            [postId, req.user.userId]
        );
        
        if (post.rows.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        const postData = post.rows[0];
        
        // Check recall window for published posts
        if (postData.status === 'published') {
            const publishedAt = new Date(postData.published_at);
            const now = new Date();
            const hoursSincePublished = (now - publishedAt) / (1000 * 60 * 60);
            
            if (hoursSincePublished > 1) {
                return res.status(403).json({ 
                    error: 'Recall window expired. Posts can only be recalled within 1 hour of publishing.' 
                });
            }
        }
        
        // Update the post
        await pool.query(`
            UPDATE scheduled_posts 
            SET is_recalled = true, 
                recalled_at = NOW(), 
                recall_reason = $1,
                status = 'recalled'
            WHERE id = $2
        `, [reason, postId]);
        
        // Recall future instances if requested
        if (recallInstances && postData.is_recurring) {
            await pool.query(`
                UPDATE post_instances 
                SET is_recalled = true 
                WHERE parent_post_id = $1 AND status = 'pending'
            `, [postId]);
        }
        
        // Attempt to delete from platforms
        const deletionResults = await recallFromPlatforms(postData);
        
        res.json({ 
            success: true, 
            message: 'Post recalled successfully',
            deletionResults
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function recallFromPlatforms(post) {
    const results = {};
    const platforms = post.platforms || [];
    
    for (const platform of platforms) {
        try {
            results[platform] = await deleteFromPlatform(platform, post);
        } catch (err) {
            results[platform] = { success: false, error: err.message };
        }
    }
    
    return results;
}

async function deleteFromPlatform(platform, post) {
    const account = await pool.query(
        'SELECT access_token, page_id FROM social_accounts WHERE user_id = $1 AND platform = $2',
        [post.user_id, platform]
    );
    
    if (account.rows.length === 0) {
        return { success: false, error: 'No connected account' };
    }
    
    // Platform-specific deletion logic would go here
    // For now, return success (actual implementation requires platform APIs)
    return { success: true, message: 'Deletion requested' };
}

// ==================== UPDATE POST PLATFORMS ====================
app.patch('/api/post/:postId/platforms', authenticateToken, async (req, res) => {
    const { postId } = req.params;
    const { platforms, platformsData } = req.body;
    
    try {
        await pool.query(`
            UPDATE scheduled_posts 
            SET platforms = $1, platforms_data = $2, updated_at = NOW()
            WHERE id = $3 AND user_id = $4 AND status = 'pending'
        `, [platforms, JSON.stringify(platformsData), postId, req.user.userId]);
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
        twitch: `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/twitch&scope=channel:manage:broadcast user:read:email&response_type=code&state=${userId}`,
        reddit: `https://www.reddit.com/api/v1/authorize?client_id=${process.env.REDDIT_CLIENT_ID}&response_type=code&state=${userId}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/reddit&scope=submit,read`,
        tumblr: `https://www.tumblr.com/oauth2/authorize?client_id=${process.env.TUMBLR_CONSUMER_KEY}&response_type=code&state=${userId}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/tumblr`,
        medium: `https://medium.com/m/oauth/authorize?client_id=${process.env.MEDIUM_INTEGRATION_TOKEN}&scope=basicProfile,publishPost&state=${userId}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/medium`,
        yelp: `https://biz.yelp.com/oauth2/authorize?client_id=${process.env.YELP_API_KEY}&state=${userId}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/yelp`,
        google_business: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_BUSINESS_CLIENT_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/google_business&scope=https://www.googleapis.com/auth/business.manage&response_type=code&state=${userId}`,
        whatsapp: `https://graph.facebook.com/v18.0/oauth/authorize?client_id=${process.env.WHATSAPP_BUSINESS_ID}&redirect_uri=${process.env.OAUTH_REDIRECT_URI}/whatsapp&scope=whatsapp_business_messaging,whatsapp_business_management&response_type=code&state=${userId}`
    };
    
    res.json({ url: oauthUrls[platform] || null });
});

app.post('/api/oauth/:platform/callback', async (req, res) => {
    const { platform } = req.params;
    const { code, state: userId } = req.body;
    
    try {
        const tokenResponse = await exchangeCodeForToken(platform, code);
        const accountInfo = await getAccountInfo(platform, tokenResponse.access_token);
        
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
    // In production, implement actual token exchange with each platform
    // For now, return mock tokens
    return { access_token: 'mock_token_' + Date.now(), refresh_token: 'mock_refresh_' + Date.now() };
}

async function getAccountInfo(platform, accessToken) {
    // In production, fetch actual account info from each platform
    return { username: 'user_' + Date.now(), profileUrl: `https://${platform}.com/user`, pageId: 'page_' + Date.now(), pageName: 'My Page' };
}

app.post('/api/connect-account', authenticateToken, async (req, res) => {
    const { platform, accountUsername, profileUrl, pageId, pageName } = req.body;
    try {
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
        // In production, upload to cloud storage (S3, Cloudinary, etc.)
        // For now, store locally
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
        // Get pending posts
        const pending = await pool.query(`
            SELECT sp.*, u.email, u.package FROM scheduled_posts sp
            JOIN users u ON sp.user_id = u.id
            WHERE sp.status = 'pending' AND sp.scheduled_time <= NOW() AND u.is_active = true AND u.status = 'active' AND sp.is_recalled = false
        `);
        
        for (const post of pending.rows) {
            try {
                const accounts = await pool.query('SELECT platform, access_token, page_id FROM social_accounts WHERE user_id = $1 AND is_active = true', [post.user_id]);
                
                for (const account of accounts.rows) {
                    // Check if platform is included in this post
                    const platformsData = post.platforms_data || {};
                    if (post.platforms.includes(account.platform) && platformsData[account.platform] !== false) {
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
        
        // Also check post_instances for recurring posts
        const recurringInstances = await pool.query(`
            SELECT pi.*, sp.user_id, sp.content, sp.media_urls, sp.platforms, sp.platforms_data
            FROM post_instances pi
            JOIN scheduled_posts sp ON pi.parent_post_id = sp.id
            WHERE pi.scheduled_time <= NOW() AND pi.status = 'pending' AND pi.is_recalled = false
        `);
        
        for (const instance of recurringInstances.rows) {
            try {
                const accounts = await pool.query('SELECT platform, access_token, page_id FROM social_accounts WHERE user_id = $1 AND is_active = true', [instance.user_id]);
                
                for (const account of accounts.rows) {
                    const platformsData = instance.platforms_data || {};
                    if (instance.platforms.includes(account.platform) && platformsData[account.platform] !== false) {
                        await publishToPlatform(account.platform, account.access_token, account.page_id, instance.content, instance.media_urls);
                    }
                }
                
                await pool.query('UPDATE post_instances SET status = $1, published_at = NOW() WHERE id = $2', ['published', instance.id]);
                
                console.log(`✅ Published instance ${instance.id}`);
            } catch (err) {
                await pool.query('UPDATE post_instances SET status = $1 WHERE id = $2', ['failed', instance.id]);
                console.error(`❌ Failed instance ${instance.id}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Cron error:', error);
    }
});

async function publishToPlatform(platform, accessToken, pageId, content, mediaUrls) {
    // Platform-specific publishing logic would go here
    // This requires integration with each platform's API
    console.log(`Publishing to ${platform}...`);
    
    // Return mock success for now
    return { success: true, platform };
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
        
        const posts = await pool.query('SELECT * FROM scheduled_posts WHERE user_id = $1 ORDER BY scheduled_time DESC LIMIT 10', [req.params.id]);
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
