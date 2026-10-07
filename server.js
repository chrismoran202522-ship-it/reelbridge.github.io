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

// Package limits (posts / platforms)
const PACKAGE_LIMITS = {
    starter: { posts: 30, platforms: 3 },
    growth: { posts: 75, platforms: 6 },
    professional: { posts: 9999, platforms: 10 },
    custom: { posts: 30, platforms: 3 }
};

// Stripe webhook MUST use raw body — mount before express.json()
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
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
                const existing = await pool.query(
                    'SELECT id FROM users WHERE LOWER(email) = $1',
                    [email]
                );

                if (existing.rows.length === 0) {
                    const hash = await bcrypt.hash(password, 12);
                    await pool.query(
                        `INSERT INTO users (email, password_hash, role, package, posts_remaining, posts_used, platform_limit, stripe_payment_intent_id, created_at)
                         VALUES ($1, $2, 'customer', $3, $4, 0, $5, $6, NOW())`,
                        [email, hash, pkg, limits.posts, limits.platforms, pi.id]
                    );
                    console.log(`✅ Created user ${email} for package ${pkg}`);
                } else {
                    // Existing user — refresh package / posts
                    await pool.query(
                        `UPDATE users SET package = $1, posts_remaining = $2, platform_limit = $3, stripe_payment_intent_id = $4
                         WHERE LOWER(email) = $5`,
                        [pkg, limits.posts, limits.platforms, pi.id, email]
                    );
                    console.log(`✅ Updated user ${email} package to ${pkg}`);
                }
            }
        }
    } catch (err) {
        console.error('Webhook handler error:', err);
        // Still return 200 so Stripe does not retry endlessly for logic errors
    }

    res.json({ received: true });
});

// Middleware (after webhook)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session for OAuth
app.use(session({
    secret: process.env.SESSION_SECRET || 'reelbridge-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 600000
    }
}));

// Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.locals.db = pool;

// PayPal Setup
const Environment = process.env.NODE_ENV === 'production'
    ? paypal.core.LiveEnvironment
    : paypal.core.SandboxEnvironment;

const paypalClient = new paypal.core.PayPalHttpClient(
    new Environment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
);

// CORS
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

// JWT Auth Middleware
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

// ====================== PUBLIC CONFIG ======================
// Safe to expose — publishable key is designed for client-side use
app.get('/api/config', (req, res) => {
    res.json({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || ''
    });
});

// ====================== STRIPE PAYMENT INTENT ======================
app.post('/api/create-stripe-intent', async (req, res) => {
    try {
        const { package: pkg, amount, email, password, features } = req.body;

        if (!email || !password || password.length < 8) {
            return res.status(400).json({ error: 'Valid email and password (min 8 chars) required' });
        }
        if (!amount || amount < 1) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // Amount is in dollars from the frontend → convert to cents
        const amountCents = Math.round(Number(amount) * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: 'usd',
            automatic_payment_methods: { enabled: true },
            receipt_email: email,
            metadata: {
                package: pkg || 'starter',
                email: email.toLowerCase().trim(),
                // Password is stored only long enough for the webhook to hash & create the user.
                // Prefer a short-lived signup token in production; this matches the existing flow.
                password: password,
                features: features ? JSON.stringify(features) : ''
            },
            description: `Reel Bridge ${pkg || 'starter'} plan`
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error('create-stripe-intent error:', err);
        res.status(500).json({ error: err.message || 'Failed to create payment intent' });
    }
});

// ====================== OAUTH ROUTES ======================
app.get('/api/oauth/twitter/url', authenticateToken, async (req, res) => {
    try {
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        const state = crypto.randomBytes(16).toString('hex');

        app.locals.oauthStates = app.locals.oauthStates || {};
        app.locals.oauthStates[state] = {
            userId: req.user.userId,
            codeVerifier,
            expires: Date.now() + 600000
        };

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
    if (!code || !state) return res.redirect('https://reelbridge.site/dashboard?error=oauth_failed');

    const stored = app.locals.oauthStates?.[state];
    if (!stored || stored.expires < Date.now()) return res.redirect('https://reelbridge.site/dashboard?error=state_expired');

    try {
        const tokenResponse = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(`${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`).toString('base64')
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
            headers: { 'Authorization': `Bearer ${tokens.access_token}` }
        });
        const userData = await userResponse.json();

        await pool.query(`
            INSERT INTO social_accounts (user_id, platform, account_username, profile_url, access_token, refresh_token, page_id, page_name, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
            ON CONFLICT (user_id, platform) DO UPDATE SET
                access_token = $5, refresh_token = $6, account_username = $3, profile_url = $4, is_active = true
        `, [
            stored.userId, 'twitter', userData.data.username,
            `https://twitter.com/${userData.data.username}`,
            tokens.access_token, tokens.refresh_token, userData.data.id, userData.data.name
        ]);

        delete app.locals.oauthStates[state];
        res.redirect(`https://reelbridge.site/dashboard?platform=twitter&connected=true`);
    } catch (error) {
        console.error(error);
        res.redirect('https://reelbridge.site/dashboard?error=oauth_failed');
    }
});

// ====================== AUTH ROUTES ======================
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

        res.json({ token, role: user.role });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ====================== USER PROFILE ======================
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query(
            'SELECT id, email, role, package, posts_remaining, posts_used, platform_limit FROM users WHERE id = $1',
            [req.user.userId]
        );
        const accountsRes = await pool.query(
            'SELECT platform, account_username FROM social_accounts WHERE user_id = $1',
            [req.user.userId]
        );

        res.json({
            profile: userRes.rows[0],
            accounts: accountsRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ====================== SCHEDULE POST ======================
app.post('/api/schedule-post', authenticateToken, async (req, res) => {
    const { content, platforms } = req.body;
    try {
        const user = await pool.query('SELECT posts_remaining FROM users WHERE id = $1', [req.user.userId]);
        if (user.rows[0].posts_remaining < 1) {
            return res.status(400).json({ error: 'No posts remaining' });
        }

        await pool.query(
            "INSERT INTO scheduled_posts (user_id, content, platforms, scheduled_time) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')",
            [req.user.userId, content, platforms]
        );

        await pool.query('UPDATE users SET posts_remaining = posts_remaining - 1, posts_used = posts_used + 1 WHERE id = $1', [req.user.userId]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to schedule post' });
    }
});

// ====================== ADMIN ROUTES ======================
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await pool.query(`
            SELECT
                COUNT(*)::int AS total_users,
                COUNT(*) FILTER (WHERE package = 'starter')::int AS starter_users,
                COUNT(*) FILTER (WHERE package = 'growth')::int AS growth_users,
                COUNT(*) FILTER (WHERE package = 'professional')::int AS pro_users,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS active_this_week
            FROM users
        `);
        res.json({
            users: users.rows[0] || { total_users: 0 },
            revenue: { paypal_revenue: 0, stripe_revenue: 0 }
        });
    } catch (err) {
        res.json({ users: { total_users: 0 }, revenue: { paypal_revenue: 0, stripe_revenue: 0 } });
    }
});

// ====================== CRON JOB - AUTO POSTING ======================
cron.schedule('*/10 * * * *', async () => {
    console.log('Running scheduled post check...');
    // Your posting logic here (Twitter posting is ready)
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Reel Bridge API running on port ${PORT}`);
    console.log(`Frontend: https://reelbridge.site`);
    console.log(`Backend: https://reelbridge-api.onrender.com`);
    if (!process.env.STRIPE_SECRET_KEY) console.warn('⚠️  STRIPE_SECRET_KEY is not set');
    if (!process.env.STRIPE_PUBLISHABLE_KEY) console.warn('⚠️  STRIPE_PUBLISHABLE_KEY is not set');
    if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('⚠️  STRIPE_WEBHOOK_SECRET is not set');
});
