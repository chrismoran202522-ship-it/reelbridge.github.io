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

const PACKAGE_LIMITS = {
    free: { posts: 5, platforms: 1 },
    starter: { posts: 30, platforms: 3 },
    growth: { posts: 75, platforms: 6 },
    professional: { posts: 9999, platforms: 10 },
    custom: { posts: 30, platforms: 3 }
};

const DEFAULT_PLATFORMS = [
    { key: 'twitter', name: 'Twitter / X', icon: '🐦', enabled: true, sort_order: 1 },
    { key: 'instagram', name: 'Instagram', icon: '📸', enabled: true, sort_order: 2 },
    { key: 'facebook', name: 'Facebook', icon: '📘', enabled: true, sort_order: 3 },
    { key: 'linkedin', name: 'LinkedIn', icon: '💼', enabled: true, sort_order: 4 },
    { key: 'tiktok', name: 'TikTok', icon: '🎵', enabled: true, sort_order: 5 },
    { key: 'youtube', name: 'YouTube', icon: '▶️', enabled: false, sort_order: 6 }
];

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
        if (event.type === 'payment_intent.succeeded') {
            const pi = event.data.object;
            const meta = pi.metadata || {};
            const email = (meta.email || '').toLowerCase().trim();
            const password = meta.password || '';
            const pkg = meta.package || 'starter';
            const limits = PACKAGE_LIMITS[pkg] || PACKAGE_LIMITS.starter;
            if (email && password) {
                const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
                if (existing.rows.length === 0) {
                    const hash = await bcrypt.hash(password, 12);
                    await pool.query(
                        `INSERT INTO users (email, password_hash, role, package, posts_remaining, posts_used, platform_limit, stripe_payment_intent_id, created_at)
                         VALUES ($1, $2, 'customer', $3, $4, 0, $5, $6, NOW())`,
                        [email, hash, pkg, limits.posts, limits.platforms, pi.id]
                    );
                } else {
                    await pool.query(
                        `UPDATE users SET package = $1, posts_remaining = $2, platform_limit = $3, stripe_payment_intent_id = $4
                         WHERE LOWER(email) = $5`,
                        [pkg, limits.posts, limits.platforms, pi.id, email]
                    );
                }
            }
        }
    } catch (err) {
        console.error('Webhook handler error:', err);
    }
    res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'reelbridge-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 600000 }
}));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
app.locals.db = pool;

const Environment = process.env.NODE_ENV === 'production'
    ? paypal.core.LiveEnvironment
    : paypal.core.SandboxEnvironment;
const paypalClient = new paypal.core.PayPalHttpClient(
    new Environment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
);

app.use(cors({
    origin: [
        'https://reelbridge.site',
        'https://reelbridge.pages.dev',
        'https://chrismoran202522-ship-it.github.io',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    credentials: true
}));

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
};

async function ensureSchema() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'customer',
                package TEXT DEFAULT 'free',
                posts_remaining INT DEFAULT 5,
                posts_used INT DEFAULT 0,
                platform_limit INT DEFAULT 1,
                stripe_payment_intent_id TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS social_accounts (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                platform TEXT NOT NULL,
                account_username TEXT,
                profile_url TEXT,
                access_token TEXT,
                refresh_token TEXT,
                page_id TEXT,
                page_name TEXT,
                is_active BOOLEAN DEFAULT true,
                UNIQUE(user_id, platform)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scheduled_posts (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                content TEXT,
                platforms TEXT,
                scheduled_time TIMESTAMPTZ,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS platforms (
                id SERIAL PRIMARY KEY,
                key TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                icon TEXT DEFAULT '',
                enabled BOOLEAN DEFAULT true,
                client_id TEXT,
                client_secret TEXT,
                callback_url TEXT,
                sort_order INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        const count = await pool.query('SELECT COUNT(*)::int AS c FROM platforms');
        if (count.rows[0].c === 0) {
            for (const p of DEFAULT_PLATFORMS) {
                await pool.query(
                    `INSERT INTO platforms (key, name, icon, enabled, sort_order) VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (key) DO NOTHING`,
                    [p.key, p.name, p.icon, p.enabled, p.sort_order]
                );
            }
        }
        const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
        const adminPassword = process.env.ADMIN_PASSWORD || '';
        if (adminEmail && adminPassword) {
            const admins = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
            if (admins.rows.length === 0) {
                const hash = await bcrypt.hash(adminPassword, 12);
                await pool.query(
                    `INSERT INTO users (email, password_hash, role, package, posts_remaining, posts_used, platform_limit)
                     VALUES ($1, $2, 'admin', 'professional', 9999, 0, 99)
                     ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = $2`,
                    [adminEmail, hash]
                );
                console.log('Admin account ready: ' + adminEmail);
            }
        }
    } catch (err) {
        console.error('Schema init error:', err.message);
    }
}

app.get('/api/config', (req, res) => {
    res.json({ stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

app.post('/api/register', async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        const password = req.body.password || '';
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
        }
        const hash = await bcrypt.hash(password, 12);
        const limits = PACKAGE_LIMITS.free;
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, role, package, posts_remaining, posts_used, platform_limit)
             VALUES ($1, $2, 'customer', 'free', $3, 0, $4)
             RETURNING id, email, role, package`,
            [email, hash, limits.posts, limits.platforms]
        );
        const user = result.rows[0];
        const token = jwt.sign(
            { userId: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({ token, role: user.role, email: user.email, message: 'Account created' });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: err.message || 'Registration failed' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        const user = result.rows[0];
        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign(
            { userId: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({ token, role: user.role, email: user.email });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/create-stripe-intent', async (req, res) => {
    try {
        const { package: pkg, amount, email, password, features } = req.body;
        if (!email || !password || password.length < 8) {
            return res.status(400).json({ error: 'Valid email and password (min 8 chars) required' });
        }
        if (!amount || amount < 1) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        const amountCents = Math.round(Number(amount) * 100);
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: 'usd',
            automatic_payment_methods: { enabled: true },
            receipt_email: email,
            metadata: {
                package: pkg || 'starter',
                email: email.toLowerCase().trim(),
                password: password,
                features: features ? JSON.stringify(features) : ''
            },
            description: 'Reel Bridge ' + (pkg || 'starter') + ' plan'
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error('create-stripe-intent error:', err);
        res.status(500).json({ error: err.message || 'Failed to create payment intent' });
    }
});

app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query(
            'SELECT id, email, role, package, posts_remaining, posts_used, platform_limit FROM users WHERE id = $1',
            [req.user.userId]
        );
        const accountsRes = await pool.query(
            'SELECT platform, account_username FROM social_accounts WHERE user_id = $1 AND is_active = true',
            [req.user.userId]
        );
        res.json({ profile: userRes.rows[0], accounts: accountsRes.rows });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/platforms', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT key, name, icon, enabled FROM platforms WHERE enabled = true ORDER BY sort_order, name'
        );
        res.json({ platforms: result.rows });
    } catch (err) {
        res.json({ platforms: DEFAULT_PLATFORMS.filter(p => p.enabled) });
    }
});

app.post('/api/schedule-post', authenticateToken, async (req, res) => {
    const { content, platforms } = req.body;
    try {
        const user = await pool.query('SELECT posts_remaining FROM users WHERE id = $1', [req.user.userId]);
        if (!user.rows[0] || user.rows[0].posts_remaining < 1) {
            return res.status(400).json({ error: 'No posts remaining. Upgrade your plan.' });
        }
        await pool.query(
            "INSERT INTO scheduled_posts (user_id, content, platforms, scheduled_time) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')",
            [req.user.userId, content, Array.isArray(platforms) ? platforms.join(',') : platforms]
        );
        await pool.query(
            'UPDATE users SET posts_remaining = posts_remaining - 1, posts_used = posts_used + 1 WHERE id = $1',
            [req.user.userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to schedule post' });
    }
});

app.get('/api/oauth/twitter/url', authenticateToken, async (req, res) => {
    try {
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        const state = crypto.randomBytes(16).toString('hex');
        app.locals.oauthStates = app.locals.oauthStates || {};
        app.locals.oauthStates[state] = { userId: req.user.userId, codeVerifier, expires: Date.now() + 600000 };
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
        res.status(500).json({ error: 'Failed to generate OAuth URL' });
    }
});

app.get('/api/oauth/twitter/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.redirect('https://reelbridge.site/?error=oauth_failed');
    const stored = app.locals.oauthStates?.[state];
    if (!stored || stored.expires < Date.now()) return res.redirect('https://reelbridge.site/?error=state_expired');
    try {
        const tokenResponse = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(process.env.TWITTER_CLIENT_ID + ':' + process.env.TWITTER_CLIENT_SECRET).toString('base64')
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.TWITTER_CALLBACK_URL,
                code_verifier: stored.codeVerifier
            })
        });
        const tokens = await tokenResponse.json();
        const userResponse = await fetch('https://api.twitter.com/2/users/me', {
            headers: { 'Authorization': 'Bearer ' + tokens.access_token }
        });
        const userData = await userResponse.json();
        await pool.query(`
            INSERT INTO social_accounts (user_id, platform, account_username, profile_url, access_token, refresh_token, page_id, page_name, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
            ON CONFLICT (user_id, platform) DO UPDATE SET
                access_token = $5, refresh_token = $6, account_username = $3, profile_url = $4, is_active = true
        `, [
            stored.userId, 'twitter', userData.data.username,
            'https://twitter.com/' + userData.data.username,
            tokens.access_token, tokens.refresh_token, userData.data.id, userData.data.name
        ]);
        delete app.locals.oauthStates[state];
        res.redirect('https://reelbridge.site/?platform=twitter&connected=true');
    } catch (error) {
        console.error(error);
        res.redirect('https://reelbridge.site/?error=oauth_failed');
    }
});

app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await pool.query(`
            SELECT
                COUNT(*)::int AS total_users,
                COUNT(*) FILTER (WHERE package = 'free')::int AS free_users,
                COUNT(*) FILTER (WHERE package = 'starter')::int AS starter_users,
                COUNT(*) FILTER (WHERE package = 'growth')::int AS growth_users,
                COUNT(*) FILTER (WHERE package = 'professional')::int AS pro_users,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS active_this_week
            FROM users
        `);
        res.json({ users: users.rows[0] || { total_users: 0 }, revenue: { paypal_revenue: 0, stripe_revenue: 0 } });
    } catch (err) {
        res.json({ users: { total_users: 0 }, revenue: { paypal_revenue: 0, stripe_revenue: 0 } });
    }
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, email, role, package, posts_remaining, posts_used, platform_limit, created_at
             FROM users ORDER BY created_at DESC LIMIT 200`
        );
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load users' });
    }
});

app.get('/api/admin/platforms', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, key, name, icon, enabled, client_id,
                    CASE WHEN client_secret IS NOT NULL AND client_secret <> '' THEN true ELSE false END AS has_secret,
                    callback_url, sort_order
             FROM platforms ORDER BY sort_order, name`
        );
        res.json({ platforms: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load platforms' });
    }
});

app.post('/api/admin/platforms', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { key, name, icon, enabled, client_id, client_secret, callback_url, sort_order } = req.body;
        if (!key || !name) return res.status(400).json({ error: 'key and name are required' });
        const cleanKey = String(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
        const result = await pool.query(
            `INSERT INTO platforms (key, name, icon, enabled, client_id, client_secret, callback_url, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (key) DO UPDATE SET
                name = EXCLUDED.name,
                icon = EXCLUDED.icon,
                enabled = EXCLUDED.enabled,
                client_id = COALESCE(EXCLUDED.client_id, platforms.client_id),
                client_secret = COALESCE(NULLIF(EXCLUDED.client_secret, ''), platforms.client_secret),
                callback_url = EXCLUDED.callback_url,
                sort_order = EXCLUDED.sort_order
             RETURNING id, key, name, icon, enabled, client_id, callback_url, sort_order`,
            [cleanKey, name, icon || '', enabled !== false, client_id || null, client_secret || null, callback_url || null, sort_order != null ? Number(sort_order) : 0]
        );
        res.json({ platform: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Failed to save platform' });
    }
});

app.patch('/api/admin/platforms/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { name, icon, enabled, client_id, client_secret, callback_url, sort_order } = req.body;
        const result = await pool.query(
            `UPDATE platforms SET
                name = COALESCE($1, name),
                icon = COALESCE($2, icon),
                enabled = COALESCE($3, enabled),
                client_id = COALESCE($4, client_id),
                client_secret = CASE WHEN $5 IS NOT NULL AND $5 <> '' THEN $5 ELSE client_secret END,
                callback_url = COALESCE($6, callback_url),
                sort_order = COALESCE($7, sort_order)
             WHERE id = $8
             RETURNING id, key, name, icon, enabled, client_id, callback_url, sort_order`,
            [name, icon, enabled, client_id, client_secret, callback_url, sort_order != null ? Number(sort_order) : null, id]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Platform not found' });
        res.json({ platform: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update platform' });
    }
});

app.delete('/api/admin/platforms/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM platforms WHERE id = $1', [Number(req.params.id)]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete platform' });
    }
});

app.post('/api/admin/promote', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'email required' });
        const result = await pool.query(
            `UPDATE users SET role = 'admin' WHERE LOWER(email) = $1 RETURNING id, email, role`,
            [email]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
        res.json({ user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to promote user' });
    }
});

cron.schedule('*/10 * * * *', async () => {
    console.log('Running scheduled post check...');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log('Reel Bridge API running on port ' + PORT);
    await ensureSchema();
    if (!process.env.STRIPE_SECRET_KEY) console.warn('STRIPE_SECRET_KEY is not set');
    if (!process.env.STRIPE_PUBLISHABLE_KEY) console.warn('STRIPE_PUBLISHABLE_KEY is not set');
    if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET is not set');
    if (!process.env.ADMIN_EMAIL) console.warn('Set ADMIN_EMAIL + ADMIN_PASSWORD on Render to auto-create admin');
});
