# Stripe Environment Variables Setup

## Required Environment Variables

Add these to your `.env` file:

### Stripe API Keys
```bash
STRIPE_PUBLISHABLE_KEY=pk_test_your_publishable_key
STRIPE_SECRET_KEY=sk_test_your_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
```

### Subscription Price IDs
```bash
STRIPE_PRICE_MONTHLY_SUB=price_1...     # Monthly Premium ($6.99)
STRIPE_PRICE_HALF_YEAR_SUB=price_1...   # 6-Month Premium ($29.99)
STRIPE_PRICE_YEARLY_SUB=price_1...      # Yearly Premium ($39.99)
```

### One-Time Purchase Price IDs - Coins
```bash
STRIPE_PRICE_BASIC_COINS=price_1...     # Starter Pack - 250 coins ($0.99)
STRIPE_PRICE_POPULAR_COINS=price_1...   # Popular Pack - 750 coins ($2.49)
STRIPE_PRICE_PREMIUM_COINS=price_1...   # Premium Pack - 1,500 coins ($4.99)
STRIPE_PRICE_MEGA_COINS=price_1...      # Mega Pack - 3,500 coins ($9.99)
```

### One-Time Purchase Price IDs - Letter Credits
```bash
STRIPE_PRICE_LETTER_CREDITS=price_1...          # Letter Credit - 1 credit ($2.99)
STRIPE_PRICE_LETTER_CREDITS_DISCOUNT=price_1... # Letter Credit Premium Discount - 1 credit ($2.39)
```

## How to Get Your Price IDs

1. **Go to Stripe Dashboard** → **Products**
2. **Find or create products** for each item above
3. **Copy the Price ID** (starts with `price_1...`) for each product
4. **Add to your `.env` file**

## Example .env File
```bash
# Stripe Configuration
STRIPE_PUBLISHABLE_KEY=pk_test_51ABC123...
STRIPE_SECRET_KEY=sk_test_51DEF456...
STRIPE_WEBHOOK_SECRET=whsec_789GHI...

# Subscriptions
STRIPE_PRICE_MONTHLY_SUB=price_1S30fS1gsiVoH0JygiqbHeVL
STRIPE_PRICE_HALF_YEAR_SUB=price_1S30hB1gsiVoH0JyYwrzG2Hr
STRIPE_PRICE_YEARLY_SUB=price_1S30iV1gsiVoH0JyiVLh9v28

# Coins
STRIPE_PRICE_BASIC_COINS=price_1ABC123def456ghi789
STRIPE_PRICE_POPULAR_COINS=price_1DEF456ghi789jkl012
STRIPE_PRICE_PREMIUM_COINS=price_1GHI789jkl012mno345
STRIPE_PRICE_MEGA_COINS=price_1JKL012mno345pqr678

# Letter Credits
STRIPE_PRICE_LETTER_CREDITS=price_1MNO345pqr678stu901
```

## Security Benefits

✅ **No hardcoded secrets** in your code  
✅ **Easy to change** prices without code updates  
✅ **Different environments** (test vs production) use different price IDs  
✅ **Version control safe** - `.env` file is gitignored

## Testing

After adding your price IDs, restart your server and test:
- Subscription purchases
- Coin package purchases  
- Letter credit purchases

The system will now use your actual Stripe products instead of creating them dynamically!
