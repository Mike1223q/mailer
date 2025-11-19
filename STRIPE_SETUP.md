# Stripe Integration Setup Guide

## 🔧 Environment Variables Needed

Add these to your `.env` file:

```bash
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
STRIPE_PUBLISHABLE_KEY=pk_test_your_stripe_publishable_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here
```

## 📋 Setup Steps

### 1. Create Stripe Products and Prices

In your Stripe Dashboard, create these products:

**Monthly Premium Plan:**
- Product Name: "Premium Monthly"
- Price: $6.99/month
- Recurring: Monthly
- Copy the Price ID → Replace `price_monthly_placeholder` in code

**6-Month Premium Plan:**
- Product Name: "Premium Half-Year"
- Price: $29.99 every 6 months
- Recurring: Every 6 months
- Copy the Price ID → Replace `price_halfyear_placeholder` in code

**Yearly Premium Plan:**
- Product Name: "Premium Yearly"
- Price: $39.99/year
- Recurring: Yearly
- Copy the Price ID → Replace `price_yearly_placeholder` in code

### 2. Set Up Webhook Endpoint

1. In Stripe Dashboard → Webhooks
2. Add endpoint: `https://yourdomain.com/webhook` (or `http://localhost:3000/webhook` for testing)
3. Select events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `customer.subscription.deleted`
4. Copy webhook secret → Add to `STRIPE_WEBHOOK_SECRET`

### 3. Update Price IDs in Code

In `views/footer-mathes.ejs`, replace these placeholders:

```javascript
const stripePriceIds = {
    'monthly': 'price_1234567890', // Your actual monthly price ID
    'half-year': 'price_0987654321', // Your actual 6-month price ID
    'yearly': 'price_1122334455' // Your actual yearly price ID
};
```

## 🎯 How It Works

### Payment Flow:
1. User clicks "Get Premium" button
2. Creates Stripe checkout session via `/api/create-checkout-session`
3. Redirects to Stripe-hosted checkout page
4. After payment, Stripe sends webhook to `/webhook/stripe`
5. Webhook handler processes payment and activates premium
6. **Referral earnings are automatically calculated and recorded**

### Referral Integration:
- **First subscription**: Triggers referral earning based on user's referrer program
- **Recurring payments**: Processes additional earnings (e.g., $10 retention program)
- **Automatic calculation**: No manual intervention needed

## 🔒 Security Features

- ✅ Webhook signature verification
- ✅ User authentication required
- ✅ Email masking for privacy
- ✅ Secure session management

## 🚀 Ready to Test

Once you provide the test keys, the system will be fully functional with:
- Stripe payment processing
- Automatic referral earnings
- Premium feature activation
- Subscription management
