require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypal = require('@paypal/checkout-server-sdk');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// Built-in parsers (no extra package needed)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 20,
    keepAlive: true
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

// CORS - allow your frontend domains + localhost for dev
app.use(cors({
    origin: [
        'https://reelbridge.pages.dev',
        'https://reelbridge.site',
        'https://www.reelbridge.site',
        'http://localhost:3000',
        'http://localhost:5500'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());

// JWT authentication middleware
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

// Temporary in-memory store for OAuth state + code_verifier (replace with Redis/DB in production)
const oauthStore = new Map(); // key: state → { codeVerifier, userId, platform }

// ────────────────────────────────────────────────
// X / Twitter OAuth 2.0 with PKCE
// ────────────────────────────────────────────────

// 1. Frontend calls this to get the authorization URL
app.get('/api/oauth/x/url', authenticateToken, (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

    const authUrl = `https://x.com/i/oauth2/authorize?` +
        `response_type=code` +
        `&client_id=${process.env.X_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(process.env.X_REDIRECT_URI)}` +
        `&scope=tweet.read%20tweet.write%20users.read%20offline.access` +
        `&state=${state}` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256`;

    // Store temporarily (in real app → associate with user session / JWT)
    oauthStore.set(state, {
        codeVerifier,
        userId: req.user.userId,   // from JWT
        platform: 'x'
    });

    res.json({ url: authUrl });
});

// 2. X redirects here after user approves
app.get('/oauth/callback/x', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.send(`
            <script>
                window.opener.postMessage({ error: 'authorization_denied' }, '*');
                window.close();
            </script>
        `);
    }

    const stored = oauthStore.get(state);
    if (!stored || stored.platform !== 'x') {
        return res.send(`
            <script>
                window.opener.postMessage({ error: 'invalid_state' }, '*');
                window.close();
            </script>
        `);
    }

    try {
        const tokenResponse = await axios.post('https://api.x.com/2/oauth2/token', null, {
            params: {
                code,
                grant_type: 'authorization_code',
                client_id: process.env.X_CLIENT_ID,
                redirect_uri: process.env.X_REDIRECT_URI,
                code_verifier: stored.codeVerifier
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'Basic ' + Buffer.from(`\( {process.env.X_CLIENT_ID}: \){process.env.X_CLIENT_SECRET}`).toString('base64')
            }
        });

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        // Save tokens to your social_accounts table
        await pool.query(`
            INSERT INTO social_accounts (
                user_id, platform, access_token, refresh_token, connected_at, is_active
            ) VALUES ($1, $2, $3, $4, NOW(), true)
            ON CONFLICT (user_id, platform) 
            DO UPDATE SET 
                access_token = EXCLUDED.access_token,
                refresh_token = EXCLUDED.refresh_token,
                connected_at = NOW(),
                is_active = true
        `, [stored.userId, 'x', access_token, refresh_token]);

        // Clean up
        oauthStore.delete(state);

        // Tell frontend popup: success!
        res.send(`
            <script>
                window.opener.postMessage({ 
                    success: true, 
                    platform: 'x',
                    message: 'X account connected successfully!'
                }, '*');
                window.close();
            </script>
        `);
    } catch (err) {
        console.error('Token exchange failed:', err.response?.data || err.message);
        res.send(`
            <script>
                window.opener.postMessage({ error: 'token_exchange_failed' }, '*');
                window.close();
            </script>
        `);
    }
});

// ────────────────────────────────────────────────
// Your existing routes continue here...
// ────────────────────────────────────────────────

// (Paste all your original routes below this point - login, payments, posts, admin, cron, etc.)

// Example placeholder for publish function (expand as needed)
async function publishToPlatform(platform, accessToken, pageId, content, mediaUrls) {
    console.log(`Publishing to ${platform} with token...`);
    // Real implementation would go here (e.g. axios.post to X API v2)
    return { success: true, platform };
}

// Your cron job, admin routes, messages, etc. remain unchanged...

// Schema updates, initDatabase, etc. remain unchanged...

// Start server
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
