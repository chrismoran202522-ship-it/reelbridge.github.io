const express = require('express');
const stripe = require('stripe')('sk_test_YOUR_SECRET_KEY'); // Replace with your secret key
const app = express();

app.use(express.json());
app.use(express.static('public'));

// Create payment intent
app.post('/create-payment-intent', async (req, res) => {
    const { package, amount, email, billingCycle } = req.body;
    
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount * 100, // Convert to cents
            currency: 'usd',
            receipt_email: email,
            metadata: {
                package: package,
                billingCycle: billingCycle,
                customer_email: email
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
    const endpointSecret = 'whsec_YOUR_WEBHOOK_SECRET';
    
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        // Send confirmation email, create account, etc.
        console.log('Payment succeeded:', paymentIntent.metadata);
    }
    
    res.json({received: true});
});

app.listen(3000, () => console.log('Server running on port 3000'));

