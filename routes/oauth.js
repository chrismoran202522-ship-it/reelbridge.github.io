const express = require('express');
const router = express.Router();
const passport = require('../oauth/strategies');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Middleware to extract user from JWT and attach to req.user
const attachUser = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Generate OAuth URL for X (Twitter)
router.get('/twitter/url', attachUser, (req, res) => {
    // Generate PKCE parameters
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
    
    // Store code verifier in session/temp storage
    // For stateless, you could encrypt it in a cookie or use Redis
    
    const state = crypto.randomBytes(16).toString('hex');
    
    // Store in database temporarily
    req.app.locals.oauthStates = req.app.locals.oauthStates || {};
    req.app.locals.oauthStates[state] = {
        userId: req.user.userId,
        codeVerifier,
        expires: Date.now() + 600000 // 10 minutes
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
});

// Handle X (Twitter) OAuth callback
router.get('/twitter/callback', async (req, res) => {
    const { code, state } = req.query;
    
    if (!code || !state) {
        return res.redirect('https://reelbridge.site/dashboard?error=oauth_failed');
    }
    
    // Retrieve stored state
    const storedState = req.app.locals.oauthStates?.[state];
    if (!storedState || storedState.expires < Date.now()) {
        return res.redirect('https://reelbridge.site/dashboard?error=state_expired');
    }
    
    // Exchange code for tokens
    try {
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
            throw new Error('No access token received');
        }
        
        // Get user info from X
        const userResponse = await fetch('https://api.twitter.com/2/users/me', {
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`
            }
        });
        
        const userData = await userResponse.json();
        
        // Store in database
        const pool = req.app.locals.db;
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
        delete req.app.locals.oauthStates[state];
        
        // Redirect back to frontend with success
        res.redirect(`https://reelbridge.site/dashboard?platform=twitter&connected=true&username=${userData.data.username}`);
        
    } catch (error) {
        console.error('Twitter OAuth callback error:', error);
        res.redirect('https://reelbridge.site/dashboard?error=oauth_failed&message=' + encodeURIComponent(error.message));
    }
});

// Refresh token endpoint
router.post('/twitter/refresh', attachUser, async (req, res) => {
    try {
        const pool = req.app.locals.db;
        
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
        
        // Update database
        await pool.query(
            'UPDATE social_accounts SET access_token = $1, refresh_token = $2 WHERE user_id = $3 AND platform = $4',
            [newTokens.access_token, newTokens.refresh_token, req.user.userId, 'twitter']
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Token refresh error:', error);
        res.status(500).json({ error: 'Failed to refresh token' });
    }
});

module.exports = router;
