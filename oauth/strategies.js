const passport = require('passport');
const TwitterStrategy = require('@superfaceai/passport-twitter-oauth2').Strategy;
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Serialize user for session
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        done(null, result.rows[0]);
    } catch (err) {
        done(err, null);
    }
});

// X (Twitter) OAuth 2.0 Strategy
passport.use('twitter', new TwitterStrategy({
    clientID: process.env.TWITTER_CLIENT_ID,
    clientSecret: process.env.TWITTER_CLIENT_SECRET,
    clientType: 'confidential',
    callbackURL: process.env.TWITTER_CALLBACK_URL,
    passReqToCallback: true
}, async (req, accessToken, refreshToken, profile, done) => {
    try {
        // Store tokens in database
        const userId = req.user.userId; // From JWT middleware
        
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
            userId,
            'twitter',
            profile.username,
            profile.profileUrl,
            accessToken,
            refreshToken,
            profile.id,
            profile.displayName
        ]);
        
        return done(null, { 
            success: true, 
            platform: 'twitter',
            username: profile.username 
        });
    } catch (error) {
        return done(error, null);
    }
}));

module.exports = passport;
