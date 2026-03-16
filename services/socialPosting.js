const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

class SocialPostingService {
    async postToTwitter(userId, content, mediaIds = []) {
        try {
            // Get access token
            const result = await pool.query(
                'SELECT access_token, refresh_token FROM social_accounts WHERE user_id = $1 AND platform = $2 AND is_active = true',
                [userId, 'twitter']
            );
            
            if (!result.rows[0]) {
                throw new Error('Twitter account not connected');
            }
            
            let { access_token, refresh_token } = result.rows[0];
            
            // Try to post
            const postData = {
                text: content
            };
            
            // Add media if provided
            if (mediaIds.length > 0) {
                // First upload media to Twitter
                const mediaKeys = await this.uploadMediaToTwitter(access_token, mediaIds);
                postData.media = { media_keys: mediaKeys };
            }
            
            const response = await fetch('https://api.twitter.com/2/tweets', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(postData)
            });
            
            if (response.status === 401) {
                // Token expired, try to refresh
                access_token = await this.refreshTwitterToken(userId, refresh_token);
                
                // Retry post
                const retryResponse = await fetch('https://api.twitter.com/2/tweets', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${access_token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(postData)
                });
                
                if (!retryResponse.ok) {
                    throw new Error('Failed to post after token refresh');
                }
                
                return await retryResponse.json();
            }
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to post to Twitter');
            }
            
            return await response.json();
            
        } catch (error) {
            console.error('Twitter posting error:', error);
            throw error;
        }
    }
    
    async refreshTwitterToken(userId, refreshToken) {
        const response = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(
                    `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
                ).toString('base64')
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });
        
        const tokens = await response.json();
        
        // Update database
        await pool.query(
            'UPDATE social_accounts SET access_token = $1, refresh_token = $2 WHERE user_id = $3 AND platform = $4',
            [tokens.access_token, tokens.refresh_token, userId, 'twitter']
        );
        
        return tokens.access_token;
    }
    
    async uploadMediaToTwitter(accessToken, mediaUrls) {
        // Implementation for media upload using Twitter API v2
        // This requires multipart/form-data uploads to https://upload.twitter.com/1.1/media/upload.json
        // Then return media_keys for the v2 API
        return [];
    }
}

module.exports = new SocialPostingService();
