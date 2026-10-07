# Reel Bridge

Automated social media management platform with AI content generation.

## Features
- 🤖 AI-powered content creation
- 📅 Multi-platform scheduling
- 💳 Stripe & PayPal payments
- 📊 Real-time analytics

## Tech Stack
- Node.js + Express
- PostgreSQL
- Stripe & PayPal APIs

## Setup

1. Clone repo
2. Copy `.env.template` to `.env` and fill values
3. Run `npm install`
4. Run `node server.js`

### Stripe configuration (required for payments)

1. In [Stripe Dashboard](https://dashboard.stripe.com) → Developers → API keys, copy:
   - **Publishable key** → `STRIPE_PUBLISHABLE_KEY`
   - **Secret key** → `STRIPE_SECRET_KEY`
2. Create a webhook endpoint pointing to:
   `https://reelbridge-api.onrender.com/api/stripe-webhook`
   - Events to send: `payment_intent.succeeded`
   - Copy the signing secret → `STRIPE_WEBHOOK_SECRET`
3. (Optional) Create Products/Prices for Starter ($254), Growth ($509), Professional ($849) monthly — the current flow uses dynamic PaymentIntents with the amounts from the frontend, so products are optional.

### Database

Ensure your `users` table has at least:

```sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'customer',
  package TEXT,
  posts_remaining INT DEFAULT 0,
  posts_used INT DEFAULT 0,
  platform_limit INT DEFAULT 3,
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Deploy notes

- Frontend: GitHub Pages / Cloudflare Pages at `reelbridge.site`
- Backend: Render at `reelbridge-api.onrender.com`
- After changing env vars on Render, redeploy the service
