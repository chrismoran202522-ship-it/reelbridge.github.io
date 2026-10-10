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
const SITE_URL = process.env.SITE_URL || 'https://reelbridge.site';
const API_BASE = process.env.API_BASE || 'https://reelbridge-github-io.onrender.com';

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

// OAuth provider definitions (auth URL, token URL, scopes, user info)
const OAUTH_PROVIDERS = {
    twitter: {
        authUrl: 'https://twitter.com/i/oauth2/authorize',
        tokenUrl: 'https://api.twitter.com/2/oauth2/token',
        userInfoUrl: 'https://api.twitter.com/2/users/me',
        scopes: 'tweet.read tweet.write users.read offline.access',
        usePkce: true,
        clientIdEnv: 'TWITTER_CLIENT_ID',
        clientSecretEnv: 'TWITTER_CLIENT_SECRET',
        callbackEnv: 'TWITTER_CALLBACK_URL',
        defaultCallback: () => API_BASE + '/api/oauth/twitter/callback'
    },
    facebook: {
        authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
        userInfoUrl: 'https://graph.facebook.com/me?fields=id,name,link',
        scopes: 'pages_show_list,pages_read_engagement,pages_manage_posts,public_profile',
        usePkce: false,
        clientIdEnv: 'FACEBOOK_APP_ID',
        clientSecretEnv: 'FACEBOOK_APP_SECRET',
        callbackEnv: 'FACEBOOK_CALLBACK_URL',
        defaultCallback: () => API_BASE + '/api/oauth/facebook/callback'
    },
    instagram: {
        // Instagram content posting typically uses Facebook Login + Instagram Graph
        authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
        userInfoUrl: 'https://graph.facebook.com/me?fields=id,name',
        scopes: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
        usePkce: false,
        clientIdEnv: 'INSTAGRAM_APP_ID',
        clientSecretEnv: 'INSTAGRAM_APP_SECRET',
        callbackEnv: 'INSTAGRAM_CALLBACK_URL',
        defaultCallback: () => API_BASE + '/api/oauth/instagram/callback',
        // fallback to Facebook app credentials
        fallbackClientIdEnv: 'FACEBOOK_APP_ID',
        fallbackClientSecretEnv: 'FACEBOOK_APP_SECRET'
    },
    linkedin: {
        authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
        tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
        userInfoUrl: 'https://api.linkedin.com/v2/userinfo',
        scopes: 'openid profile w_member_social',
        usePkce: false,
        clientIdEnv: 'LINKEDIN_CLIENT_ID',
        clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
        callbackEnv: 'LINKEDIN_CALLBACK_URL',
        defaultCallback: () => API_BASE + '/api/oauth/linkedin/callback'
    },
    tiktok: {
        authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
        tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
        userInfoUrl: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',
        scopes: 'user.info.basic,video.publish,video.upload',
        usePkce: false,
        clientIdEnv: 'TIKTOK_CLIENT_KEY',
        clientSecretEnv: 'TIKTOK_CLIENT_SECRET',
        callbackEnv: 'TIKTOK_CALLBACK_URL',
        defaultCallback: () => API_BASE + '/api/oauth/tiktok/callback'
    }
};

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send('Webhook Error: ' + err.message);
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
                        `UPDATE users SET package = $1, posts_remaining = $2, platform_limit = $3, stripe_payment_intent_id = $4 WHERE LOWER(email) = $5`,
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
    secret: process.env.SESSION_SECRET || process.env.JWT_SECRET || 'reelbridge-secret-change-in-prod',
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
        // Sync default callback URLs if empty
        for (const [key, prov] of Object.entries(OAUTH_PROVIDERS)) {
            await pool.query(
                `UPDATE platforms SET callback_url = $1 WHERE key = $2 AND (callback_url IS NULL OR callback_url = '')`,
                [prov.defaultCallback(), key]
            );
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

/** Resolve OAuth client credentials: env first, then platforms table */
async function getPlatformCredentials(platformKey) {
    const prov = OAUTH_PROVIDERS[platformKey];
    if (!prov) return null;

    let clientId = process.env[prov.clientIdEnv] || '';
    let clientSecret = process.env[prov.clientSecretEnv] || '';
    let callbackUrl = process.env[prov.callbackEnv] || prov.defaultCallback();

    if (prov.fallbackClientIdEnv && !clientId) {
        clientId = process.env[prov.fallbackClientIdEnv] || '';
        clientSecret = process.env[prov.fallbackClientSecretEnv] || clientSecret;
    }

    try {
        const row = await pool.query('SELECT client_id, client_secret, callback_url FROM platforms WHERE key = $1', [platformKey]);
        if (row.rows[0]) {
            if (!clientId && row.rows[0].client_id) clientId = row.rows[0].client_id;
            if (!clientSecret && row.rows[0].client_secret) clientSecret = row.rows[0].client_secret;
            if (row.rows[0].callback_url) callbackUrl = row.rows[0].callback_url;
        }
    } catch (_) {}

    return { clientId, clientSecret, callbackUrl, prov };
}

async function saveSocialAccount(userId, platform, data) {
    await pool.query(`
        INSERT INTO social_accounts (user_id, platform, account_username, profile_url, access_token, refresh_token, page_id, page_name, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        ON CONFLICT (user_id, platform) DO UPDATE SET
            access_token = $5, refresh_token = $6, account_username = $3, profile_url = $4,
            page_id = $7, page_name = $8, is_active = true
    `, [
        userId, platform,
        data.username || null,
        data.profileUrl || null,
        data.accessToken || null,
        data.refreshToken || null,
        data.pageId || null,
        data.pageName || null
    ]);
}

// ====================== PUBLIC ======================
app.get('/api/config', (req, res) => {
    res.json({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
        apiBase: API_BASE,
        siteUrl: SITE_URL
    });
});

app.post('/api/register', async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        const password = req.body.password || '';
        if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
        if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
        const hash = await bcrypt.hash(password, 12);
        const limits = PACKAGE_LIMITS.free;
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, role, package, posts_remaining, posts_used, platform_limit)
             VALUES ($1, $2, 'customer', 'free', $3, 0, $4) RETURNING id, email, role, package`,
            [email, hash, limits.posts, limits.platforms]
        );
        const user = result.rows[0];
        const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
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
        const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
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
        if (!amount || amount < 1) return res.status(400).json({ error: 'Invalid amount' });
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
            'SELECT platform, account_username, profile_url FROM social_accounts WHERE user_id = $1 AND is_active = true',
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
        if (!content || !String(content).trim()) {
            return res.status(400).json({ error: 'Post content is required' });
        }
        const user = await pool.query('SELECT posts_remaining FROM users WHERE id = $1', [req.user.userId]);
        if (!user.rows[0] || user.rows[0].posts_remaining < 1) {
            return res.status(400).json({ error: 'No posts remaining. Upgrade your plan.' });
        }
        const platformsStr = Array.isArray(platforms) ? platforms.join(',') : (platforms || 'twitter');

        // Schedule for now so the worker can publish ASAP
        const ins = await pool.query(
            `INSERT INTO scheduled_posts (user_id, content, platforms, scheduled_time, status)
             VALUES ($1, $2, $3, NOW(), 'pending') RETURNING id`,
            [req.user.userId, content, platformsStr]
        );
        await pool.query(
            'UPDATE users SET posts_remaining = posts_remaining - 1, posts_used = posts_used + 1 WHERE id = $1',
            [req.user.userId]
        );

        // Try to publish immediately
        const postId = ins.rows[0].id;
        const results = await publishPost(req.user.userId, content, platformsStr);
        const anyOk = results.some(r => r.success);
        await pool.query(
            `UPDATE scheduled_posts SET status = $1 WHERE id = $2`,
            [anyOk ? 'posted' : 'failed', postId]
        );

        res.json({
            success: anyOk,
            postId,
            results,
            message: anyOk ? 'Posted successfully' : 'Saved but publishing failed — check connected accounts and Twitter API access'
        });
    } catch (err) {
        console.error('schedule-post error:', err);
        res.status(500).json({ error: err.message || 'Failed to schedule post' });
    }
});

app.delete('/api/social-accounts/:platform', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            'UPDATE social_accounts SET is_active = false WHERE user_id = $1 AND platform = $2',
            [req.user.userId, req.params.platform]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

// ====================== GENERIC OAUTH ======================
app.get('/api/oauth/:platform/url', authenticateToken, async (req, res) => {
    const platform = (req.params.platform || '').toLowerCase();
    const creds = await getPlatformCredentials(platform);
    if (!creds || !creds.prov) {
        return res.status(400).json({ error: 'Unsupported platform: ' + platform });
    }
    if (!creds.clientId) {
        return res.status(400).json({
            error: platform + ' is not configured. Add Client ID in Admin → Platforms or set env ' + creds.prov.clientIdEnv
        });
    }
    try {
        const state = crypto.randomBytes(16).toString('hex');
        app.locals.oauthStates = app.locals.oauthStates || {};
        const stateData = {
            userId: req.user.userId,
            platform,
            expires: Date.now() + 600000
        };

        const authUrl = new URL(creds.prov.authUrl);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', creds.clientId);
        authUrl.searchParams.set('redirect_uri', creds.callbackUrl);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('scope', creds.prov.scopes);

        if (creds.prov.usePkce) {
            const codeVerifier = crypto.randomBytes(32).toString('base64url');
            const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
            stateData.codeVerifier = codeVerifier;
            authUrl.searchParams.set('code_challenge', codeChallenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');
        }

        // TikTok uses client_key instead of client_id
        if (platform === 'tiktok') {
            authUrl.searchParams.delete('client_id');
            authUrl.searchParams.set('client_key', creds.clientId);
        }

        app.locals.oauthStates[state] = stateData;
        res.json({ url: authUrl.toString(), state, platform });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to generate OAuth URL' });
    }
});

app.get('/api/oauth/:platform/callback', async (req, res) => {
    const platform = (req.params.platform || '').toLowerCase();
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect(SITE_URL + '/?error=oauth_denied&platform=' + platform);
    if (!code || !state) return res.redirect(SITE_URL + '/?error=oauth_failed&platform=' + platform);

    const stored = app.locals.oauthStates?.[state];
    if (!stored || stored.expires < Date.now() || stored.platform !== platform) {
        return res.redirect(SITE_URL + '/?error=state_expired&platform=' + platform);
    }

    const creds = await getPlatformCredentials(platform);
    if (!creds || !creds.clientId || !creds.clientSecret) {
        return res.redirect(SITE_URL + '/?error=oauth_not_configured&platform=' + platform);
    }

    try {
        let tokens = {};
        let username = '';
        let profileUrl = '';
        let pageId = '';
        let pageName = '';

        if (platform === 'twitter') {
            const tokenResponse = await fetch(creds.prov.tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(creds.clientId + ':' + creds.clientSecret).toString('base64')
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: creds.callbackUrl,
                    code_verifier: stored.codeVerifier
                })
            });
            tokens = await tokenResponse.json();
            if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
            const userResponse = await fetch(creds.prov.userInfoUrl, {
                headers: { 'Authorization': 'Bearer ' + tokens.access_token }
            });
            const userData = await userResponse.json();
            username = userData.data?.username || '';
            pageId = userData.data?.id || '';
            pageName = userData.data?.name || username;
            profileUrl = username ? 'https://twitter.com/' + username : '';
        } else if (platform === 'facebook' || platform === 'instagram') {
            const tokenUrl = new URL(creds.prov.tokenUrl);
            tokenUrl.searchParams.set('client_id', creds.clientId);
            tokenUrl.searchParams.set('client_secret', creds.clientSecret);
            tokenUrl.searchParams.set('redirect_uri', creds.callbackUrl);
            tokenUrl.searchParams.set('code', code);
            const tokenResponse = await fetch(tokenUrl.toString());
            tokens = await tokenResponse.json();
            if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
            const userResponse = await fetch(
                'https://graph.facebook.com/me?fields=id,name,link&access_token=' + encodeURIComponent(tokens.access_token)
            );
            const userData = await userResponse.json();
            username = userData.name || userData.id || '';
            pageId = userData.id || '';
            pageName = userData.name || '';
            profileUrl = userData.link || ('https://facebook.com/' + pageId);
        } else if (platform === 'linkedin') {
            const tokenResponse = await fetch(creds.prov.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: creds.callbackUrl,
                    client_id: creds.clientId,
                    client_secret: creds.clientSecret
                })
            });
            tokens = await tokenResponse.json();
            if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
            const userResponse = await fetch(creds.prov.userInfoUrl, {
                headers: { 'Authorization': 'Bearer ' + tokens.access_token }
            });
            const userData = await userResponse.json();
            username = userData.name || userData.email || userData.sub || '';
            pageId = userData.sub || '';
            pageName = userData.name || username;
            profileUrl = userData.picture || '';
        } else if (platform === 'tiktok') {
            const tokenResponse = await fetch(creds.prov.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_key: creds.clientId,
                    client_secret: creds.clientSecret,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: creds.callbackUrl
                })
            });
            tokens = await tokenResponse.json();
            const accessToken = tokens.access_token || tokens.data?.access_token;
            if (!accessToken) throw new Error(JSON.stringify(tokens));
            tokens.access_token = accessToken;
            tokens.refresh_token = tokens.refresh_token || tokens.data?.refresh_token;
            const userResponse = await fetch(creds.prov.userInfoUrl, {
                headers: { 'Authorization': 'Bearer ' + accessToken }
            });
            const userData = await userResponse.json();
            const u = userData.data?.user || userData.user || {};
            username = u.display_name || u.open_id || '';
            pageId = u.open_id || '';
            pageName = u.display_name || '';
            profileUrl = u.avatar_url || '';
        } else {
            throw new Error('Unsupported platform callback');
        }

        await saveSocialAccount(stored.userId, platform, {
            username,
            profileUrl,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || null,
            pageId,
            pageName
        });

        delete app.locals.oauthStates[state];
        res.redirect(SITE_URL + '/?platform=' + platform + '&connected=true');
    } catch (error) {
        console.error('OAuth callback error (' + platform + '):', error);
        res.redirect(SITE_URL + '/?error=oauth_failed&platform=' + platform);
    }
});

// ====================== ADMIN ======================
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
                name = EXCLUDED.name, icon = EXCLUDED.icon, enabled = EXCLUDED.enabled,
                client_id = COALESCE(EXCLUDED.client_id, platforms.client_id),
                client_secret = COALESCE(NULLIF(EXCLUDED.client_secret, ''), platforms.client_secret),
                callback_url = EXCLUDED.callback_url, sort_order = EXCLUDED.sort_order
             RETURNING id, key, name, icon, enabled, client_id, callback_url, sort_order`,
            [cleanKey, name, icon || '', enabled !== false, client_id || null, client_secret || null, callback_url || null, sort_order != null ? Number(sort_order) : 0]
        );
        res.json({ platform: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to save platform' });
    }
});

app.patch('/api/admin/platforms/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { name, icon, enabled, client_id, client_secret, callback_url, sort_order } = req.body;
        const result = await pool.query(
            `UPDATE platforms SET
                name = COALESCE($1, name), icon = COALESCE($2, icon), enabled = COALESCE($3, enabled),
                client_id = COALESCE($4, client_id),
                client_secret = CASE WHEN $5 IS NOT NULL AND $5 <> '' THEN $5 ELSE client_secret END,
                callback_url = COALESCE($6, callback_url), sort_order = COALESCE($7, sort_order)
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


// ====================== ACTUAL SOCIAL POSTING ======================
async function refreshTwitterToken(userId, refreshToken) {
    if (!refreshToken) throw new Error('No Twitter refresh token');
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(
                (process.env.TWITTER_CLIENT_ID || '') + ':' + (process.env.TWITTER_CLIENT_SECRET || '')
            ).toString('base64')
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        })
    });
    const tokens = await response.json();
    if (!tokens.access_token) throw new Error('Twitter token refresh failed: ' + JSON.stringify(tokens));
    await pool.query(
        'UPDATE social_accounts SET access_token = $1, refresh_token = COALESCE($2, refresh_token) WHERE user_id = $3 AND platform = $4',
        [tokens.access_token, tokens.refresh_token || null, userId, 'twitter']
    );
    return tokens.access_token;
}

async function postToTwitter(userId, content) {
    const result = await pool.query(
        'SELECT access_token, refresh_token, account_username FROM social_accounts WHERE user_id = $1 AND platform = $2 AND is_active = true',
        [userId, 'twitter']
    );
    if (!result.rows[0]) throw new Error('Twitter account not connected for this user');
    let { access_token, refresh_token, account_username } = result.rows[0];

    async function send(token) {
        const response = await fetch('https://api.twitter.com/2/tweets', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text: content })
        });
        const body = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, body };
    }

    let res = await send(access_token);
    if (res.status === 401 && refresh_token) {
        access_token = await refreshTwitterToken(userId, refresh_token);
        res = await send(access_token);
    }
    if (!res.ok) {
        const detail = res.body?.detail || res.body?.title || JSON.stringify(res.body);
        throw new Error('Twitter post failed (' + res.status + '): ' + detail);
    }
    return { platform: 'twitter', username: account_username, tweet: res.body };
}

async function publishPost(userId, content, platformsList) {
    const results = [];
    const platforms = (Array.isArray(platformsList) ? platformsList : String(platformsList || '').split(','))
        .map(p => p.trim().toLowerCase()).filter(Boolean);

    for (const platform of platforms) {
        try {
            if (platform === 'twitter') {
                const r = await postToTwitter(userId, content);
                results.push({ platform, success: true, data: r });
            } else {
                results.push({
                    platform,
                    success: false,
                    error: platform + ' posting not implemented yet (connect works; publish API pending)'
                });
            }
        } catch (err) {
            console.error('Publish error', platform, err.message);
            results.push({ platform, success: false, error: err.message });
        }
    }
    return results;
}

async function processDuePosts() {
    try {
        const due = await pool.query(
            `SELECT id, user_id, content, platforms FROM scheduled_posts
             WHERE status = 'pending' AND scheduled_time <= NOW()
             ORDER BY scheduled_time ASC LIMIT 20`
        );
        for (const row of due.rows) {
            console.log('Publishing scheduled post', row.id, 'for user', row.user_id);
            const results = await publishPost(row.user_id, row.content, row.platforms);
            const anyOk = results.some(r => r.success);
            await pool.query(
                `UPDATE scheduled_posts SET status = $1 WHERE id = $2`,
                [anyOk ? 'posted' : 'failed', row.id]
            );
            console.log('Post', row.id, anyOk ? 'posted' : 'failed', JSON.stringify(results));
        }
    } catch (err) {
        console.error('processDuePosts error:', err.message);
    }
}

// List current user's scheduled posts
app.get('/api/scheduled-posts', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, content, platforms, scheduled_time, status, created_at
             FROM scheduled_posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
            [req.user.userId]
        );
        res.json({ posts: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load posts' });
    }
});

// Admin: see all recent scheduled posts
app.get('/api/admin/scheduled-posts', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT sp.id, sp.content, sp.platforms, sp.scheduled_time, sp.status, sp.created_at, u.email
             FROM scheduled_posts sp JOIN users u ON u.id = sp.user_id
             ORDER BY sp.created_at DESC LIMIT 100`
        );
        res.json({ posts: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load posts' });
    }
});

// Admin: force process due posts now
app.post('/api/admin/process-posts', authenticateToken, requireAdmin, async (req, res) => {
    await processDuePosts();
    res.json({ success: true, message: 'Processed due posts' });
});

cron.schedule('* * * * *', async () => {
    await processDuePosts();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log('Reel Bridge API running on port ' + PORT);
    await ensureSchema();
    if (!process.env.JWT_SECRET) console.warn('JWT_SECRET is not set');
    if (!process.env.TWITTER_CLIENT_ID) console.warn('TWITTER_CLIENT_ID not set — Twitter connect disabled until configured');
    // Process any backlog shortly after boot
    setTimeout(() => processDuePosts(), 5000);
});
