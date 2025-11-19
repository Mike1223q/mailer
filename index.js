import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { OAuth2Client } from 'google-auth-library';
import transporter from "./reset_code.js"; // Your existing transporter
import mysql from "mysql2/promise";
import session from "express-session";
import { createRequire } from "module"; // Node built-in
import dotenv from "dotenv";
import { isContentAppropriate } from './moderation.js'; // New moderation utility
import fs from 'fs/promises';


dotenv.config();
const require = createRequire(import.meta.url); // allows require in ESM
const MySQLStore = require("express-mysql-session")(session); // pass session to MySQLStore
const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Stripe configuration
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
const DEFAULT_AVATAR = '/media/unverifiedUser.jpg';

const withDefaultAvatar = (entity) => {
    if (!entity || typeof entity !== 'object') {
        return entity;
    }
    return {
        ...entity,
        avatar: entity.avatar || DEFAULT_AVATAR
    };
};

// Validate required Stripe price IDs on startup
const validateStripePriceIds = () => {
    const requiredPriceIds = [
        'STRIPE_PRICE_MONTHLY_SUB',
        'STRIPE_PRICE_HALF_YEAR_SUB', 
        'STRIPE_PRICE_YEARLY_SUB',
        'STRIPE_PRICE_BASIC_COINS',
        'STRIPE_PRICE_POPULAR_COINS',
        'STRIPE_PRICE_PREMIUM_COINS',
        'STRIPE_PRICE_MEGA_COINS',
        'STRIPE_PRICE_ULTIMATE_COINS',
        'STRIPE_PRICE_LETTER_CREDITS',
        'STRIPE_PRICE_LETTER_CREDITS_DISCOUNT'
    ];
    
    const missing = requiredPriceIds.filter(id => !process.env[id]);
    
    if (missing.length > 0) {
        console.warn('⚠️  Missing Stripe price IDs in environment variables:');
        missing.forEach(id => console.warn(`   - ${id}`));
        console.warn('💡 See STRIPE_ENV_SETUP.md for configuration instructions');
    } else {
        console.log('✅ All Stripe price IDs configured');
    }
};

// Run validation on startup
validateStripePriceIds();

// Helper function to log transaction attempts
const logTransaction = async (logData) => {
    try {
        const {
            userId,
            userEmail,
            userName,
            userIP,
            userAgent,
            transactionType,
            itemType,
            packageType,
            amount,
            price,
            currency = 'USD',
            stripeSessionId,
            stripePaymentIntentId,
            stripeCustomerId,
            paymentMethod,
            status,
            failureReason,
            metadata
        } = logData;

        await pool.execute(`
            INSERT INTO transaction_logs (
                user_id, user_email, user_name, user_ip, user_agent,
                transaction_type, item_type, package_type, amount, price, currency,
                stripe_session_id, stripe_payment_intent_id, stripe_customer_id,
                payment_method, status, failure_reason, metadata,
                completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            userId || null,
            userEmail || null,
            userName || null,
            userIP || null,
            userAgent || null,
            transactionType,
            itemType,
            packageType || null,
            amount || null,
            price || null,
            currency,
            stripeSessionId || null,
            stripePaymentIntentId || null,
            stripeCustomerId || null,
            paymentMethod || null,
            status,
            failureReason || null,
            metadata ? JSON.stringify(metadata) : null,
            status === 'completed' ? new Date() : null
        ]);

    } catch (error) {
        console.error('❌ Error logging transaction:', error);
    }
};

// Helper function to update transaction log status
const updateTransactionLog = async (stripeSessionId, status, failureReason = null, metadata = null) => {
    try {
        await pool.execute(`
            UPDATE transaction_logs 
            SET status = ?, failure_reason = ?, metadata = ?, updated_at = NOW(),
                completed_at = CASE WHEN ? = 'completed' THEN NOW() ELSE completed_at END
            WHERE stripe_session_id = ?
        `, [status, failureReason, metadata ? JSON.stringify(metadata) : null, status, stripeSessionId]);

    } catch (error) {
        console.error('❌ Error updating transaction log:', error);
    }
};
const interests = JSON.parse(await fs.readFile('./database/interests.json', 'utf-8')).interests;

// Helper function to determine if a plan change is an upgrade
const isPlanUpgrade = (currentPlan, newPlan) => {
    const planOrder = { 'monthly': 1, 'half-year': 2, 'yearly': 3 };
    return planOrder[newPlan] > planOrder[currentPlan];
};

// Helper function to get plan duration in milliseconds
const getPlanDuration = (planType) => {
    switch (planType) {
        case 'monthly':
            return 30 * 24 * 60 * 60 * 1000; // 30 days
        case 'half-year':
            return 6 * 30 * 24 * 60 * 60 * 1000; // 6 months (180 days)
        case 'yearly':
            return 365 * 24 * 60 * 60 * 1000; // 365 days
        default:
            return 0;
    }
};

// Helper function to determine actual premium status (checking expiration for all subscriptions)
const getActualPremiumStatus = (user) => {
    // If user doesn't have premium in database, return false
    if (!user.premium) {
        return false;
    }
    
    // If no subscription data, return database value
    if (!user.premiumStartDate || !user.premiumType) {
        return user.premium;
    }
    
    // Check if subscription has expired (check for all subscriptions, not just cancelled)
    const now = new Date();
    
    // Use premiumEndDate if available, otherwise calculate from start date
    let endDate;
    if (user.premiumEndDate) {
        endDate = new Date(user.premiumEndDate);
    } else {
        // Fallback calculation for older records
        const startDate = new Date(user.premiumStartDate);
        endDate = new Date(startDate.getTime() + getPlanDuration(user.premiumType));
    }
    
    // Return true only if not expired
    return now < endDate;
};


// --- Middleware (mostly unchanged) ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set('view engine', 'ejs');

// Cookie parser for referral tracking
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Trust proxy for accurate IP detection (if behind proxy/load balancer)
app.set('trust proxy', true);

// Helper function to get real IP address
const getRealIP = (req) => {
    return req.ip || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
           '0.0.0.0';
};

// Helper function to generate unique referral code
const generateReferralCode = (firstName, userId) => {
    const namePrefix = firstName ? firstName.substring(0, 3).toUpperCase() : 'USR';
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${namePrefix}${userId}${randomSuffix}`;
};

// Helper function to find user by referral code
const findUserByReferralCode = async (referralCode) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, firstName FROM users WHERE referralCode = ?',
            [referralCode]
        );
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        console.error('Error finding user by referral code:', error);
        return null;
    }
};

// Helper function to mask email addresses for privacy
const maskEmail = (email) => {
    if (!email || typeof email !== 'string') return email;
    
    const [username, domain] = email.split('@');
    if (!username || !domain) return email;
    
    const maskedUsername = username.charAt(0) + '*'.repeat(Math.max(1, username.length - 1));
    return `${maskedUsername}@${domain}`;
};

// Helper function to calculate and record referral earnings
const processReferralEarning = async (userId, purchaseAmount, isSubscription = false, isSecondMonth = false, userIP = null, userAgent = null, transactionId = null) => {
    try {
        // Get user's referrer info and IP if not provided
        const [userRows] = await pool.execute(
            'SELECT referredBy, registration_ip FROM users WHERE id = ?',
            [userId]
        );
        
        // Use provided IP or fall back to registration IP
        const referredUserIP = userIP || userRows[0]?.registration_ip || 'unknown';
        
        if (userRows.length === 0 || !userRows[0].referredBy) {
            return;
        }
        
        const referrerId = userRows[0].referredBy;
        
        // Get referrer's program type and IP
        const [referrerRows] = await pool.execute(
            'SELECT referralProgramType, registration_ip FROM users WHERE id = ?',
            [referrerId]
        );
        
        const referrerIP = referrerRows[0]?.registration_ip || 'unknown';
        
        if (referrerRows.length === 0) {
            return;
        }
        
        const programType = referrerRows[0].referralProgramType || 'standard';
        
        let earningAmount = 0;
        let earningType = 'percentage';
        let percentage = null;
        
        switch (programType) {
            case 'standard':
                // 5% of purchase amount
                earningAmount = purchaseAmount * 0.05;
                percentage = 5;
                break;
                
            case 'offer_5':
                // Check if within 6 months of referral registration date
                    const [referralDate] = await pool.execute(
                        'SELECT created_at FROM users WHERE id = ?',
                        [userId]
                    );
                    
                const referralRegistrationDate = new Date(referralDate[0].created_at);
                const sixMonthsAfterReferral = new Date(referralRegistrationDate);
                sixMonthsAfterReferral.setMonth(sixMonthsAfterReferral.getMonth() + 6);
                
                const now = new Date();
                
                if (now <= sixMonthsAfterReferral) {
                    if (isSubscription) {
                        if (!isSecondMonth) {
                            // Check if signup bonus has already been paid for this referred user
                            const [existingSignupBonus] = await pool.execute(
                                'SELECT id FROM referral_earnings WHERE referrer_id = ? AND referred_user_id = ? AND earning_type = "signup_bonus"',
                                [referrerId, userId]
                            );
                            
                            if (existingSignupBonus.length > 0) {
                                // Signup bonus already paid, only give 15% commission
                        earningAmount = purchaseAmount * 0.15;
                                earningType = 'percentage';
                        percentage = 15;
                    } else {
                                // First subscription ever: $5 only
                                earningAmount = 5;
                                earningType = 'signup_bonus';
                            }
                        } else {
                            // Subsequent months: 15% only (within 6 months)
                            earningAmount = purchaseAmount * 0.15;
                            earningType = 'percentage';
                            percentage = 15;
                        }
                    } else {
                        // 15% for one-time purchases within 6 months
                        earningAmount = purchaseAmount * 0.15;
                        percentage = 15;
                    }
                } else {
                    return; // Outside 6-month window for both subscriptions and purchases
                }
                break;
                
            case 'offer_10':
                if (isSubscription && !isSecondMonth) {
                    // Check if signup bonus has already been paid for this referred user
                    const [existingSignupBonus] = await pool.execute(
                        'SELECT id FROM referral_earnings WHERE referrer_id = ? AND referred_user_id = ? AND earning_type = "signup_bonus"',
                        [referrerId, userId]
                    );
                    
                    if (existingSignupBonus.length === 0) {
                        // First subscription ever: $10 signup bonus
                    earningAmount = 10;
                    earningType = 'signup_bonus';
                    }
                    // If signup bonus already paid, don't award anything (offer_10 has no ongoing commission)
                }
                break;
                
            default:
                return;
        }
        
        if (earningAmount > 0) {
            // For signup_bonus, check if it already exists (should only happen once per user)
            if (earningType === 'signup_bonus') {
            const [existingRows] = await pool.execute(
                `SELECT id FROM referral_earnings 
                    WHERE referrer_id = ? AND referred_user_id = ? AND earning_type = 'signup_bonus'`,
                    [referrerId, userId]
            );
            
            if (existingRows.length > 0) {
                return;
                }
            }
            
            // If we have a transaction ID, check for transaction-based duplicates
            if (transactionId) {
                const [transactionRows] = await pool.execute(
                    `SELECT id FROM referral_earnings 
                    WHERE referrer_id = ? AND referred_user_id = ? AND transaction_id = ?`,
                    [referrerId, userId, transactionId]
                );
                
                if (transactionRows.length > 0) {
                    return;
                }
            }
            
            await pool.execute(
                `INSERT INTO referral_earnings 
                (referrer_id, referred_user_id, referrer_ip, referred_user_ip, user_agent, earning_type, amount, percentage, purchase_amount, status, transaction_id) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                [referrerId, userId, referrerIP, referredUserIP, userAgent || 'unknown', earningType, earningAmount, percentage, purchaseAmount, transactionId]
            );
        }
        
    } catch (error) {
        console.error('Error processing referral earning:', error);
    }
};



// Configure MySQL session store
const sessionStore = new MySQLStore({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  
  // Use sessions
  app.use(session({
    key: "first_letter_session",
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000 // 1 day
    }
  }));

  // Referral code capture middleware
  app.use((req, res, next) => {
    const referralCode = req.query.ref || req.query.referral;
    
    if (referralCode && !req.session.userId) {
      // Only capture referral if user is not already logged in
      res.cookie('referralCode', referralCode, {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax"
      });
    }
    
    next();
  });
  

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || "409368143445-v7ukcrsjh9lc9vj2h1t70ufg1fa4ej1v.apps.googleusercontent.com");
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "409368143445-v7ukcrsjh9lc9vj2h1t70ufg1fa4ej1v.apps.googleusercontent.com";


// --- NEW: MySQL Connection ---
// Use environment variables for database credentials in a real application
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT,    
  user: process.env.DB_USER || 'your_mysql_user',
  password: process.env.DB_PASSWORD || 'your_mysql_password',
  database: process.env.DB_NAME || 'your_database_name',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
const userData = [
    // User 1 (ID 6) - 27 fields
    'James', 'Chen', 0, 'james.c@example.com', 'hashed_password_6', 1, '1990-05-12', 'Software developer and weekend hiker.', '["💻 Programming", "⛰️ Hiking", "🎧 Music"]', '606 Code St, Tech City, TX', 1, 'Male', '/media/avatars/male/avatar01.jpg', 10, 1, 100, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 2 (ID 7)
    'Sophia', 'Kim', 1, 'sophia.k@example.com', 'hashed_password_7', 1, '1993-12-01', 'Bookworm and aspiring novelist.', '["📚 Reading", "✍️ Writing", "☕ Coffee"]', '707 Novel Nook, Storyville, IL', 0, 'Female', '/media/avatars/female/avatar02.jpg', 15, 1, 200, 1, 'monthly', '2025-09-03 16:00:00', 0, null, 1, 1, '[]', null, '[]', '[]',
    // User 3 (ID 8)
    'Benjamin', 'Díaz', 0, 'benjamin.d@example.com', 'hashed_password_8', 0, '1997-08-25', 'Amateur chef and foodie blogger.', '["👨‍🍳 Cooking", "🍕 Food", "📸 Photography"]', '808 Gourmet Grv, Tasteville, FL', 1, 'Male', '/media/avatars/male/avatar03.jpg', 5, 0, 50, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 4 (ID 9)
    'Ava', 'Nguyen', 1, 'ava.n@example.com', 'hashed_password_9', 1, '2001-04-18', 'Student, volunteer, and nature lover.', '["🎓 Education", "🌳 Nature", "🤝 Volunteering"]', '909 Green Trail, Forest Hills, WA', 1, 'Female', '/media/avatars/female/avatar04.jpg', 20, 1, 300, 1, 'yearly', '2025-01-15 10:00:00', 0, '2026-01-15 10:00:00', 5, 1, '[]', null, '[]', '[]',
    // User 5 (ID 10)
    'Elijah', 'Patel', 0, 'elijah.p@example.com', 'hashed_password_10', 1, '1991-02-14', 'Investor and financial analyst.', '["📈 Finance", "🗞️ News", "🏃 Running"]', '1010 Money Mkt, Wall Street, NY', 0, 'Male', '/media/avatars/male/avatar05.jpg', 12, 1, 150, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 6 (ID 11)
    'Isabella', 'Hayes', 0, 'isabella.h@example.com', 'hashed_password_11', 1, '1996-02-28', 'Aspiring chef, loves experimenting with fusion cuisine.', '["👨‍🍳 Cooking", "🍷 Wine Tasting", "🎵 Jazz"]', '111 Foodie Row, Gastronomy, CA', 1, 'Female', '/media/avatars/female/avatar01.jpg', 8, 1, 80, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 7 (ID 12)
    'Daniel', 'Chen', 1, 'daniel.c@example.com', 'hashed_password_12', 1, '1985-10-10', 'Electronics engineer, always building something new.', '["💻 Technology", "🛠️ DIY", "🚗 Cars"]', '121 Circuit Dr, Techtonics, TX', 1, 'Male', '/media/avatars/male/avatar02.jpg', 30, 1, 500, 1, 'half-year', '2025-05-20 12:00:00', 0, '2025-11-20 12:00:00', 2, 1, '[]', null, '[]', '[]',
    // User 8 (ID 13)
    'Chloe', 'Miller', 0, 'chloe.m@example.com', 'hashed_password_13', 0, '2002-07-05', 'University student focused on social justice and policy.', '["⚖️ Politics", "📚 Education", "🎨 Art"]', '131 Campus Walk, Policy City, DC', 0, 'Female', '/media/avatars/female/avatar03.jpg', 0, 0, 10, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 9 (ID 14)
    'Ethan', 'King', 1, 'ethan.k@example.com', 'hashed_password_14', 1, '1978-01-20', 'Professional photographer, specializes in landscapes.', '["📸 Photography", "⛰️ Hiking", "🗺️ Travel"]', '141 Scenic View, Peak City, CO', 1, 'Male', '/media/avatars/male/avatar04.jpg', 25, 1, 400, 1, 'monthly', '2025-10-05 08:00:00', 0, null, 3, 1, '[]', null, '[]', '[]',
    // User 10 (ID 15)
    'Abigail', 'Lee', 0, 'abigail.l@example.com', 'hashed_password_15', 1, '1999-11-25', 'Digital marketer and vintage clothing collector.', '["🛍️ Fashion", "💻 Marketing", "🧵 Sewing"]', '151 Retro Alley, Style Town, NY', 0, 'Female', '/media/avatars/female/avatar05.jpg', 18, 1, 250, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 11 (ID 16)
    'Jackson', 'Wu', 0, 'jackson.w@example.com', 'hashed_password_16', 1, '1994-06-16', 'Avid cyclist, trains for long-distance charity rides.', '["🚴 Cycling", "🏃 Running", "🧘‍♂️ Meditation"]', '161 Trail Way, Peloton, OR', 1, 'Male', '/media/avatars/male/avatar01.jpg', 10, 1, 100, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 12 (ID 17)
    'Mia', 'González', 1, 'mia.g@example.com', 'hashed_password_17', 0, '1990-03-08', 'Loves playing board games and hosting game nights.', '["🎲 Board Games", "☕ Coffee", "📚 Reading"]', '171 Strategy Blvd, Gamer Grv, IL', 0, 'Female', '/media/avatars/female/avatar02.jpg', 5, 0, 50, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 13 (ID 18)
    'Lucas', 'Sharma', 0, 'lucas.s@example.com', 'hashed_password_18', 1, '2000-12-03', 'Student and part-time music producer.', '["🎧 Music Production", "🎸 Guitar", "🎮 Gaming"]', '181 Sound Loop, Mixville, CA', 1, 'Male', '/media/avatars/male/avatar03.jpg', 25, 1, 400, 1, 'monthly', '2025-11-10 14:00:00', 0, null, 4, 1, '[]', null, '[]', '[]',
    // User 14 (ID 19)
    'Evelyn', 'Johnson', 1, 'evelyn.j@example.com', 'hashed_password_19', 1, '1987-09-19', 'Experienced gardener focused on native plants and flowers.', '["🌱 Gardening", "🌷 Flowers", "🍵 Tea"]', '191 Blossom Dr, Bloom Town, VA', 1, 'Female', '/media/avatars/female/avatar04.jpg', 22, 1, 350, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]',
    // User 15 (ID 20)
    'Adrian', 'Flores', 0, 'adrian.f@example.com', 'hashed_password_20', 0, '1992-04-14', 'Loves collecting comic books and attending conventions.', '["🦸 Comics", "🎬 Movies", "🎮 Gaming"]', '202 Hero Ave, Gotham, NY', 0, 'Male', '/media/avatars/male/avatar05.jpg', 7, 0, 75, 0, null, null, 0, null, 0, 1, '[]', null, '[]', '[]'
];

const userFieldsPerRecord = 27; // Corrected to 27 fields
const singleUserSqlTemplate = `
    INSERT INTO users (
        firstName, lastName, newsletter, email, password, email_verified, dob, bio, interests, address, wantsPhysicalMail, gender, avatar, letterCredits, completedProfile, coins, premium, premiumType, premiumStartDate, premiumCancelled, premiumEndDate, boosts, safesendEnabled, pastProfiles, lastTimeProfilesRefresh, currentProfiles, chatHistory
    ) VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`; // Corrected to 27 placeholders

async function insertTestUsersOneByOne() {
    console.log('Starting single-user inserts with 27 correct fields...');
    
    for (let i = 0; i < userData.length; i += userFieldsPerRecord) {
        const singleUserData = userData.slice(i, i + userFieldsPerRecord);
        
        if (singleUserData.length !== userFieldsPerRecord) {
            console.error(`❌ Data error: Expected ${userFieldsPerRecord} fields, but got ${singleUserData.length} at index ${i}. Stopping.`);
            break;
        }

        try {
            await pool.execute(singleUserSqlTemplate, singleUserData);
            console.log(`✅ User ${(i / userFieldsPerRecord) + 1} inserted successfully.`);
        } catch (error) {
            console.error(`❌ Failed to insert user ${(i / userFieldsPerRecord) + 1}. Error:`, error.message);
            return;
        }
    }

    console.log('🎉 All 15 test users inserted successfully.');
}

insertTestUsersOneByOne();

// Function to clean up expired cancelled subscriptions
async function cleanupExpiredSubscriptions() {
    try {
        // Clean up monthly subscriptions
        const [monthlyResult] = await pool.execute(`
            UPDATE users 
            SET premium = false 
            WHERE premiumCancelled = true 
            AND premiumType = 'monthly'
            AND premiumStartDate IS NOT NULL
            AND DATE_ADD(premiumStartDate, INTERVAL 30 DAY) <= NOW()
        `);
        
        // Clean up half-year subscriptions
        const [halfYearResult] = await pool.execute(`
            UPDATE users 
            SET premium = false 
            WHERE premiumCancelled = true 
            AND premiumType = 'half-year'
            AND premiumStartDate IS NOT NULL
            AND DATE_ADD(premiumStartDate, INTERVAL 6 MONTH) <= NOW()
        `);
        
        // Clean up yearly subscriptions
        const [yearlyResult] = await pool.execute(`
            UPDATE users 
            SET premium = false 
            WHERE premiumCancelled = true 
            AND premiumType = 'yearly'
            AND premiumStartDate IS NOT NULL
            AND DATE_ADD(premiumStartDate, INTERVAL 1 YEAR) <= NOW()
        `);
        
    } catch (error) {
        console.error('Error during cleanup of expired subscriptions:', error.message);
    }
}


// Function to distribute monthly coins to all active premium users
async function distributeMonthlyCoins() {
    try {
        // Get current month/year
        const now = new Date();
        const currentMonth = now.getMonth() + 1; // getMonth() returns 0-11, we want 1-12
        const currentYear = now.getFullYear();
        
        // Find all active premium users who haven't received coins this month
        const [users] = await pool.execute(`
            SELECT u.id, u.firstName, u.email, u.coins, u.lastMonthlyCoins
            FROM users u
            WHERE u.premium = 1 
            AND u.premiumCancelled = 0
            AND (
                u.lastMonthlyCoins IS NULL 
                OR YEAR(u.lastMonthlyCoins) != ? 
                OR MONTH(u.lastMonthlyCoins) != ?
            )
            AND (
                u.premiumEndDate IS NULL 
                OR u.premiumEndDate > NOW()
            )
        `, [currentYear, currentMonth]);
        
        if (users.length === 0) {
            return;
        }
        
        let coinsDistributed = 0;
        
        // Give 1000 coins to each eligible user
        for (const user of users) {
            try {
                await pool.execute(`
                    UPDATE users 
                    SET coins = coins + 1000, 
                        lastMonthlyCoins = NOW()
                    WHERE id = ?
                `, [user.id]);
                
                coinsDistributed++;
            } catch (userError) {
                console.error(`❌ Error adding coins to user ${user.id}:`, userError.message);
            }
        }
        
    } catch (error) {
        console.error('❌ Error during monthly coin distribution:', error.message);
    }
}

// --- NEW: Database Initialization Function ---
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    console.log("Connected to MySQL database.");

    // UPDATED: MySQL-compatible CREATE TABLE statements
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
          id INT PRIMARY KEY AUTO_INCREMENT,
          firstName VARCHAR(255),
          lastName VARCHAR(255),
          newsletter BOOLEAN DEFAULT 0,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255),
          email_verified BOOLEAN DEFAULT 0,
          dob DATE NULL,
          bio TEXT NULL,
          interests JSON NULL,
          address VARCHAR(255) NULL,
          wantsPhysicalMail BOOLEAN DEFAULT 1,
          gender VARCHAR(20) NULL DEFAULT NULL,
          avatar VARCHAR(255) NULL DEFAULT NULL,
          letterCredits INT DEFAULT 0,
          completedProfile BOOLEAN DEFAULT 0,
          coins INT DEFAULT 0,
          premium BOOLEAN DEFAULT 0,
          premiumType ENUM('monthly', 'half-year', 'yearly') NULL,
          premiumStartDate DATETIME NULL,
          premiumCancelled BOOLEAN DEFAULT FALSE,
          premiumEndDate DATETIME NULL,
          lastMonthlyCoins DATETIME NULL,
          boosts INT DEFAULT 0,
          safesendEnabled BOOLEAN DEFAULT TRUE,
          pastProfiles JSON,
          lastTimeProfilesRefresh DATETIME,
          currentProfiles JSON,
          chatHistory JSON
      )
    `);

    // Add boosts column to existing users table if it doesn't exist
    try {
        await connection.query(`
            ALTER TABLE users ADD COLUMN boosts INT DEFAULT 0
        `);
        console.log('✅ Added boosts column to users table');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('ℹ️  Boosts column already exists in users table');
        } else {
            console.log('Error adding boosts column:', err.message);
        }
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS codes (
          id INT PRIMARY KEY AUTO_INCREMENT,
          email VARCHAR(255) UNIQUE NOT NULL,
          code VARCHAR(10),
          number_of_tries INT DEFAULT 0,
          wait_until DATETIME,
          expires_at DATETIME,
          first_sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS drafts (
          id INT PRIMARY KEY AUTO_INCREMENT,
          sender_id INT NOT NULL,
          recipient_id INT NOT NULL,
          recipient_name VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          action ENUM('email', 'letter') NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY unique_draft (sender_id, recipient_id, action)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS messages (
          id INT PRIMARY KEY AUTO_INCREMENT,
          sender_id INT NOT NULL,
          recipient_id INT NOT NULL,
          content TEXT NOT NULL,
          message_type ENUM('email', 'letter', 'gift') NOT NULL,
          status ENUM('sent', 'delivered', 'read') DEFAULT 'sent',
          delivery_time DATETIME NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Update messages table to include 'gift' in message_type ENUM
    try {
        await connection.query(`
            ALTER TABLE messages 
            MODIFY COLUMN message_type ENUM('email', 'letter', 'gift') NOT NULL
        `);
        console.log('Updated messages table message_type ENUM to include gift');
    } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' && !error.message.includes('already exists')) {
            console.log('Message type ENUM already includes gift or table does not exist yet');
        }
    }

    
    // Create comprehensive transaction_logs table for tracking all payment attempts
    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS transaction_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                user_email VARCHAR(255),
                user_name VARCHAR(100),
                user_ip VARCHAR(45),
                user_agent TEXT,
                transaction_type ENUM('purchase', 'refund', 'subscription', 'upgrade', 'cancellation') NOT NULL,
                item_type ENUM('coins', 'credits', 'subscription', 'upgrade') NOT NULL,
                package_type VARCHAR(50),
                amount INT,
                price DECIMAL(10, 2),
                currency VARCHAR(3) DEFAULT 'USD',
                stripe_session_id VARCHAR(255),
                stripe_payment_intent_id VARCHAR(255),
                stripe_customer_id VARCHAR(255),
                payment_method VARCHAR(50),
                status ENUM('initiated', 'pending', 'processing', 'completed', 'failed', 'cancelled', 'refunded', 'security_violation', 'timeout') DEFAULT 'initiated',
                failure_reason TEXT,
                metadata JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                completed_at TIMESTAMP NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_user_logs (user_id),
                INDEX idx_user_email (user_email),
                INDEX idx_user_ip (user_ip),
                INDEX idx_stripe_session (stripe_session_id),
                INDEX idx_status (status),
                INDEX idx_created_at (created_at),
                INDEX idx_transaction_type (transaction_type)
            )
        `);
        console.log('Created comprehensive transaction_logs table');
    } catch (err) {
        console.log('Error creating transaction_logs table:', err.message);
    }

    // Keep the old transactions table for backward compatibility but make it simpler
    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                type ENUM('purchase', 'refund') NOT NULL,
                item_type ENUM('coins', 'credits', 'subscription') NOT NULL,
                package_type VARCHAR(50),
                amount INT NOT NULL,
                price DECIMAL(10, 2) NOT NULL,
                stripe_session_id VARCHAR(255),
                status ENUM('pending', 'completed', 'failed', 'refunded', 'security_violation') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_transactions (user_id),
                INDEX idx_stripe_session (stripe_session_id),
                INDEX idx_created_at (created_at)
            )
        `);
        console.log('Created transactions table');
    } catch (err) {
        console.log('Error creating transactions table:', err.message);
    }

    // Create referral_earnings table to track earnings
    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS referral_earnings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                referrer_id INT NOT NULL,
                referred_user_id INT NOT NULL,
                earning_type ENUM('percentage', 'signup_bonus', 'retention_bonus', 'mixed') NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                percentage DECIMAL(5, 2) NULL,
                purchase_amount DECIMAL(10, 2) NULL,
                status ENUM('pending', 'paid', 'cancelled') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NULL,
                FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_referrer_status (referrer_id, status),
                INDEX idx_created_at (created_at)
            )
        `);
        console.log('Created referral_earnings table');
    } catch (err) {
        console.log('Error creating referral_earnings table:', err.message);
    }



    // Clean up any invalid billing dates that might exist
    try {
        await connection.query(`
            UPDATE users 
            SET premiumStartDate = NOW() 
            WHERE premium = 1 AND (premiumStartDate IS NULL OR premiumStartDate < NOW())
        `);
        console.log('Cleaned up invalid billing dates');
    } catch (err) {
        console.log('Error cleaning up billing dates:', err.message);
    }

    // Generate referral codes for existing users who don't have them
    try {
        const [usersWithoutCodes] = await connection.query(`
            SELECT id, firstName FROM users WHERE referralCode IS NULL OR referralCode = ''
        `);
        
        if (usersWithoutCodes.length > 0) {
            console.log(`Generating referral codes for ${usersWithoutCodes.length} existing users`);
            
            for (const user of usersWithoutCodes) {
                const referralCode = generateReferralCode(user.firstName || 'User', user.id);
                await connection.query(
                    'UPDATE users SET referralCode = ? WHERE id = ?',
                    [referralCode, user.id]
                );
            }
            
            console.log('Generated referral codes for existing users');
        }
    } catch (err) {
        console.error('Error generating referral codes for existing users:', err.message);
    }

    connection.release();
    console.log("Database tables are ready.");
  } catch (err) {
    console.error("DB connection or initialization error:", err);
    process.exit(1); // Exit if DB connection fails
  }
}

// --- UPDATED Routes (using async/await and MySQL pool) ---

// Register route
app.post("/register", async (req, res) => {
    const { email, password, firstName, lastName, newsletter } = req.body;
    if (!email || !password || !firstName || !lastName) {
        return res.status(400).send("All fields are required");
    }
    if (password.length < 8) {
        return res.status(406).send("Password must be at least 8 characters long");
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const registrationIp = getRealIP(req);
        
        // Check for referral code in cookies
        const referralCode = req.cookies.referralCode;
        let referrerId = null;
        
        if (referralCode) {
            const referrer = await findUserByReferralCode(referralCode);
            if (referrer) {
                referrerId = referrer.id;
            }
        }

        // Insert new user with IP and referral tracking
        const sql = `INSERT INTO users (email, password, firstName, lastName, newsletter, registration_ip, referredBy) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const [result] = await pool.execute(sql, [
            email, hashedPassword, firstName, lastName, newsletter ? 1 : 0, registrationIp, referrerId
        ]);
        
        const userId = result.insertId;
        
        // Generate and save referral code for the new user
        const userReferralCode = generateReferralCode(firstName, userId);
        await pool.execute(
            'UPDATE users SET referralCode = ? WHERE id = ?',
            [userReferralCode, userId]
        );
        
        // If user was referred, increment referrer's referral count
        if (referrerId) {
            await pool.execute(
                'UPDATE users SET referralCount = referralCount + 1 WHERE id = ?',
                [referrerId]
            );
            
            // Clear the referral cookie since it's been used
            res.clearCookie('referralCode');
        }
        
        req.session.userId = userId;
        req.session.email = email;
        req.session.firstName = firstName;

        res.sendStatus(200);
    } catch (err) {
        console.error('Registration error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).send("User already exists");
        }
        res.status(500).send("Database error occurred");
    }
});

// Login route
app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).send("Email and password are required");
    }

    try {
        const sql = "SELECT * FROM users WHERE email = ?";
        const [rows] = await pool.execute(sql, [email]);

        if (rows.length === 0) {
            return res.status(401).send("User not found");
        }

        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (match) {
            req.session.userId = user.id;
            req.session.email = user.email;
            req.session.firstName = user.firstName;
            return res.sendStatus(200);
        } else {
            return res.status(401).send("Invalid password");
        }
    } catch (err) {
        console.error("DB login error:", err);
        return res.status(500).send("Database error");
    }
});

app.post("/auth/google", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    const ticket  = await client.verifyIdToken({ idToken: token, audience: CLIENT_ID });
    const payload = ticket.getPayload();
    const { email, email_verified, given_name, family_name } = payload;

    const [rows] = await pool.execute("SELECT id FROM users WHERE email = ?", [email]);

    if (rows.length > 0) {
        const user = rows[0];
        req.session.userId = user.id;
        req.session.email = email;
        req.session.firstName = given_name || "";
        return res.json({ message: "User already exists", email });
    }

    const registrationIp = getRealIP(req);
    
    // Check for referral code in cookies
    const referralCode = req.cookies.referralCode;
    let referrerId = null;
    
    if (referralCode) {
        const referrer = await findUserByReferralCode(referralCode);
        if (referrer) {
            referrerId = referrer.id;
        }
    }

    // Insert new user with IP and referral tracking
    const sql = `INSERT INTO users (email, password, firstName, lastName, newsletter, email_verified, registrationIp, referredBy) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const [result] = await pool.execute(sql, [
        email, null, given_name || "", family_name || "", 1, email_verified ? 1 : 0, registrationIp, referrerId
    ]);
    
    const userId = result.insertId;
    
    // Generate and save referral code for the new user
    const userReferralCode = generateReferralCode(given_name || 'User', userId);
    await pool.execute(
        'UPDATE users SET referralCode = ? WHERE id = ?',
        [userReferralCode, userId]
    );
    
    // If user was referred, increment referrer's referral count
    if (referrerId) {
        await pool.execute(
            'UPDATE users SET referralCount = referralCount + 1 WHERE id = ?',
            [referrerId]
        );
        
        // Clear the referral cookie since it's been used
        res.clearCookie('referralCode');
    }
        
    req.session.userId = userId;
    req.session.email = email;
    req.session.firstName = given_name || "";
    
    res.json({ message: "Google sign-up successful", email });

  } catch (err) {
    console.error("Google auth/DB error:", err);
    if (err.code && err.code.startsWith('ER_')) {
        return res.status(500).json({ error: "Database error" });
    }
    return res.status(400).json({ error: "Invalid Google token" });
  }
});

app.post("/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
        const [users] = await pool.execute("SELECT id FROM users WHERE email = ?", [email]);
        if (users.length === 0) return res.status(404).json({ error: "User not found" });

        // This check for recent attempts is still valuable
        const [codes] = await pool.execute("SELECT wait_until FROM codes WHERE email = ?", [email]);
        
        if (codes.length > 0) {
            const waitUntil = new Date(codes[0].wait_until);
            // Don't check the daily reset here, let the main query handle it.
            // Just check if the user is spamming requests within minutes.
            if (new Date() < waitUntil) {
                return res.status(429).json({ error: "Too many attempts. Please try again later." });
            }
        }
        
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // This query now handles everything: inserting, updating, and the daily reset.
        const upsertSql = `
            INSERT INTO codes (email, code, expires_at, wait_until, number_of_tries, first_sent_at)
            VALUES (?, ?, NOW() + INTERVAL 10 MINUTE, NOW() - INTERVAL 5 MINUTE, 1, NOW())
            ON DUPLICATE KEY UPDATE
                code = VALUES(code),
                expires_at = VALUES(expires_at),
                wait_until = NOW() - INTERVAL 5 MINUTE,
                number_of_tries = CASE
                    WHEN first_sent_at < NOW() - INTERVAL 1 DAY THEN 1
                    ELSE number_of_tries + 1
                END,
                first_sent_at = CASE
                    WHEN first_sent_at < NOW() - INTERVAL 1 DAY THEN NOW()
                    ELSE first_sent_at
                END;
        `;
        await pool.execute(upsertSql, [email, code]);
        
        await transporter.sendMail({
            from: `"My App" <${process.env.SMTP_USER}>`,
            to: email,
            subject: "Your Password Reset Code",
            text: `Your code is ${code}`,
            html: `<p>Your code is <strong>${code}</strong></p>`
        });

        return res.json({ message: "Code sent successfully" });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Database or email error" });
    }
});

app.post("/forgot-password/verify", async (req, res) => {
    const { email, code } = req.body;
    try {
        const [rows] = await pool.execute("SELECT code, expires_at, number_of_tries, wait_until FROM codes WHERE email = ?", [email]);
        if (rows.length === 0) return res.status(404).json({ error: "No code found for this email" });

        const row = rows[0];
        const now = new Date();

        if (now < new Date(row.wait_until)) {
            return res.status(429).json({ error: "Too many attempts. Please try again later." });
        }
        if (now > new Date(row.expires_at)) {
            return res.status(400).json({ error: "Verification code has expired" });
        }

        if (row.code === code) {
            await pool.execute("UPDATE codes SET number_of_tries = 0 WHERE email = ?", [email]);
            const token = crypto.randomBytes(32).toString("hex");
            await pool.execute(
                "INSERT INTO reset_tokens (email, token, expires_at) VALUES (?, ?, NOW() + INTERVAL 10 MINUTE)",
                [email, token]
            );
            return res.status(200).json({ message: "Code verified successfully", token });
        } else {
            if (row.number_of_tries + 1 >= 10) {
                await pool.execute(
                    "UPDATE codes SET number_of_tries = 0, wait_until = NOW() + INTERVAL 1 HOUR WHERE email = ?",
                    [email]
                );
                return res.status(429).json({ error: "Too many attempts. Locked for one hour." });
            } else {
                await pool.execute("UPDATE codes SET number_of_tries = number_of_tries + 1 WHERE email = ?", [email]);
            }
            return res.status(406).json({ error: "Invalid verification code" });
        }
    } catch(err) {
        console.error("DB error:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

app.get("/reset-password", async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(404).send("Missing token");

    try {
        // UPDATED: MySQL date function NOW()
        const sql = "SELECT email FROM reset_tokens WHERE token = ? AND expires_at > NOW()";
        const [rows] = await pool.execute(sql, [token]);

        if (rows.length > 0) {
            res.render("reset-password", { token });
        } else {
            res.status(400).send("Invalid or expired token");
        }
    } catch(err) {
        console.error(err.message);
        return res.status(500).send("Database error");
    }
});

app.post("/reset-password", async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Missing token or password" });

    try {
        const [rows] = await pool.execute("SELECT email FROM reset_tokens WHERE token = ? AND expires_at > NOW()", [token]);
        if (rows.length === 0) return res.status(400).json({ error: "Invalid or expired token" });

        const email = rows[0].email;
        const hashedPassword = await bcrypt.hash(password, 10);

        await pool.execute("UPDATE users SET password = ? WHERE email = ?", [hashedPassword, email]);
        await pool.execute("DELETE FROM reset_tokens WHERE token = ?", [token]);
        
        return res.json({ message: "Password reset successful" });
    } catch (err) {
        console.error(err.message);
        return res.status(500).json({ error: "Database error" });
    }
});


// --- Other Routes & Server Start ---

app.get("/register", (req, res) => res.render("register-page"));
app.get("/login", (req, res) => res.render("login-page"));
app.get("/forgot", (req, res) => res.render("forgot-password"));

app.get("/", async (req, res) => {
    // Check if this is a Google OAuth callback
    if (req.query.code) {
        // Handle Google OAuth callback
        try {
            const { code } = req.query;
            if (!code) {
                return res.status(400).send("Authorization code is required");
            }
            if (!process.env.GOOGLE_CLIENT_SECRET) {
                console.error("GOOGLE_CLIENT_SECRET not configured");
                return res.status(500).send("Google authentication not properly configured");
            }
            
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    code: code,
                    grant_type: 'authorization_code',
                    redirect_uri: `${req.protocol}://${req.get('host')}/`
                })
            });
            const tokenData = await tokenResponse.json();
            if (!tokenData.access_token) {
                console.error("Failed to get access token:", tokenData);
                return res.status(400).send("Failed to get access token");
            }
            const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            const userData = await userResponse.json();
            const { email, given_name, family_name, verified_email } = userData;
            const [rows] = await pool.execute("SELECT id FROM users WHERE email = ?", [email]);
            if (rows.length > 0) {
                const user = rows[0];
                req.session.userId = user.id;
                req.session.email = email;
                req.session.firstName = given_name || "";
                
                // Save session before redirect
                req.session.save((err) => {
                    if (err) {
                        console.error("Session save error:", err);
                    }
                    res.redirect("/dashboard");
                });
                return;
            }
            const registrationIp = getRealIP(req);
            const referralCode = req.cookies.referralCode;
            let referrerId = null;
            if (referralCode) {
                const referrer = await findUserByReferralCode(referralCode);
                if (referrer) {
                    referrerId = referrer.id;
                }
            }
            const sql = `INSERT INTO users (email, password, firstName, lastName, newsletter, email_verified, registrationIp, referredBy) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            const [result] = await pool.execute(sql, [
                email, null, given_name || "", family_name || "", 1, verified_email ? 1 : 0, registrationIp, referrerId
            ]);
            const userId = result.insertId;
            const userReferralCode = generateReferralCode(given_name || 'User', userId);
            await pool.execute('UPDATE users SET referralCode = ? WHERE id = ?', [userReferralCode, userId]);
            if (referrerId) {
                await pool.execute('UPDATE users SET referralCount = referralCount + 1 WHERE id = ?', [referrerId]);
                res.clearCookie('referralCode');
            }
            req.session.userId = userId;
            req.session.email = email;
            req.session.firstName = given_name || "";
            
            // Save session before redirect
            req.session.save((err) => {
                if (err) {
                    console.error("Session save error:", err);
                }
                res.redirect("/dashboard");
            });
        } catch (err) {
            console.error("Google OAuth callback error:", err);
            res.status(500).send("Authentication failed. Please try again.");
        }
    }
    
    // Regular homepage logic
    if (req.session.userId) {
        res.render("index", { user: { "name": req.session.firstName, "email": req.session.email }});
    } else {
        res.render("index", { user: false });
    }
});

app.get("/logout", (req, res) => {
    req.session.destroy(err => {
      if (err) return res.status(500).send("Error logging out");
      res.clearCookie("first_letter_session");
      res.redirect("/"); // redirect user to login page
    });
  });

app.get("/dashboard", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login");
    }
    res.render("mathes", { user: { "name": req.session.firstName, "email": req.session.email } });
});


app.get("/writing", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login");
    }
    res.render("writing");
});

app.get("/chats", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login");
    }
    res.render("chats", { user: { "name": req.session.firstName, "email": req.session.email } });
});

app.get("/chat-view", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login");
    }
    res.render("chat-view", { user: { "name": req.session.firstName, "email": req.session.email } });
});

app.get("/marketplace", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login");
    }
    res.render("marketplace");
});

app.get("/referrals", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login");
    }
    res.render("referrals", { session: req.session });
});

// API endpoint to get detailed referral earnings for user dashboard
app.get("/api/user/referral-earnings", async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const userId = req.session.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const offset = (page - 1) * limit;
        
        // Get all referral earnings for this user (we'll filter out signup_bonus later)
        const [earningsRows] = await pool.execute(`
            SELECT 
                re.id,
                re.referred_user_id,
                re.amount,
                re.earning_type,
                re.percentage,
                re.purchase_amount,
                re.status,
                re.created_at,
                u.firstName as referred_name,
                u.lastName as referred_lastname,
                u.email as referred_email,
                u.created_at as referred_join_date
            FROM referral_earnings re
            LEFT JOIN users u ON re.referred_user_id = u.id
            WHERE re.referrer_id = ?
            ORDER BY re.created_at DESC
        `, [userId]);

        // Group earnings by referred user and calculate totals
        const referralDetails = {};
        let totalEarnings = 0;
        let pendingEarnings = 0;
        let approvedEarnings = 0;
        let paidEarnings = 0;

        earningsRows.forEach(earning => {
            const referredUserId = earning.referred_user_id;
            const amount = parseFloat(earning.amount);
            
            totalEarnings += amount;
            
            switch (earning.status) {
                case 'pending':
                    pendingEarnings += amount;
                    break;
                case 'approved':
                    approvedEarnings += amount;
                    break;
                case 'paid':
                    paidEarnings += amount;
                    break;
            }

            if (!referralDetails[referredUserId]) {
                referralDetails[referredUserId] = {
                    user_id: referredUserId,
                    user_name: earning.referred_name + ' ' + (earning.referred_lastname || ''),
                    user_email: earning.referred_email ? maskEmail(earning.referred_email) : 'No email',
                    join_date: earning.referred_join_date,
                    earnings: [],
                    total_earned: 0,
                    pending_amount: 0,
                    approved_amount: 0,
                    paid_amount: 0
                };
            }

            const userDetail = referralDetails[referredUserId];
            userDetail.earnings.push({
                id: earning.id,
                amount: amount,
                type: earning.earning_type,
                status: earning.status,
                date: earning.created_at,
                purchase_amount: earning.purchase_amount
            });

            userDetail.total_earned += amount;
            
            switch (earning.status) {
                case 'pending':
                    userDetail.pending_amount += amount;
                    break;
                case 'approved':
                    userDetail.approved_amount += amount;
                    break;
                case 'paid':
                    userDetail.paid_amount += amount;
                    break;
            }
        });

        // Apply pagination to referral details
        const allReferralDetails = Object.values(referralDetails);
        
        // Sort users by their join date (newest first) to ensure proper ordering
        allReferralDetails.sort((a, b) => new Date(b.join_date) - new Date(a.join_date));
        
        const totalUsers = allReferralDetails.length;
        const totalPages = Math.ceil(totalUsers / limit);
        const paginatedDetails = allReferralDetails.slice(offset, offset + limit);

        res.json({
            success: true,
            summary: {
                total_earnings: totalEarnings,
                pending_earnings: pendingEarnings,
                approved_earnings: approvedEarnings,
                paid_earnings: paidEarnings,
                total_referred_users: totalUsers
            },
            referral_details: paginatedDetails,
            pagination: {
                page,
                limit,
                total_pages: totalPages,
                total_users: totalUsers,
                has_more: page < totalPages
            }
        });

    } catch (error) {
        console.error('Error fetching user referral earnings:', error);
        res.status(500).json({ error: 'Failed to fetch referral earnings' });
    }
});

// Admin panel authentication middleware
const requireAdmin = (req, res, next) => {
    if (!req.session.userId) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.redirect('/login');
    }
    if (req.session.userId !== 27) {
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
        }
        return res.status(403).send('Access denied. Admin privileges required.');
    }
    next();
};

// Route to render admin panel
app.get("/admin", requireAdmin, (req, res) => {
    res.render("admin-panel", { session: req.session });
});

// API endpoint to get paginated users for admin panel
app.get("/api/admin/users", requireAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';

        let whereClause = '';
        let countParams = [];
        let selectParams = [];

        if (search) {
            whereClause = 'WHERE firstName LIKE ? OR lastName LIKE ? OR email LIKE ?';
            const searchTerm = `%${search}%`;
            countParams = [searchTerm, searchTerm, searchTerm];
            selectParams = [searchTerm, searchTerm, searchTerm, limit, offset];
        } else {
            selectParams = [limit, offset];
        }

        // Get total count
        const [countRows] = await pool.execute(`
            SELECT COUNT(*) as total FROM users ${whereClause}
        `, countParams);
        const totalUsers = countRows[0].total;

        // Get paginated users - use string interpolation for LIMIT/OFFSET to avoid MySQL2 parameter issues
        let query;
        let queryParams;
        
        if (search) {
            const searchTerm = `%${search}%`;
            query = `
                SELECT id, firstName, lastName, email, referralProgramType, referralCount, 
                       registration_ip, created_at, referralCode, premium, coins, letterCredits
                FROM users 
                WHERE firstName LIKE ? OR lastName LIKE ? OR email LIKE ?
                ORDER BY created_at DESC
                LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
            `;
            queryParams = [searchTerm, searchTerm, searchTerm];
        } else {
            query = `
                SELECT id, firstName, lastName, email, referralProgramType, referralCount, 
                       registration_ip, created_at, referralCode, premium, coins, letterCredits
                FROM users 
                ORDER BY created_at DESC
                LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
            `;
            queryParams = [];
        }
        
        const [rows] = await pool.execute(query, queryParams);
        
        // For admin panel, show full emails (no masking needed)
        res.json({
            users: rows,
            pagination: {
                page,
                limit,
                total: totalUsers,
                totalPages: Math.ceil(totalUsers / limit),
                hasNext: page < Math.ceil(totalUsers / limit),
                hasPrev: page > 1
            }
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// API endpoint to update user's referral program type
app.post("/api/admin/users/:userId/referral-program", requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { programType } = req.body;
        
        if (!['standard', 'offer_5', 'offer_10'].includes(programType)) {
            return res.status(400).json({ error: 'Invalid program type' });
        }
        
        await pool.execute(
            'UPDATE users SET referralProgramType = ? WHERE id = ?',
            [programType, userId]
        );
        
        res.json({ success: true, message: 'Referral program updated successfully' });
    } catch (error) {
        console.error('Error updating referral program:', error);
        res.status(500).json({ error: 'Failed to update referral program' });
    }
});

// API endpoint to get detailed referral earnings with fraud detection
app.get("/api/admin/referrals", requireAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        const status = req.query.status || 'all';

        let whereClause = '';
        let params = [];

        if (status !== 'all') {
            whereClause = 'WHERE re.status = ?';
            params.push(status);
        }

        // Get total count
        const [countRows] = await pool.execute(`
            SELECT COUNT(*) as total FROM referral_earnings re ${whereClause}
        `, params);
        const totalReferrals = countRows[0].total;

        // Get detailed referral data with fraud detection - fix parameter issue
        let query;
        let queryParams;
        
        if (status !== 'all') {
            query = `
                SELECT 
                    re.id,
                    re.referrer_id,
                    re.referred_user_id,
                    re.referrer_ip,
                    re.referred_user_ip,
                    re.user_agent,
                    re.earning_type,
                    re.amount,
                    re.percentage,
                    re.purchase_amount,
                    re.status,
                    re.created_at,
                    u1.firstName as referrer_name,
                    u1.lastName as referrer_lastname,
                    u1.email as referrer_email,
                    u1.registration_ip as referrer_reg_ip,
                    u2.firstName as referred_name,
                    u2.lastName as referred_lastname,
                    u2.email as referred_email,
                    u2.registration_ip as referred_reg_ip,
                    u2.created_at as referred_created_at
                FROM referral_earnings re
                LEFT JOIN users u1 ON re.referrer_id = u1.id
                LEFT JOIN users u2 ON re.referred_user_id = u2.id
                WHERE re.status = ?
                ORDER BY re.created_at DESC
                LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
            `;
            queryParams = [status];
        } else {
            query = `
                SELECT 
                    re.id,
                    re.referrer_id,
                    re.referred_user_id,
                    re.referrer_ip,
                    re.referred_user_ip,
                    re.user_agent,
                    re.earning_type,
                    re.amount,
                    re.percentage,
                    re.purchase_amount,
                    re.status,
                    re.created_at,
                    u1.firstName as referrer_name,
                    u1.lastName as referrer_lastname,
                    u1.email as referrer_email,
                    u1.registration_ip as referrer_reg_ip,
                    u2.firstName as referred_name,
                    u2.lastName as referred_lastname,
                    u2.email as referred_email,
                    u2.registration_ip as referred_reg_ip,
                    u2.created_at as referred_created_at
                FROM referral_earnings re
                LEFT JOIN users u1 ON re.referrer_id = u1.id
                LEFT JOIN users u2 ON re.referred_user_id = u2.id
                ORDER BY re.created_at DESC
                LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
            `;
            queryParams = [];
        }
        
        const [rows] = await pool.execute(query, queryParams);

        // Add fraud detection with IP checking
        const referralsWithFraudCheck = await Promise.all(rows.map(async (referral) => {
            let suspected = false;
            let suspicionReasons = [];

            // This check is now handled in the enhanced fraud detection below

            // Check if registration was too quick (less than 1 minute apart)
            if (referral.referred_created_at) {
                try {
                    const timeDiff = Math.abs(new Date(referral.created_at) - new Date(referral.referred_created_at));
                    if (timeDiff < 60000) { // Less than 1 minute
                        suspected = true;
                        suspicionReasons.push('Registration and referral within 1 minute');
                    }
                } catch (error) {
                    console.error('Error checking time diff:', error);
                }
            }

            // Enhanced fraud detection: Check if IPs were used by other users
            if (referral.referred_user_ip) {
                try {
                    // PRIMARY CHECK: Check if referred user's IP was used by ANY other users (most important for fake accounts)
                    const referredIpQuery = await pool.execute(`
                        SELECT COUNT(*) as count, GROUP_CONCAT(id) as user_ids FROM users 
                        WHERE registration_ip = ? AND id != ?
                    `, [referral.referred_user_ip, referral.referred_user_id]);
                    
                    const otherUsersCount = referredIpQuery[0][0].count;
                    if (otherUsersCount > 0) {
                        suspected = true;
                        suspicionReasons.push(`Referred user IP shared with ${otherUsersCount} other user(s)`);
                    }

                    // ADDITIONAL CHECK: Check if referred user's IP matches the referrer's IP
                    if (referral.referrer_ip && referral.referred_user_ip === referral.referrer_ip) {
                        suspected = true;
                        suspicionReasons.push('Referred user and referrer share the same IP');
                    }
                } catch (error) {
                    console.error('Error checking referred user IP:', error.message);
                }
            }

            // SECONDARY CHECK: Also check referrer IP for completeness
            if (referral.referrer_ip) {
                try {
                    const referrerIpQuery = await pool.execute(`
                        SELECT COUNT(*) as count FROM users 
                        WHERE registration_ip = ? AND id != ?
                    `, [referral.referrer_ip, referral.referrer_id]);
                    
                    if (referrerIpQuery[0][0].count > 0) {
                        suspected = true;
                        suspicionReasons.push(`Referrer IP shared with ${referrerIpQuery[0][0].count} other user(s)`);
                    }
                } catch (error) {
                    console.error('Error checking referrer IP:', error.message);
                }
            }

            return {
                ...referral,
                referrer_email: referral.referrer_email,
                referred_email: referral.referred_email,
                suspected,
                suspicion_reasons: suspicionReasons
            };
        }));

        res.json({
            referrals: referralsWithFraudCheck,
            pagination: {
                page,
                limit,
                total: totalReferrals,
                totalPages: Math.ceil(totalReferrals / limit),
                hasNext: page < Math.ceil(totalReferrals / limit),
                hasPrev: page > 1
            }
        });

    } catch (error) {
        console.error('Error fetching referrals:', error);
        console.error('Error details:', error.message);
        console.error('Stack trace:', error.stack);
        res.status(500).json({ 
            error: 'Failed to fetch referrals',
            details: error.message 
        });
    }
});

// Example API endpoint for when a user makes a purchase
// YOU NEED TO INTEGRATE THIS WITH YOUR ACTUAL PAYMENT SYSTEM
app.post('/api/process-purchase', async (req, res) => {
    try {
        const { userId, amount, isSubscription = false, isSecondMonth = false } = req.body;
        
        // Your existing purchase processing code here...
        // (charge payment, create order, etc.)
        
        // Process referral earning with IP tracking
        await processReferralEarning(userId, amount, isSubscription, isSecondMonth, getRealIP(req), req.get('User-Agent'), null);
        
        res.json({ success: true, message: 'Purchase processed successfully' });
    } catch (error) {
        console.error('Error processing purchase:', error);
        res.status(500).json({ error: 'Failed to process purchase' });
    }
});

// API endpoint to approve a specific referral earning
app.post('/api/admin/approve-referral/:referralId', requireAdmin, async (req, res) => {
    try {
        const { referralId } = req.params;
        
        // Update the referral status to approved
        const [result] = await pool.execute(
            'UPDATE referral_earnings SET status = "approved" WHERE id = ?',
            [referralId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Referral not found' });
        }
        
        res.json({ 
            success: true, 
            message: 'Referral approved successfully. You can mark it as paid when ready.' 
        });
    } catch (error) {
        console.error('Error approving referral:', error);
        res.status(500).json({ error: 'Failed to approve referral' });
    }
});

// API endpoint to mark referral earnings as paid (for admin use)
app.post('/api/admin/pay-earnings/:referrerId', requireAdmin, async (req, res) => {
    try {
        const { referrerId } = req.params;
        
        // Mark all approved earnings as paid for this referrer (no time restriction)
        const [result] = await pool.execute(
            `UPDATE referral_earnings 
             SET status = "paid" 
             WHERE referrer_id = ? 
             AND status = "approved"`,
            [referrerId]
        );
        
        res.json({ 
            success: true, 
            message: `Marked ${result.affectedRows} approved earnings as paid`,
            affectedRows: result.affectedRows 
        });
    } catch (error) {
        console.error('Error marking earnings as paid:', error);
        res.status(500).json({ error: 'Failed to update earnings' });
    }
});

// API endpoint to mark a single referral earning as paid (for admin use)
app.post('/api/admin/mark-paid/:referralId', requireAdmin, async (req, res) => {
    try {
        const { referralId } = req.params;
        
        // Mark specific referral earning as paid
        const [result] = await pool.execute(
            `UPDATE referral_earnings 
             SET status = "paid" 
             WHERE id = ? 
             AND status = "approved"`,
            [referralId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Referral not found or not approved' });
        }
        
        res.json({ 
            success: true, 
            message: 'Referral marked as paid successfully' 
        });
    } catch (error) {
        console.error('Error marking referral as paid:', error);
        res.status(500).json({ error: 'Failed to mark referral as paid' });
    }
});

// =============================================================================
// STRIPE PAYMENT ENDPOINTS
// =============================================================================

// API endpoint to create Stripe checkout session for one-time payments (coins, credits)
app.post('/api/create-one-time-checkout', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const { packageType, amount, price, itemType } = req.body;

        if (!packageType || !amount || !price || !itemType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Server-side price validation - CRITICAL SECURITY FIX
        const validPrices = {
            'basic': 2.99,
            'popular': 7.99,
            'premium': 14.99,
            'mega': 29.99,
            'ultimate': 14.99,  // Ultimate Pack
            'letter-credits': 2.99  // Standard price for letter credits
        };

        if (!validPrices[packageType] || price !== validPrices[packageType]) {
            console.log(`🚨 SECURITY ALERT: User ${req.session.userId} attempted to purchase ${packageType} with invalid price $${price} (expected: $${validPrices[packageType]})`);
            return res.status(400).json({ 
                error: 'Invalid price for this package',
                expectedPrice: validPrices[packageType]
            });
        }

        // Validate amount
        const validAmounts = {
            'basic': 250,
            'popular': 750,
            'premium': 1500,
            'mega': 3500,
            'ultimate': 6000,  // Ultimate Pack
            'letter-credits': 1
        };

        if (!validAmounts[packageType] || amount !== validAmounts[packageType]) {
            console.log(`🚨 SECURITY ALERT: User ${req.session.userId} attempted to purchase ${amount} ${packageType} (expected: ${validAmounts[packageType]})`);
            return res.status(400).json({ 
                error: 'Invalid amount for this package',
                expectedAmount: validAmounts[packageType]
            });
        }

        // Get user info
        const [userRows] = await pool.execute(
            'SELECT email, firstName FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userRows[0];
        
        // Define product names and descriptions
        const productInfo = {
            'basic': { name: 'Starter Pack', description: '250 Coins - Great starter value' },
            'popular': { name: 'Popular Pack', description: '750 Coins - Best value' },
            'premium': { name: 'Premium Pack', description: '1,500 Coins - Maximum value' },
            'mega': { name: 'Mega Pack', description: '3,500 Coins - Ultimate value' },
            'ultimate': { name: 'Ultimate Pack', description: '6,000 Coins - Best value' },
            'letter-credits': { name: 'Letter Credit', description: '1 Letter Credit - Send physical letter' }
        };

        const product = productInfo[packageType];
        if (!product) {
            return res.status(400).json({ error: 'Invalid package type' });
        }

        // Check if user has premium status for letter credits pricing
        let userPremiumStatus = false;
        if (packageType === 'letter-credits') {
            const [premiumRows] = await pool.execute(
                'SELECT premium, premiumType, premiumStartDate, premiumEndDate, premiumCancelled FROM users WHERE id = ?',
                [req.session.userId]
            );
            
            if (premiumRows.length > 0) {
                const user = premiumRows[0];
                userPremiumStatus = user.premium === 1;
            }
        }

        // Get Stripe price IDs from environment variables
        const regularLetterCreditsPrice = process.env.STRIPE_PRICE_LETTER_CREDITS;
        const discountLetterCreditsPrice = process.env.STRIPE_PRICE_LETTER_CREDITS_DISCOUNT;
        
        const shouldUseDiscount = userPremiumStatus && packageType === 'letter-credits';
        
        const stripePriceIds = {
            'basic': process.env.STRIPE_PRICE_BASIC_COINS,
            'popular': process.env.STRIPE_PRICE_POPULAR_COINS,
            'premium': process.env.STRIPE_PRICE_PREMIUM_COINS,
            'mega': process.env.STRIPE_PRICE_MEGA_COINS,
            'ultimate': process.env.STRIPE_PRICE_ULTIMATE_COINS,
            'letter-credits': shouldUseDiscount ? discountLetterCreditsPrice : regularLetterCreditsPrice
        };

        const priceId = stripePriceIds[packageType];
        
        if (!priceId) {
            console.error(`No price ID found for package: ${packageType}`);
            return res.status(400).json({ 
                error: 'Price ID not configured for this package',
                packageType: packageType,
                availablePackages: Object.keys(stripePriceIds)
            });
        }

        // Create Stripe checkout session for one-time payment using your products
        const session = await stripe.checkout.sessions.create({
            customer_email: user.email,
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId, // Use your existing Stripe price ID
                    quantity: 1,
                },
            ],
            mode: 'payment', // One-time payment
            success_url: `${req.protocol}://${req.get('host')}/marketplace?payment=success&type=${itemType}`,
            cancel_url: `${req.protocol}://${req.get('host')}/marketplace?payment=cancelled`,
            metadata: {
                userId: req.session.userId.toString(),
                packageType: packageType,
                itemType: itemType, // 'coins' or 'credits'
                amount: amount.toString(),
                price: price.toString(),
                userFirstName: user.firstName,
                userPremiumStatus: userPremiumStatus.toString(),
                priceType: (userPremiumStatus && packageType === 'letter-credits') ? 'discount' : 'regular'
            },
        });

        // Log the transaction initiation
        await logTransaction({
            userId: req.session.userId,
            userEmail: user.email,
            userName: user.firstName,
            userIP: getRealIP(req),
            userAgent: req.get('User-Agent'),
            transactionType: 'purchase',
            itemType: itemType,
            packageType: packageType,
            amount: amount,
            price: price,
            stripeSessionId: session.id,
            stripeCustomerId: session.customer,
            paymentMethod: 'card',
            status: 'initiated',
            metadata: {
                priceType: (userPremiumStatus && packageType === 'letter-credits') ? 'discount' : 'regular',
                userPremiumStatus: userPremiumStatus,
                browserInfo: req.get('User-Agent')
            }
        });

        res.json({
            success: true,
            url: session.url,
            sessionId: session.id
        });

    } catch (error) {
        console.error('Error creating one-time checkout session:', error);
        
        // Log the failed transaction attempt
        try {
            const [userRows] = await pool.execute('SELECT email, firstName FROM users WHERE id = ?', [req.session.userId]);
            const user = userRows[0] || {};
            
            await logTransaction({
                userId: req.session.userId,
                userEmail: user.email,
                userName: user.firstName,
                userIP: getRealIP(req),
                userAgent: req.get('User-Agent'),
                transactionType: 'purchase',
                itemType: req.body.itemType || 'unknown',
                packageType: req.body.packageType || 'unknown',
                amount: req.body.amount,
                price: req.body.price,
                status: 'failed',
                failureReason: `Checkout creation failed: ${error.message}`,
                metadata: {
                    errorType: 'checkout_creation_error',
                    originalError: error.message
                }
            });
        } catch (logError) {
            console.error('Error logging failed transaction:', logError);
        }
        
        res.status(500).json({
            error: 'Failed to create checkout session',
            details: error.message
        });
    }
});

// API endpoint to create Stripe checkout session
app.post('/api/create-checkout-session', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const { priceId, planType, planName } = req.body;

        if (!priceId || !planType || !planName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check if Stripe is properly configured (temporarily disabled for testing)
        // if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
        //     console.error('Stripe secret key not properly configured');
        //     return res.status(500).json({ error: 'Payment system not configured' });
        // }

        // Get user info
        const [userRows] = await pool.execute(
            'SELECT firstName, email FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userRows[0];

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            customer_email: user.email,
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${req.protocol}://${req.get('host')}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/marketplace`,
            metadata: {
                userId: req.session.userId.toString(),
                planType: planType,
                planName: planName,
                userFirstName: user.firstName
            },
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ 
            error: 'Failed to create checkout session',
            details: error.message,
            type: error.type 
        });
    }
});

// Stripe webhook endpoint for handling payment events
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    let event;
    
    try {
        let bodyStr;
        if (Buffer.isBuffer(req.body)) {
            bodyStr = req.body.toString('utf8');
        } else if (typeof req.body === 'string') {
            bodyStr = req.body;
        } else {
            event = req.body;
        }
        
        if (!event) {
            event = JSON.parse(bodyStr);
        }
    } catch (err) {
        console.error('Failed to parse webhook JSON:', err.message);
        return res.status(400).send(`Webhook Error: Invalid JSON - ${err.message}`);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;
            
            case 'invoice.payment_succeeded':
                const subscriptionData = event.subscription_data || null;
                await handlePaymentSucceeded(event.data.object, subscriptionData);
                break;
            
            case 'customer.subscription.deleted':
                await handleSubscriptionCancelled(event.data.object);
                break;
            
            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object);
                break;
            
            case 'invoice_payment.paid':
                await handleInvoicePaymentPaid(event.data.object);
                break;
        }

        res.json({received: true});
    } catch (error) {
        console.error('❌ Error handling webhook:', error);
        res.status(500).json({ error: 'Webhook handling failed' });
    }
});

// Alternative webhook endpoint at root path for Stripe (in case webhook URL is misconfigured)
// This function is called whenever your server receives a POST request to the root path ("/").
// If you are running your server locally (for example, at http://localhost:3000/), 
// this function will be triggered when a POST request is sent to http://localhost:3000/.
//
// --- How to set this webhook properly ---
// 1. Make sure your server is running and accessible at your desired port (e.g., http://localhost:3000/).
// 2. In your Stripe dashboard (or other service), set the webhook endpoint URL to your local address, such as:
//      http://localhost:3000/
//    (If the service does not allow localhost, you can use a tool like ngrok to expose your local server to the internet.)
// 3. For ngrok, run: ngrok http 3000
//    Then use the generated public URL (e.g., https://abcd1234.ngrok.io/) as your webhook endpoint in Stripe.
// 4. When Stripe (or another service) sends a POST request to this endpoint, this function will handle the event.
//
// Note: For local development, using ngrok or a similar tunneling service is common because many external services cannot reach localhost directly.
app.post('/', express.raw({type: 'application/json'}), async (req, res) => {
    let event;
    
    try {
        let bodyStr;
        if (Buffer.isBuffer(req.body)) {
            bodyStr = req.body.toString('utf8');
        } else if (typeof req.body === 'string') {
            bodyStr = req.body;
        } else {
            event = req.body;
        }
        
        if (!event) {
            event = JSON.parse(bodyStr);
        }
    } catch (err) {
        console.error('Failed to parse webhook JSON:', err.message);
        return res.status(400).send(`Webhook Error: Invalid JSON - ${err.message}`);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;
            
            case 'invoice.payment_succeeded':
                const subscriptionData = event.subscription_data || null;
                await handlePaymentSucceeded(event.data.object, subscriptionData);
                break;
            
            case 'customer.subscription.deleted':
                await handleSubscriptionCancelled(event.data.object);
                break;
            
            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object);
                break;
            
            case 'invoice_payment.paid':
                await handleInvoicePaymentPaid(event.data.object);
                break;
        }

        res.json({received: true});
    } catch (error) {
        console.error('❌ Error handling webhook:', error);
        res.status(500).json({ error: 'Webhook handling failed' });
    }
});

// Handle one-time payment completion (coins, credits)
const handleOneTimePayment = async (session) => {
    const userId = parseInt(session.metadata.userId);
    const packageType = session.metadata.packageType;
    const itemType = session.metadata.itemType; // 'coins' or 'credits'
    const amount = parseInt(session.metadata.amount);
    const price = parseFloat(session.metadata.price);
    const userPremiumStatus = session.metadata.userPremiumStatus === 'true';
    const priceType = session.metadata.priceType || 'regular';
    
    console.log(`💰 Processing one-time payment for user ${userId}: ${amount} ${itemType} (${packageType} package) - $${price}`);
    console.log(`💎 Premium status: ${userPremiumStatus}, Price type: ${priceType}`);
    console.log(`💳 Payment session:`, {
        id: session.id,
        amount_total: session.amount_total,
        customer: session.customer,
        payment_status: session.payment_status
    });
    
    // Security check: Verify user's current premium status for discount pricing
    if (packageType === 'letter-credits' && priceType === 'discount') {
        const [currentUserRows] = await pool.execute(
            'SELECT premium FROM users WHERE id = ?',
            [userId]
        );
        
        const currentPremiumStatus = currentUserRows.length > 0 && currentUserRows[0].premium === 1;
        
        if (!currentPremiumStatus) {
            console.error(`🚨 SECURITY VIOLATION: User ${userId} used discount pricing without premium status!`);
            console.error(`   - Session premium status: ${userPremiumStatus}`);
            console.error(`   - Current premium status: ${currentPremiumStatus}`);
            console.error(`   - Session ID: ${session.id}`);
            
            // Log the security violation but don't fulfill the order
            await pool.execute(`
                INSERT INTO transactions (user_id, type, item_type, package_type, amount, price, stripe_session_id, status, created_at)
                VALUES (?, 'purchase', ?, ?, ?, ?, ?, 'security_violation', NOW())
            `, [userId, itemType, packageType, amount, price, session.id]);
            
            // Also log in comprehensive transaction log
            const [userRows] = await pool.execute('SELECT email, firstName FROM users WHERE id = ?', [userId]);
            const user = userRows[0] || {};
            
            await logTransaction({
                userId: userId,
                userEmail: user.email,
                userName: user.firstName,
                userIP: 'unknown', // IP not available in webhook context
                transactionType: 'purchase',
                itemType: itemType,
                packageType: packageType,
                amount: amount,
                price: price,
                stripeSessionId: session.id,
                status: 'security_violation',
                failureReason: 'Non-premium user attempted to use discount pricing',
                metadata: {
                    sessionPremiumStatus: userPremiumStatus,
                    currentPremiumStatus: currentPremiumStatus,
                    securityViolationType: 'premium_discount_abuse',
                    priceType: priceType
                }
            });
            
            throw new Error(`Security violation: Non-premium user attempted to use discount pricing`);
        }
        
        console.log(`✅ Premium discount validation passed for user ${userId}`);
    }
    
    try {
        if (itemType === 'coins') {
            // Add coins to user account
            await pool.execute(
                'UPDATE users SET coins = COALESCE(coins, 0) + ? WHERE id = ?',
                [amount, userId]
            );
            console.log(`✅ Added ${amount} coins to user ${userId}`);
        } else if (itemType === 'credits') {
            // Add letter credits to user account
            await pool.execute(
                'UPDATE users SET letterCredits = COALESCE(letterCredits, 0) + ? WHERE id = ?',
                [amount, userId]
            );
            console.log(`✅ Added ${amount} letter credits to user ${userId}`);
        }
        
        // Create transaction record
        await pool.execute(`
            INSERT INTO transactions (user_id, type, item_type, package_type, amount, price, stripe_session_id, status, created_at)
            VALUES (?, 'purchase', ?, ?, ?, ?, ?, 'completed', NOW())
        `, [userId, itemType, packageType, amount, price, session.id]);
        
        console.log(`📝 Transaction recorded for user ${userId}: ${packageType} package`);
        
        // Process referral earnings for one-time purchases  
        // Note: IP not available in webhook context, will use registration IP
        await processReferralEarning(userId, price, false, false, null, null, session.id); // Not subscription, not second month
        
        console.log(`✅ One-time payment completed successfully for user ${userId}`);
        
        // Update transaction log to completed
        await updateTransactionLog(session.id, 'completed', null, {
            fulfillmentCompleted: true,
            itemsAdded: `${amount} ${itemType}`,
            referralProcessed: true
        });
        
    } catch (error) {
        console.error(`❌ Error processing one-time payment for user ${userId}:`, error);
        
        // Update transaction log to failed
        await updateTransactionLog(session.id, 'failed', error.message, {
            errorType: 'fulfillment_error',
            originalError: error.message
        });
        
        throw error;
    }
};

// Handle successful checkout completion
const handleCheckoutCompleted = async (session) => {
    const userId = parseInt(session.metadata.userId);
    
    // Check if this is a one-time payment (coins/credits) or subscription
    if (session.metadata.itemType) {
        // Handle one-time payment for coins or credits
        await handleOneTimePayment(session);
        return;
    }
    
    // Handle subscription payment
    const planType = session.metadata.planType;
    const planName = session.metadata.planName;
    const isUpgrade = session.metadata.isUpgrade === 'true';
    
    console.log(`🎯 Processing subscription checkout completion for user ${userId}, plan: ${planName}`);
    console.log(`🔄 Is upgrade: ${isUpgrade}`);
    console.log(`📋 Session data:`, {
        customer: session.customer,
        subscription: session.subscription,
        amount_total: session.amount_total,
        metadata: session.metadata
    });
    
    // If this is an upgrade, cancel the existing subscription first
    if (isUpgrade) {
        try {
            console.log(`🔄 This is an upgrade - checking for existing subscription to cancel...`);
            
            const [existingRows] = await pool.execute(
                'SELECT stripeSubscriptionId, premiumType FROM users WHERE id = ?',
                [userId]
            );
            
            if (existingRows.length > 0 && existingRows[0].stripeSubscriptionId) {
                const oldSubscriptionId = existingRows[0].stripeSubscriptionId;
                const oldPlan = existingRows[0].premiumType;
                
                console.log(`🚫 Cancelling old subscription: ${oldSubscriptionId} (${oldPlan})`);
                
                try {
                    await stripe.subscriptions.cancel(oldSubscriptionId);
                    console.log(`✅ Successfully cancelled old subscription: ${oldSubscriptionId}`);
                } catch (cancelError) {
                    console.error(`⚠️  Failed to cancel old subscription ${oldSubscriptionId}:`, cancelError.message);
                    // Continue with the upgrade even if cancellation fails
                }
            } else {
                console.log(`ℹ️  No existing subscription found to cancel`);
            }
        } catch (error) {
            console.error(`❌ Error handling upgrade cancellation:`, error);
            // Continue with the upgrade
        }
    }
    
    try {
        // Update user's premium status
        const premiumStartDate = new Date();
        let premiumEndDate = new Date(premiumStartDate);
        
        // Calculate end date based on plan type
        switch (planType) {
            case 'monthly':
                premiumEndDate.setMonth(premiumEndDate.getMonth() + 1);
                break;
            case 'half-year':
                premiumEndDate.setMonth(premiumEndDate.getMonth() + 6);
                break;
            case 'yearly':
                premiumEndDate.setFullYear(premiumEndDate.getFullYear() + 1);
                break;
            default:
                premiumEndDate.setMonth(premiumEndDate.getMonth() + 1);
        }

        // Update user premium status
        console.log(`📝 Updating database for user ${userId}:`, {
            premium: 1,
            premiumType: planType,
            premiumStartDate,
            premiumEndDate,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription
        });
        
        console.log(`📝 About to update database with:`, {
            userId,
            planType,
            premiumStartDate,
            premiumEndDate,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription
        });
        
        const result = await pool.execute(
            `UPDATE users SET 
             premium = 1,
             premiumType = ?, 
             premiumStartDate = ?, 
             premiumEndDate = ?, 
             premiumCancelled = 0,
             stripeCustomerId = ?,
             stripeSubscriptionId = ?
             WHERE id = ?`,
            [planType, premiumStartDate, premiumEndDate, session.customer, session.subscription, userId]
        );
        
        console.log(`✅ Database update result:`, result[0]);
        console.log(`📊 Rows affected: ${result[0].affectedRows}, Changed rows: ${result[0].changedRows}`);

        // Process referral earning for first subscription
        // Note: IP not available in webhook context, will use registration IP
        await processReferralEarning(userId, session.amount_total / 100, true, false, null, null, session.id);
        
        console.log(`Premium activated for user ${userId}: ${planName} until ${premiumEndDate}`);
        
    } catch (error) {
        console.error('Error handling checkout completion:', error);
    }
};

// Handle invoice_payment.paid event
const handleInvoicePaymentPaid = async (invoicePayment) => {
    try {
        // Get the invoice from the payment
        const invoice = await stripe.invoices.retrieve(invoicePayment.invoice);
        
        // Process it the same way as invoice.payment_succeeded
        await handlePaymentSucceeded(invoice);
        
    } catch (error) {
        console.error('Error handling invoice payment paid:', error);
    }
};

// Handle successful recurring payment
const handlePaymentSucceeded = async (invoice, subscriptionData = null) => {
    try {
        console.log(`💰 Processing payment succeeded for invoice: ${invoice.id}`);
        
        // Check if this invoice has a subscription (check multiple locations)
        let subscriptionId = invoice.subscription;
        
        // If not found in main field, check nested in line items
        if (!subscriptionId && invoice.lines && invoice.lines.data && invoice.lines.data.length > 0) {
            const lineItem = invoice.lines.data[0];
            if (lineItem.parent && lineItem.parent.subscription_item_details) {
                subscriptionId = lineItem.parent.subscription_item_details.subscription;
            }
        }
        
        if (!subscriptionId) {
            console.log('⚠️  Invoice has no subscription ID - skipping subscription processing');
            return;
        }
        
        
        // Update invoice object with found subscription ID for processing
        invoice.subscription = subscriptionId;
        
        // Get subscription details (use provided data if available, otherwise fetch from Stripe)
        let subscription;
        if (subscriptionData) {
            subscription = subscriptionData;
        } else {
            subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        }
        
        // Find user by Stripe customer ID (use invoice customer if subscription doesn't have one)
        const customerId = subscription.customer || invoice.customer;
        const [userRows] = await pool.execute(
            'SELECT id, premiumStartDate, premiumType FROM users WHERE stripeCustomerId = ?',
            [customerId]
        );
        
        if (userRows.length === 0) {
            // Fallback: Try to find user by email from Stripe customer
            try {
                const customer = await stripe.customers.retrieve(customerId);
                if (customer.email) {
                    const [emailUserRows] = await pool.execute(
                        'SELECT id, premiumStartDate, premiumType FROM users WHERE email = ?',
                        [customer.email]
                    );
                    
                    if (emailUserRows.length > 0) {
                        // Update the customer ID in database for future payments
                        await pool.execute(
                            'UPDATE users SET stripeCustomerId = ? WHERE email = ?',
                            [customerId, customer.email]
                        );
                        userRows.push(emailUserRows[0]);
                    }
                }
            } catch (error) {
                console.error('Error in email fallback lookup:', error.message);
            }
            
            if (userRows.length === 0) {
                console.log('❌ User not found by customer ID or email');
            return;
            }
        }
        
        const user = userRows[0];
        const userId = user.id;
        
        // Check if this is the second payment (for $10 retention program)
        const premiumStartDate = new Date(user.premiumStartDate);
        const paymentDate = new Date(invoice.created * 1000);
        const monthsSinceStart = (paymentDate.getTime() - premiumStartDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
        
        const isSecondMonth = monthsSinceStart >= 1 && monthsSinceStart < 2;
        
        // Update premium end date using Stripe's actual period end or calculate fallback
        let newEndDate;
        if (subscription.current_period_end) {
            newEndDate = new Date(subscription.current_period_end * 1000); // Convert from Unix timestamp
        } else {
            // Fallback: Calculate 30 days from payment date
            newEndDate = new Date(paymentDate.getTime() + (30 * 24 * 60 * 60 * 1000));
        }
        
        // Update premium status and end date in database
        await pool.execute(
            'UPDATE users SET premium = 1, premiumEndDate = ? WHERE id = ?',
            [newEndDate, userId]
        );
        
        
        // Process referral earning
        // Note: IP not available in webhook context, will use registration IP
        await processReferralEarning(userId, invoice.amount_paid / 100, true, isSecondMonth, null, null, invoice.id);
        
        console.log(`Recurring payment processed for user ${userId}, amount: $${invoice.amount_paid / 100}, second month: ${isSecondMonth}`);
        
    } catch (error) {
        console.error('Error handling payment succeeded:', error);
    }
};

// Handle payment failure
const handlePaymentFailed = async (invoice) => {
    try {
        console.log(`💸 Processing payment failure for invoice:`, {
            id: invoice.id,
            customer: invoice.customer,
            subscription: invoice.subscription,
            amount_due: invoice.amount_due,
            attempt_count: invoice.attempt_count
        });
        
        if (!invoice.subscription) {
            console.log('⚠️  Invoice has no subscription ID - skipping processing');
            return;
        }
        
        // Find user by Stripe customer ID
        const [userRows] = await pool.execute(
            'SELECT id, firstName FROM users WHERE stripeCustomerId = ?',
            [invoice.customer]
        );
        
        if (userRows.length === 0) {
            console.log('User not found for customer:', invoice.customer);
            return;
        }
        
        const userId = userRows[0].id;
        const userName = userRows[0].firstName;
        
        console.log(`💸 Payment failed for user ${userId} (${userName})`);
        console.log(`📋 Failure details: Amount $${invoice.amount_due / 100}, Attempt ${invoice.attempt_count}`);
        
        // Note: We don't automatically cancel premium here
        // Stripe will retry payment and eventually cancel the subscription if it keeps failing
        // The premium will naturally expire when premiumEndDate passes
        
        console.log(`⏳ Premium will expire naturally when billing period ends (no extension)`);
        
    } catch (error) {
        console.error('Error handling payment failure:', error);
    }
};

// Handle subscription cancellation
const handleSubscriptionCancelled = async (subscription) => {
    try {
        // Find user by Stripe customer ID
        const [userRows] = await pool.execute(
            'SELECT id FROM users WHERE stripeCustomerId = ?',
            [subscription.customer]
        );
        
        if (userRows.length === 0) {
            console.log('User not found for cancelled subscription:', subscription.customer);
            return;
        }
        
        const userId = userRows[0].id;
        
        // Mark premium as cancelled (but don't remove it immediately - let it expire naturally)
        await pool.execute(
            'UPDATE users SET premiumCancelled = 1 WHERE id = ?',
            [userId]
        );
        
        console.log(`Subscription cancelled for user ${userId}`);
        
    } catch (error) {
        console.error('Error handling subscription cancellation:', error);
    }
};

// Payment success page
app.get('/payment-success', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    
    const sessionId = req.query.session_id;
    
    if (sessionId) {
        try {
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            // You can pass session data to a success page template
            // For now, redirect to marketplace with success message
            return res.redirect('/marketplace?payment=success');
        } catch (error) {
            console.error('Error retrieving session:', error);
        }
    }
    
    res.redirect('/marketplace');
});

// API endpoint to get Stripe publishable key
app.get('/api/stripe/config', (req, res) => {
    res.json({
        publishableKey: STRIPE_PUBLISHABLE_KEY
    });
});

// API endpoint to check if user is logged in
app.get('/api/check-session', (req, res) => {
    res.json({
        loggedIn: !!req.session.userId,
        userId: req.session.userId || null
    });
});

// Test endpoint to verify webhook is reachable
app.get('/webhook', (req, res) => {
    res.json({ 
        message: 'Webhook endpoint is reachable',
        method: 'GET requests not supported, use POST',
        timestamp: new Date().toISOString()
    });
});

// Test endpoint to manually trigger checkout completion (for testing)
app.post('/api/test/checkout-complete', async (req, res) => {
    if (!req.session.userId) {
        console.log('❌ No session found for test checkout completion');
        return res.status(401).json({ error: 'Authentication required - please log in' });
    }
    
    console.log('🧪 Test checkout completion called by user:', req.session.userId);
    
    try {
        // Create a fake checkout session for testing
        const fakeSession = {
            id: 'cs_test_manual_' + Date.now(),
            customer: 'cus_test_manual_' + Date.now(),
            subscription: 'sub_test_manual_' + Date.now(),
            amount_total: 699, // $6.99 in cents
            metadata: {
                userId: req.session.userId.toString(),
                planType: 'monthly',
                planName: 'Premium Monthly',
                userFirstName: 'Test User'
            }
        };
        
        console.log('🧪 Testing checkout completion with fake session:', fakeSession.id);
        
        // Process the fake checkout completion
        await handleCheckoutCompleted(fakeSession);
        
        res.json({ 
            success: true, 
            message: 'Test checkout completion processed',
            sessionId: fakeSession.id
        });
        
    } catch (error) {
        console.error('Error in test checkout completion:', error);
        res.status(500).json({ 
            error: 'Test checkout completion failed',
            details: error.message 
        });
    }
});

// Simple test endpoint to directly update premium status (for testing only)
app.post('/api/test/activate-premium', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required - please log in first' });
    }
    
    try {
        const userId = req.session.userId;
        console.log(`🧪 DIRECT premium activation for user ${userId}`);
        
        // Simple direct database update
        const result = await pool.execute(
            'UPDATE users SET premium = 1, premiumType = ?, premiumStartDate = NOW(), premiumEndDate = DATE_ADD(NOW(), INTERVAL 1 MONTH) WHERE id = ?',
            ['monthly', userId]
        );
        
        console.log(`✅ Direct database update result:`, {
            affectedRows: result[0].affectedRows,
            changedRows: result[0].changedRows,
            userId: userId
        });
        
        if (result[0].affectedRows > 0) {
            // Process referral earning for the subscription
            console.log('💰 Processing referral earnings for test activation...');
            await processReferralEarning(userId, 6.99, true, false, getRealIP(req), req.get('User-Agent'), null); // $6.99 monthly subscription
            
            res.json({ 
                success: true, 
                message: 'Premium activated directly with referral processing',
                userId: userId,
                affectedRows: result[0].affectedRows
            });
        } else {
            res.status(404).json({ error: 'User not found or not updated' });
        }
        
    } catch (error) {
        console.error('❌ Direct premium activation error:', error);
        res.status(500).json({ 
            error: 'Failed to activate premium',
            details: error.message 
        });
    }
});

// Admin endpoint to view comprehensive transaction logs
app.get('/api/admin/transaction-logs', requireAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        const status = req.query.status;
        const userId = req.query.userId;
        const transactionType = req.query.transactionType;

        let whereClause = 'WHERE 1=1';
        let params = [];

        if (status) {
            whereClause += ' AND status = ?';
            params.push(status);
        }
        if (userId) {
            whereClause += ' AND user_id = ?';
            params.push(userId);
        }
        if (transactionType) {
            whereClause += ' AND transaction_type = ?';
            params.push(transactionType);
        }

        // Get total count
        const [countRows] = await pool.execute(`
            SELECT COUNT(*) as total FROM transaction_logs ${whereClause}
        `, params);
        const totalCount = countRows[0].total;

        // Get paginated logs
        const [logs] = await pool.execute(`
            SELECT 
                id, user_id, user_email, user_name, user_ip, 
                transaction_type, item_type, package_type, amount, price, currency,
                stripe_session_id, payment_method, status, failure_reason,
                created_at, updated_at, completed_at, metadata
            FROM transaction_logs 
            ${whereClause}
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        // Parse metadata JSON
        const parsedLogs = logs.map(log => ({
            ...log,
            metadata: log.metadata ? JSON.parse(log.metadata) : null,
            user_email: log.user_email
        }));

        res.json({
            success: true,
            logs: parsedLogs,
            pagination: {
                page,
                limit,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limit)
            },
            filters: { status, userId, transactionType }
        });

    } catch (error) {
        console.error('Error fetching transaction logs:', error);
        res.status(500).json({ 
            error: 'Failed to fetch transaction logs',
            details: error.message 
        });
    }
});

// Admin endpoint to get transaction statistics
app.get('/api/admin/transaction-stats', requireAdmin, async (req, res) => {
    try {
        // Get overall statistics
        const [statusStats] = await pool.execute(`
            SELECT status, COUNT(*) as count, SUM(price) as total_amount
            FROM transaction_logs 
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY status
            ORDER BY count DESC
        `);

        const [typeStats] = await pool.execute(`
            SELECT transaction_type, item_type, COUNT(*) as count, SUM(price) as total_amount
            FROM transaction_logs 
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND status = 'completed'
            GROUP BY transaction_type, item_type
            ORDER BY count DESC
        `);

        const [dailyStats] = await pool.execute(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_transactions,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_transactions,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_transactions,
                SUM(CASE WHEN status = 'completed' THEN price ELSE 0 END) as revenue
            FROM transaction_logs 
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);

        const [suspiciousActivity] = await pool.execute(`
            SELECT 
                user_ip, 
                COUNT(*) as attempt_count,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
                SUM(CASE WHEN status = 'security_violation' THEN 1 ELSE 0 END) as violation_count
            FROM transaction_logs 
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY user_ip
            HAVING failed_count > 3 OR violation_count > 0
            ORDER BY violation_count DESC, failed_count DESC
        `);

        res.json({
            success: true,
            statusStats,
            typeStats,
            dailyStats,
            suspiciousActivity,
            period: 'Last 30 days'
        });

    } catch (error) {
        console.error('Error fetching transaction statistics:', error);
        res.status(500).json({ 
            error: 'Failed to fetch transaction statistics',
            details: error.message 
        });
    }
});

// Debug endpoint to check specific user's balance and recent transactions
app.get('/api/debug/user-balance/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Get user's current balance
        const [userRows] = await pool.execute(
            'SELECT id, firstName, email, coins, letterCredits, premium FROM users WHERE id = ?',
            [userId]
        );
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userRows[0];
        
        // Get user's recent transactions
        const [transactions] = await pool.execute(`
            SELECT * FROM transactions 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 5
        `, [userId]);
        
        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.firstName,
                email: user.email || 'N/A',
                premium: user.premium === 1,
                balance: {
                    coins: user.coins || 0,
                    letterCredits: user.letterCredits || 0
                }
            },
            recentTransactions: transactions
        });
        
    } catch (error) {
        console.error('Error checking user balance:', error);
        res.status(500).json({ 
            error: 'Failed to check user balance',
            details: error.message 
        });
    }
});

// Test endpoint to verify pagination fix
app.get('/api/test/users-pagination', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const offset = (page - 1) * limit;
        
        console.log('Testing pagination with:', { page, limit, offset });

        // Simple test without search first
        const [countRows] = await pool.execute(`
            SELECT COUNT(*) as total FROM users
        `);
        const totalUsers = countRows[0].total;

        // Get paginated users - use string interpolation for debugging
        const [rows] = await pool.execute(`
            SELECT id, firstName, lastName, email, registration_ip, created_at
            FROM users 
            ORDER BY created_at DESC
            LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
        `);
        
        console.log('Query successful, found rows:', rows.length);
        
        // For admin/test endpoints, show full emails
        
        res.json({
            success: true,
            message: 'Pagination is working correctly!',
            users: rows,
            pagination: {
                page,
                limit,
                total: totalUsers,
                totalPages: Math.ceil(totalUsers / limit),
                hasNext: page < Math.ceil(totalUsers / limit),
                hasPrev: page > 1
            }
        });

    } catch (error) {
        console.error('Error testing pagination:', error);
        res.status(500).json({ 
            error: 'Failed to test pagination',
            details: error.message 
        });
    }
});

// Test endpoint to check referrals API without authentication
// Test endpoint for referral earnings (no auth required)
app.get('/api/test/referral-earnings/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        
        // Get detailed referral earnings for this user
        const [earningsRows] = await pool.execute(`
            SELECT 
                re.id,
                re.referred_user_id,
                re.amount,
                re.earning_type,
                re.percentage,
                re.purchase_amount,
                re.status,
                re.created_at,
                u.firstName as referred_name,
                u.lastName as referred_lastname,
                u.email as referred_email,
                u.created_at as referred_join_date
            FROM referral_earnings re
            LEFT JOIN users u ON re.referred_user_id = u.id
            WHERE re.referrer_id = ?
            ORDER BY re.created_at DESC
        `, [userId]);

        // Group earnings by referred user and calculate totals
        const referralDetails = {};
        let totalEarnings = 0;
        let pendingEarnings = 0;
        let approvedEarnings = 0;
        let paidEarnings = 0;

        earningsRows.forEach(earning => {
            const referredUserId = earning.referred_user_id;
            const amount = parseFloat(earning.amount);
            
            totalEarnings += amount;
            
            switch (earning.status) {
                case 'pending':
                    pendingEarnings += amount;
                    break;
                case 'approved':
                    approvedEarnings += amount;
                    break;
                case 'paid':
                    paidEarnings += amount;
                    break;
            }

            if (!referralDetails[referredUserId]) {
                referralDetails[referredUserId] = {
                    user_id: referredUserId,
                    user_name: earning.referred_name + ' ' + (earning.referred_lastname || ''),
                    user_email: earning.referred_email ? maskEmail(earning.referred_email) : 'No email',
                    join_date: earning.referred_join_date,
                    earnings: [],
                    total_earned: 0,
                    pending_amount: 0,
                    approved_amount: 0,
                    paid_amount: 0
                };
            }

            const userDetail = referralDetails[referredUserId];
            userDetail.earnings.push({
                id: earning.id,
                amount: amount,
                type: earning.earning_type,
                status: earning.status,
                date: earning.created_at,
                purchase_amount: earning.purchase_amount
            });

            userDetail.total_earned += amount;
            
            switch (earning.status) {
                case 'pending':
                    userDetail.pending_amount += amount;
                    break;
                case 'approved':
                    userDetail.approved_amount += amount;
                    break;
                case 'paid':
                    userDetail.paid_amount += amount;
                    break;
            }
        });

        res.json({
            success: true,
            message: `Referral earnings for user ID ${userId}`,
            summary: {
                total_earnings: totalEarnings,
                pending_earnings: pendingEarnings,
                approved_earnings: approvedEarnings,
                paid_earnings: paidEarnings,
                total_referred_users: Object.keys(referralDetails).length
            },
            referral_details: Object.values(referralDetails)
        });

    } catch (error) {
        console.error('Error in test referral earnings endpoint:', error);
        res.status(500).json({ error: 'Failed to fetch test referral earnings' });
    }
});

// Test endpoint to add multiple referrals for user ID 30
app.post('/api/test/add-referrals/:userId/:count', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const count = parseInt(req.params.count);
        
        const referrals = [];
        const earnings = [];
        
        const timestamp = Date.now();
        for (let i = 1; i <= count; i++) {
            // Create fake user data
            const fakeUser = {
                firstName: `TestUser${i}`,
                lastName: `Referred`,
                email: `testuser${i}_${timestamp}@example.com`,
                password: 'hashedpassword',
                referralCode: `TEST${i}${timestamp}`,
                referredBy: userId,
                premium: 0,
                coins: 0,
                letterCredits: 0,
                registration_ip: `192.168.1.${100 + i}`
            };
            
            // Insert fake user
            const [userResult] = await pool.execute(`
                INSERT INTO users (firstName, lastName, email, password, referralCode, referredBy, premium, coins, letterCredits, registration_ip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                fakeUser.firstName, fakeUser.lastName, fakeUser.email, fakeUser.password,
                fakeUser.referralCode, fakeUser.referredBy, fakeUser.premium, 
                fakeUser.coins, fakeUser.letterCredits, fakeUser.registration_ip
            ]);
            
            const newUserId = userResult.insertId;
            referrals.push({ id: newUserId, name: `${fakeUser.firstName} ${fakeUser.lastName}` });
            
            // Create referral earning (mix of different types and statuses)
            const earningTypes = ['percentage', 'retention_bonus', 'mixed'];
            const statuses = ['pending', 'paid'];
            const amounts = [10, 15, 20, 25];
            
            const earning = {
                referrer_id: userId,
                referred_user_id: newUserId,
                amount: amounts[i % amounts.length],
                earning_type: earningTypes[i % earningTypes.length],
                status: statuses[i % statuses.length],
                percentage: 10,
                purchase_amount: amounts[i % amounts.length] * 10,
                referrer_ip: '192.168.1.50',
                referred_user_ip: fakeUser.registration_ip,
                user_agent: 'Mozilla/5.0 Test Browser'
            };
            
            const [earningResult] = await pool.execute(`
                INSERT INTO referral_earnings (
                    referrer_id, referred_user_id, amount, earning_type, status, 
                    percentage, purchase_amount, referrer_ip, referred_user_ip, user_agent
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                earning.referrer_id, earning.referred_user_id, earning.amount,
                earning.earning_type, earning.status, earning.percentage,
                earning.purchase_amount, earning.referrer_ip, earning.referred_user_ip,
                earning.user_agent
            ]);
            
            earnings.push({ id: earningResult.insertId, ...earning });
        }
        
        res.json({
            success: true,
            message: `Added ${count} test referrals for user ID ${userId}`,
            referrals,
            earnings
        });
        
    } catch (error) {
        console.error('Error adding test referrals:', error);
        res.status(500).json({ error: 'Failed to add test referrals: ' + error.message });
    }
});

app.get('/api/test/referrals-api', async (req, res) => {
    try {
        // Test the referrals query directly
        const limit = 5;
        const offset = 0;
        
        // Get total count
        const [countRows] = await pool.execute(`
            SELECT COUNT(*) as total FROM referral_earnings re
        `);
        const totalReferrals = countRows[0].total;

        // Get referral data
        const [rows] = await pool.execute(`
            SELECT 
                re.id,
                re.referrer_id,
                re.referred_user_id,
                re.referrer_ip,
                re.referred_user_ip,
                re.earning_type,
                re.amount,
                re.status,
                re.created_at,
                u1.firstName as referrer_name,
                u2.firstName as referred_name
            FROM referral_earnings re
            LEFT JOIN users u1 ON re.referrer_id = u1.id
            LEFT JOIN users u2 ON re.referred_user_id = u2.id
            ORDER BY re.created_at DESC
            LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
        `);

        // Simple fraud check
        const referralsWithCheck = rows.map((referral) => ({
            ...referral,
            suspected: false,
            suspicion_reasons: []
        }));

        res.json({
            success: true,
            message: 'Referrals API test successful!',
            data: {
                total: totalReferrals,
                referrals: referralsWithCheck,
                limit,
                offset
            }
        });

    } catch (error) {
        console.error('Error testing referrals API:', error);
        res.status(500).json({ 
            success: false,
            error: 'Referrals API test failed',
            details: error.message,
            stack: error.stack
        });
    }
});

// Test endpoint to check referral management system
app.get('/api/test/referral-management', async (req, res) => {
    try {
        // Get sample data to show the new system
        const [users] = await pool.execute(`
            SELECT id, firstName, email, registration_ip, created_at
            FROM users 
            ORDER BY created_at DESC 
            LIMIT 5
        `);

        const [referrals] = await pool.execute(`
            SELECT 
                re.id, re.referrer_id, re.referred_user_id,
                re.referrer_ip, re.referred_user_ip, re.amount, re.status,
                u1.firstName as referrer_name,
                u2.firstName as referred_name
            FROM referral_earnings re
            LEFT JOIN users u1 ON re.referrer_id = u1.id
            LEFT JOIN users u2 ON re.referred_user_id = u2.id
            ORDER BY re.created_at DESC 
            LIMIT 5
        `);

        // For admin/test endpoints, show full emails

        res.json({
            success: true,
            message: 'Referral management system is ready!',
            features: {
                userPagination: 'Users API now supports pagination with /api/admin/users?page=1&limit=20',
                referralDetails: 'New detailed referrals API at /api/admin/referrals with fraud detection',
                approvalWorkflow: 'Referrals can be approved with /api/admin/approve-referral/:id',
                manualPayment: 'Approved referrals can be manually marked as paid by admin',
                fraudDetection: 'IP-based fraud detection with suspicion reasons'
            },
            sampleUsers: users,
            sampleReferrals: referrals,
            endpoints: {
                paginatedUsers: '/api/admin/users?page=1&limit=20&search=john',
                detailedReferrals: '/api/admin/referrals?page=1&status=pending',
                approveReferral: 'POST /api/admin/approve-referral/:referralId',
                payEarnings: 'POST /api/admin/pay-earnings/:referrerId'
            }
        });

    } catch (error) {
        console.error('Error testing referral management:', error);
        res.status(500).json({ 
            error: 'Failed to test referral management',
            details: error.message 
        });
    }
});

// Debug endpoint to view IP tracking in users and referral earnings
app.get('/api/debug/ip-tracking', async (req, res) => {
    try {
        // Get recent users with IP addresses
        const [usersWithIP] = await pool.execute(`
            SELECT id, firstName, email, registration_ip, created_at
            FROM users 
            WHERE registration_ip IS NOT NULL
            ORDER BY created_at DESC 
            LIMIT 10
        `);

        // Get recent referral earnings with IP addresses
        const [earningsWithIP] = await pool.execute(`
            SELECT 
                re.id, re.referrer_id, re.referred_user_id,
                re.referrer_ip, re.referred_user_ip, re.user_agent,
                re.amount, re.earning_type, re.created_at,
                u1.firstName as referrer_name,
                u2.firstName as referred_name
            FROM referral_earnings re
            LEFT JOIN users u1 ON re.referrer_id = u1.id
            LEFT JOIN users u2 ON re.referred_user_id = u2.id
            WHERE re.referrer_ip IS NOT NULL OR re.referred_user_ip IS NOT NULL
            ORDER BY re.created_at DESC 
            LIMIT 10
        `);

        // Mask emails for privacy
        // For admin/test endpoints, show full emails

        res.json({
            success: true,
            usersWithIP: usersWithIP,
            earningsWithIP,
            summary: {
                usersWithIP: usersWithIP.length,
                earningsWithIP: earningsWithIP.length
            }
        });

    } catch (error) {
        console.error('Error fetching IP tracking data:', error);
        res.status(500).json({ 
            error: 'Failed to fetch IP tracking data',
            details: error.message 
        });
    }
});

// Debug endpoint to view recent transaction logs (for testing)
app.get('/api/debug/transaction-logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        
        const [logs] = await pool.execute(`
            SELECT 
                id, user_id, user_email, user_name, user_ip, 
                transaction_type, item_type, package_type, amount, price,
                stripe_session_id, status, failure_reason,
                created_at, updated_at, completed_at, metadata
            FROM transaction_logs 
            ORDER BY created_at DESC 
            LIMIT ?
        `, [limit]);

        // Parse metadata and mask email
        const parsedLogs = logs.map(log => ({
            ...log,
            metadata: log.metadata ? JSON.parse(log.metadata) : null,
            user_email: log.user_email
        }));

        res.json({
            success: true,
            logs: parsedLogs,
            total: logs.length
        });

    } catch (error) {
        console.error('Error fetching transaction logs:', error);
        res.status(500).json({ 
            error: 'Failed to fetch transaction logs',
            details: error.message 
        });
    }
});

// Debug endpoint to check recent transactions and payments
app.get('/api/debug/recent-transactions', async (req, res) => {
    try {
        // Get recent transactions
        const [transactions] = await pool.execute(`
            SELECT 
                t.*,
                u.firstName,
                u.email,
                u.letterCredits,
                u.coins
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC 
            LIMIT 10
        `);

        // Get recent Stripe sessions (if any failed to process)
        const recentSessions = transactions.map(t => ({
            id: t.id,
            userId: t.user_id,
            userName: t.firstName,
            email: t.email || 'N/A',
            itemType: t.item_type,
            packageType: t.package_type,
            amount: t.amount,
            price: t.price,
            status: t.status,
            stripeSessionId: t.stripe_session_id,
            createdAt: t.created_at,
            currentBalance: {
                coins: t.coins || 0,
                letterCredits: t.letterCredits || 0
            }
        }));

        res.json({
            success: true,
            recentTransactions: recentSessions,
            totalTransactions: transactions.length
        });

    } catch (error) {
        console.error('Error fetching recent transactions:', error);
        res.status(500).json({ 
            error: 'Failed to fetch transactions',
            details: error.message 
        });
    }
});

// Debug endpoint to check Stripe price ID configuration
app.get('/api/debug/stripe-config', async (req, res) => {
    const priceIds = {
        // Subscriptions
        monthly: process.env.STRIPE_PRICE_MONTHLY_SUB,
        halfYear: process.env.STRIPE_PRICE_HALF_YEAR_SUB,
        yearly: process.env.STRIPE_PRICE_YEARLY_SUB,
        
        // Coins
        basic: process.env.STRIPE_PRICE_BASIC_COINS,
        popular: process.env.STRIPE_PRICE_POPULAR_COINS,
        premium: process.env.STRIPE_PRICE_PREMIUM_COINS,
        mega: process.env.STRIPE_PRICE_MEGA_COINS,
        ultimate: process.env.STRIPE_PRICE_ULTIMATE_COINS,
        
        // Letter Credits
        letterCredits: process.env.STRIPE_PRICE_LETTER_CREDITS,
        letterCreditsDiscount: process.env.STRIPE_PRICE_LETTER_CREDITS_DISCOUNT
    };
    
    const configured = {};
    const missing = {};
    
    Object.entries(priceIds).forEach(([key, value]) => {
        if (value) {
            configured[key] = value.substring(0, 15) + '...'; // Show first 15 chars for security
        } else {
            missing[key] = 'NOT_SET';
        }
    });
    
    res.json({
        configured,
        missing,
        totalConfigured: Object.keys(configured).length,
        totalMissing: Object.keys(missing).length,
        allConfigured: Object.keys(missing).length === 0
    });
});

// Test endpoint to demonstrate transaction logging system
app.post('/api/test/transaction-logging/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { simulateFailure } = req.body;
        
        console.log(`🧪 Testing transaction logging for user ${userId}...`);
        
        // Get user data
        const [userRows] = await pool.execute(
            'SELECT email, firstName FROM users WHERE id = ?',
            [userId]
        );
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userRows[0];
        const sessionId = `cs_test_logging_${Date.now()}`;
        
        // Log initial transaction attempt
        await logTransaction({
            userId: parseInt(userId),
            userEmail: user.email,
            userName: user.firstName,
            userIP: '127.0.0.1',
            userAgent: 'Test-Agent/1.0',
            transactionType: 'purchase',
            itemType: 'credits',
            packageType: 'letter-credits',
            amount: 1,
            price: 2.99,
            stripeSessionId: sessionId,
            stripeCustomerId: `cus_test_${userId}`,
            paymentMethod: 'card',
            status: 'initiated',
            metadata: {
                testMode: true,
                simulateFailure: simulateFailure || false
            }
        });
        
        // Simulate processing
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (simulateFailure) {
            // Update to failed
            await updateTransactionLog(sessionId, 'failed', 'Simulated payment failure', {
                errorCode: 'card_declined',
                testMode: true
            });
            
            res.json({
                success: false,
                message: 'Simulated transaction failure',
                sessionId: sessionId,
                loggedStatus: 'failed'
            });
        } else {
            // Update to completed
            await updateTransactionLog(sessionId, 'completed', null, {
                fulfillmentCompleted: true,
                testMode: true
            });
            
            res.json({
                success: true,
                message: 'Transaction logging test completed',
                sessionId: sessionId,
                loggedStatus: 'completed'
            });
        }
        
    } catch (error) {
        console.error('Error testing transaction logging:', error);
        res.status(500).json({ 
            error: 'Failed to test transaction logging',
            details: error.message 
        });
    }
});

// Test endpoint to simulate premium discount security validation
app.post('/api/test/simulate-discount-security/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { forcePremiumStatus } = req.body; // Force premium status in session metadata
        
        console.log(`🧪 Testing discount security for user ${userId}...`);
        
        // Get user's actual premium status
        const [userRows] = await pool.execute(
            'SELECT premium FROM users WHERE id = ?',
            [userId]
        );
        
        const actualPremiumStatus = userRows.length > 0 && userRows[0].premium === 1;
        const sessionPremiumStatus = forcePremiumStatus !== undefined ? forcePremiumStatus : actualPremiumStatus;
        
        console.log(`📊 Actual premium status: ${actualPremiumStatus}`);
        console.log(`📋 Session premium status: ${sessionPremiumStatus}`);
        
        // Simulate the checkout session with letter credits discount
        const fakeSession = {
            id: `cs_test_discount_${Date.now()}`,
            metadata: {
                userId: userId.toString(),
                packageType: 'letter-credits',
                itemType: 'credits',
                amount: '1',
                price: '2.39', // Discount price
                userPremiumStatus: sessionPremiumStatus.toString(),
                priceType: 'discount'
            },
            payment_status: 'paid',
            amount_total: 239, // $2.39 in cents
            customer: `cus_test_${userId}`
        };
        
        let result;
        try {
            console.log(`🎯 Processing simulated discount payment...`);
            await handleOneTimePayment(fakeSession);
            result = {
                success: true,
                message: 'Discount payment processed successfully',
                securityCheck: 'PASSED'
            };
        } catch (error) {
            result = {
                success: false,
                message: error.message,
                securityCheck: 'FAILED'
            };
        }
        
        // Get transaction record
        const [transactionRows] = await pool.execute(`
            SELECT * FROM transactions 
            WHERE user_id = ? AND stripe_session_id = ?
            ORDER BY created_at DESC 
            LIMIT 1
        `, [userId, fakeSession.id]);
        
        res.json({
            ...result,
            testScenario: {
                actualPremiumStatus,
                sessionPremiumStatus,
                expectedResult: actualPremiumStatus ? 'PASS' : 'FAIL'
            },
            simulatedSession: fakeSession,
            transaction: transactionRows[0] || null
        });
        
    } catch (error) {
        console.error('Error testing discount security:', error);
        res.status(500).json({ 
            error: 'Failed to test discount security',
            details: error.message 
        });
    }
});

// Test endpoint to simulate one-time payment completion
app.post('/api/test/simulate-one-time-payment/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { packageType, amount, price, itemType } = req.body;
        
        if (!packageType || !amount || !price || !itemType) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                required: ['packageType', 'amount', 'price', 'itemType']
            });
        }
        
        console.log(`🧪 Simulating one-time payment for user ${userId}: ${amount} ${itemType} (${packageType}) - $${price}`);
        
        // Simulate the checkout session
        const fakeSession = {
            id: `cs_test_${Date.now()}`,
            metadata: {
                userId: userId.toString(),
                packageType: packageType,
                itemType: itemType,
                amount: amount.toString(),
                price: price.toString()
            },
            payment_status: 'paid',
            amount_total: Math.round(price * 100),
            customer: `cus_test_${userId}`
        };
        
        console.log(`🎯 Processing simulated one-time payment...`);
        await handleOneTimePayment(fakeSession);
        
        // Get updated user balance
        const [balanceRows] = await pool.execute(
            'SELECT coins, letterCredits FROM users WHERE id = ?',
            [userId]
        );
        
        // Get recent transactions
        const [transactionRows] = await pool.execute(`
            SELECT * FROM transactions 
            WHERE user_id = ? AND stripe_session_id = ?
            ORDER BY created_at DESC 
            LIMIT 1
        `, [userId, fakeSession.id]);
        
        res.json({
            success: true,
            message: `Simulated one-time payment: ${amount} ${itemType} for $${price}`,
            simulatedSession: fakeSession,
            newBalance: balanceRows[0] || { coins: 0, letterCredits: 0 },
            transaction: transactionRows[0] || null
        });
        
    } catch (error) {
        console.error('Error simulating one-time payment:', error);
        res.status(500).json({ 
            error: 'Failed to simulate one-time payment',
            details: error.message 
        });
    }
});

// Test endpoint to test cancel and reactivate flow
app.post('/api/test/cancel-reactivate/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        console.log(`🧪 Testing cancel and reactivate flow for user ${userId}...`);
        
        // First, create a test subscription
        await pool.execute(`
            UPDATE users SET 
                premium = 1,
                premiumType = 'monthly',
                premiumStartDate = NOW(),
                premiumEndDate = DATE_ADD(NOW(), INTERVAL 1 MONTH),
                premiumCancelled = 0,
                stripeCustomerId = 'cus_test_cancel_reactivate',
                stripeSubscriptionId = 'sub_test_cancel_reactivate'
            WHERE id = ?
        `, [userId]);
        
        console.log('✅ Created test subscription');
        
        // Simulate cancellation (set to cancel at period end)
        const fakeSession = { req: { session: { userId: userId } } };
        
        // Get user data
        const [beforeCancel] = await pool.execute(
            'SELECT premium, premiumType, premiumCancelled, stripeSubscriptionId FROM users WHERE id = ?',
            [userId]
        );
        
        // Simulate the cancellation logic (without actual Stripe call)
        await pool.execute(
            'UPDATE users SET premiumCancelled = 1, premiumEndDate = DATE_ADD(NOW(), INTERVAL 1 MONTH) WHERE id = ?',
            [userId]
        );
        
        console.log('✅ Simulated cancellation (set to cancel at period end)');
        
        const [afterCancel] = await pool.execute(
            'SELECT premium, premiumType, premiumCancelled, premiumEndDate FROM users WHERE id = ?',
            [userId]
        );
        
        // Simulate reactivation logic (without actual Stripe call)
        await pool.execute(
            'UPDATE users SET premiumCancelled = 0, premiumEndDate = NULL WHERE id = ?',
            [userId]
        );
        
        console.log('✅ Simulated reactivation');
        
        const [afterReactivate] = await pool.execute(
            'SELECT premium, premiumType, premiumCancelled, premiumEndDate FROM users WHERE id = ?',
            [userId]
        );
        
        res.json({
            success: true,
            message: 'Cancel and reactivate flow tested',
            steps: {
                beforeCancel: beforeCancel[0],
                afterCancel: afterCancel[0], 
                afterReactivate: afterReactivate[0]
            },
            explanation: {
                cancellation: 'Set to cancel at period end (allows reactivation)',
                reactivation: 'Removed cancellation flag and end date'
            }
        });
        
    } catch (error) {
        console.error('Error testing cancel/reactivate flow:', error);
        res.status(500).json({ 
            error: 'Failed to test cancel/reactivate flow',
            details: error.message 
        });
    }
});

// API endpoint to get user's transaction history
app.get('/api/user/transactions', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Authentication required" });
    }

    try {
        const [transactions] = await pool.execute(`
            SELECT 
                id,
                type,
                item_type,
                package_type,
                amount,
                price,
                status,
                created_at
            FROM transactions 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 50
        `, [req.session.userId]);

        res.json({
            success: true,
            transactions: transactions
        });

    } catch (error) {
        console.error('Error fetching user transactions:', error);
        res.status(500).json({ 
            error: 'Failed to fetch transactions',
            details: error.message 
        });
    }
});

// API endpoint to get user's current balance (coins and credits)
app.get('/api/user/balance', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Authentication required" });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT coins, letterCredits FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = rows[0];
        
        res.json({
            success: true,
            balance: {
                coins: user.coins || 0,
                letterCredits: user.letterCredits || 0
            }
        });

    } catch (error) {
        console.error('Error fetching user balance:', error);
        res.status(500).json({ 
            error: 'Failed to fetch balance',
            details: error.message 
        });
    }
});

// Test endpoint to completely reset a user's subscription data
app.post('/api/test/reset-user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        console.log(`🧹 Resetting all subscription data for user ${userId}...`);
        
        // Get current user data before reset
        const [beforeRows] = await pool.execute(
            'SELECT premium, premiumType, premiumStartDate, premiumEndDate, premiumCancelled, stripeCustomerId, stripeSubscriptionId FROM users WHERE id = ?',
            [userId]
        );
        
        if (beforeRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const beforeData = beforeRows[0];
        console.log('📊 User data before reset:', beforeData);
        
        // Reset all premium and Stripe related fields
        await pool.execute(`
            UPDATE users SET 
                premium = 0,
                premiumType = NULL,
                premiumStartDate = NULL,
                premiumEndDate = NULL,
                premiumCancelled = 0,
                stripeCustomerId = NULL,
                stripeSubscriptionId = NULL
            WHERE id = ?
        `, [userId]);
        
        // Also remove any referral earnings for this user to clean up completely
        const [earningsResult] = await pool.execute(
            'DELETE FROM referral_earnings WHERE referred_user_id = ?',
            [userId]
        );
        
        console.log(`🗑️  Deleted ${earningsResult.affectedRows} referral earnings for user ${userId}`);
        
        // Get updated user data
        const [afterRows] = await pool.execute(
            'SELECT premium, premiumType, premiumStartDate, premiumEndDate, premiumCancelled, stripeCustomerId, stripeSubscriptionId FROM users WHERE id = ?',
            [userId]
        );
        
        res.json({
            success: true,
            message: `User ${userId} completely reset`,
            before: beforeData,
            after: afterRows[0],
            earningsDeleted: earningsResult.affectedRows
        });
        
    } catch (error) {
        console.error('Error resetting user:', error);
        res.status(500).json({ 
            error: 'Failed to reset user',
            details: error.message 
        });
    }
});

// Test endpoint to set user's premium end date (for testing)
app.post('/api/test/set-user-premium-date/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { months, past, cancelled } = req.body;
        
        // Handle cancellation flag
        if (cancelled !== undefined) {
            await pool.execute(`
                UPDATE users SET premiumCancelled = ? WHERE id = ?
            `, [cancelled ? 1 : 0, userId]);
            console.log(`🔄 Set premiumCancelled = ${cancelled ? 1 : 0} for user ${userId}`);
        }
        
        let newDate;
        if (past) {
            // Set to past date for testing expired subscriptions
            newDate = '2025-09-03 23:59:59';
        } else if (months) {
            // Set to X months from now
            const futureDate = new Date();
            futureDate.setMonth(futureDate.getMonth() + months);
            newDate = futureDate.toISOString().slice(0, 19).replace('T', ' ');
        } else {
            // Default: 1 month from now
            const futureDate = new Date();
            futureDate.setMonth(futureDate.getMonth() + 1);
            newDate = futureDate.toISOString().slice(0, 19).replace('T', ' ');
        }
        
        console.log(`🕐 Setting user ${userId} premium end date to: ${newDate}`);
        
        const result = await pool.execute(`
            UPDATE users SET premiumEndDate = ? WHERE id = ?
        `, [newDate, userId]);
        
        console.log(`✅ Updated user ${userId} premium end date`);
        
        // Get updated user info
        const [userRows] = await pool.execute(`
            SELECT id, premium, premiumType, premiumCancelled, premiumEndDate 
            FROM users WHERE id = ?
        `, [userId]);
        
        res.json({
            success: true,
            message: `User ${userId} premium end date set to ${newDate}`,
            user: userRows[0] || null
        });
        
    } catch (error) {
        console.error('Error setting user premium end date:', error);
        res.status(500).json({ 
            error: 'Failed to set premium end date',
            details: error.message 
        });
    }
});

// Test endpoint to create an active subscription with past billing date (for testing Stripe auto-billing)
app.post('/api/test/create-overdue-subscription/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Set subscription to be 1 month overdue but still active
        const pastDate = new Date();
        pastDate.setMonth(pastDate.getMonth() - 1);
        const pastDateString = pastDate.toISOString().slice(0, 19).replace('T', ' ');
        
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 2); // Started 2 months ago
        const startDateString = startDate.toISOString().slice(0, 19).replace('T', ' ');
        
        console.log(`🧪 Creating overdue subscription for user ${userId}:`);
        console.log(`  Start: ${startDateString}`);
        console.log(`  End (overdue): ${pastDateString}`);
        
        const result = await pool.execute(`
            UPDATE users SET 
                premium = 1,
                premiumType = 'monthly',
                premiumStartDate = ?,
                premiumEndDate = ?,
                premiumCancelled = 0,
                stripeCustomerId = 'cus_test_overdue',
                stripeSubscriptionId = 'sub_test_overdue'
            WHERE id = ?
        `, [startDateString, pastDateString, userId]);
        
        console.log(`✅ Created overdue subscription for user ${userId}`);
        
        // Get updated user info
        const [userRows] = await pool.execute(`
            SELECT id, premium, premiumType, premiumCancelled, premiumEndDate, premiumStartDate
            FROM users WHERE id = ?
        `, [userId]);
        
        res.json({
            success: true,
            message: `User ${userId} now has an overdue subscription (billing was due: ${pastDateString})`,
            user: userRows[0] || null,
            note: "This simulates a subscription that should trigger automatic billing"
        });
        
    } catch (error) {
        console.error('Error creating overdue subscription:', error);
        res.status(500).json({ 
            error: 'Failed to create overdue subscription',
            details: error.message 
        });
    }
});

// Test endpoint to simulate Stripe automatic billing (invoice.payment_succeeded)
app.post('/api/test/simulate-stripe-billing/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Get user's subscription info
        const [userRows] = await pool.execute(
            'SELECT stripeCustomerId, stripeSubscriptionId, premiumStartDate FROM users WHERE id = ?',
            [userId]
        );
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userRows[0];
        
        // Simulate a recurring payment invoice
        const simulatedInvoice = {
            id: `in_test_${Date.now()}`,
            customer: user.stripeCustomerId || 'cus_test_overdue',
            subscription: user.stripeSubscriptionId || 'sub_test_overdue',
            amount_paid: 699, // $6.99 in cents
            billing_reason: 'subscription_cycle',
            created: Math.floor(Date.now() / 1000) // Unix timestamp
        };
        
        // Simulate subscription object
        const simulatedSubscription = {
            id: user.stripeSubscriptionId || 'sub_test_overdue',
            current_period_end: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60) // 30 days from now
        };
        
        console.log(`🧪 Simulating Stripe billing for user ${userId}:`);
        console.log(`  Invoice:`, simulatedInvoice);
        console.log(`  Subscription:`, simulatedSubscription);
        
        // Call our payment succeeded handler
        await handlePaymentSucceeded(simulatedInvoice, simulatedSubscription);
        
        // Get updated user info
        const [updatedUserRows] = await pool.execute(`
            SELECT id, premium, premiumType, premiumCancelled, premiumEndDate, premiumStartDate
            FROM users WHERE id = ?
        `, [userId]);
        
        res.json({
            success: true,
            message: `Simulated Stripe billing for user ${userId}`,
            simulatedInvoice,
            simulatedSubscription: {
                id: simulatedSubscription.id,
                current_period_end: new Date(simulatedSubscription.current_period_end * 1000)
            },
            updatedUser: updatedUserRows[0] || null
        });
        
    } catch (error) {
        console.error('Error simulating Stripe billing:', error);
        res.status(500).json({ 
            error: 'Failed to simulate Stripe billing',
            details: error.message 
        });
    }
});

// Test endpoint to check subscription auto-renewal status
app.get('/api/test/check-subscription/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Get user's subscription info from database
        const [userRows] = await pool.execute(`
            SELECT id, premium, premiumType, premiumStartDate, premiumEndDate, 
                   premiumCancelled, stripeCustomerId, stripeSubscriptionId
            FROM users WHERE id = ?
        `, [userId]);
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userRows[0];
        let stripeSubscription = null;
        let autoRenewalStatus = 'No Stripe subscription';
        
        // If user has a Stripe subscription, check its status
        if (user.stripeSubscriptionId && user.stripeSubscriptionId !== 'sub_test_overdue') {
            try {
                stripeSubscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
                
                // Determine auto-renewal status
                if (stripeSubscription.status === 'canceled') {
                    autoRenewalStatus = '❌ Canceled - No auto-renewal';
                } else if (stripeSubscription.cancel_at_period_end) {
                    autoRenewalStatus = '⚠️ Will cancel at period end - No future renewals';
                } else if (stripeSubscription.status === 'active') {
                    autoRenewalStatus = '✅ Active - Auto-renewal enabled';
                } else {
                    autoRenewalStatus = `⚠️ Status: ${stripeSubscription.status}`;
                }
            } catch (stripeError) {
                autoRenewalStatus = `❌ Error checking Stripe: ${stripeError.message}`;
            }
        }
        
        res.json({
            success: true,
            userId: parseInt(userId),
            localDatabase: {
                premium: Boolean(user.premium),
                premiumType: user.premiumType,
                premiumStartDate: user.premiumStartDate,
                premiumEndDate: user.premiumEndDate,
                premiumCancelled: Boolean(user.premiumCancelled),
                stripeCustomerId: user.stripeCustomerId,
                stripeSubscriptionId: user.stripeSubscriptionId
            },
            stripeSubscription: stripeSubscription ? {
                id: stripeSubscription.id,
                status: stripeSubscription.status,
                cancel_at_period_end: stripeSubscription.cancel_at_period_end,
                current_period_start: new Date(stripeSubscription.current_period_start * 1000),
                current_period_end: new Date(stripeSubscription.current_period_end * 1000),
                next_billing: new Date(stripeSubscription.current_period_end * 1000)
            } : null,
            autoRenewalStatus: autoRenewalStatus,
            recommendations: [
                stripeSubscription?.status === 'active' && !stripeSubscription.cancel_at_period_end ? 
                    '✅ Auto-renewal is working correctly' : 
                    '⚠️ Auto-renewal may not work - check Stripe status'
            ]
        });
        
    } catch (error) {
        console.error('Error checking subscription status:', error);
        res.status(500).json({ 
            error: 'Failed to check subscription status',
            details: error.message 
        });
    }
});

// Test endpoint to simulate system date change (for testing expiration logic)
let simulatedDate = null;

// Override Date constructor when simulation is active
const originalDate = Date;
global.Date = class extends originalDate {
    constructor(...args) {
        if (args.length === 0 && simulatedDate) {
            super(simulatedDate);
        } else {
            super(...args);
        }
    }
    
    static now() {
        return simulatedDate ? new Date(simulatedDate).getTime() : originalDate.now();
    }
};

app.post('/api/test/set-system-date', async (req, res) => {
    try {
        const { date, reset } = req.body;
        
        if (reset) {
            // Reset to real date
            simulatedDate = null;
            global.Date = originalDate;
            console.log('🕐 System date reset to real time');
            
            res.json({
                success: true,
                message: 'System date reset to real time',
                currentDate: new Date(),
                simulated: false
            });
        } else if (date) {
            // Set simulated date
            simulatedDate = date;
            console.log(`🕐 System date set to simulated: ${simulatedDate}`);
            
            res.json({
                success: true,
                message: `System date set to: ${simulatedDate}`,
                currentDate: new Date(),
                simulated: true,
                simulatedDate: simulatedDate
            });
        } else {
            res.json({
                success: true,
                message: 'Current date info',
                currentDate: new Date(),
                simulated: !!simulatedDate,
                simulatedDate: simulatedDate
            });
        }
        
    } catch (error) {
        console.error('Error setting system date:', error);
        res.status(500).json({ 
            error: 'Failed to set system date',
            details: error.message 
        });
    }
});

// Test endpoint to manually trigger subscription expiration check
app.post('/api/test/check-expiration/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Get user's subscription info
        const [userRows] = await pool.execute(`
            SELECT id, premium, premiumType, premiumCancelled, premiumEndDate, premiumStartDate
            FROM users WHERE id = ?
        `, [userId]);
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userRows[0];
        console.log(`🧪 Testing expiration for user ${userId}:`, {
            premium: user.premium,
            premiumEndDate: user.premiumEndDate,
            premiumCancelled: user.premiumCancelled,
            currentDate: new Date()
        });
        
        let expired = false;
        let action = 'No action needed';
        
        // Check if subscription should expire (same logic as /api/subscription-details)
        if (user.premium && user.premiumCancelled && user.premiumEndDate) {
            const now = new Date();
            const endDate = new Date(user.premiumEndDate);
            
            console.log(`⏰ Checking expiration: now=${now.toISOString()}, endDate=${endDate.toISOString()}`);
            
            if (now >= endDate) {
                console.log('🚫 Subscription has expired - removing premium status');
                
                // Set premium to false
                await pool.execute(
                    'UPDATE users SET premium = 0 WHERE id = ?',
                    [userId]
                );
                
                expired = true;
                action = 'Premium status removed due to expiration';
            } else {
                action = 'Subscription cancelled but still active';
            }
        } else if (user.premium && !user.premiumCancelled) {
            action = 'Active subscription (not cancelled)';
        } else if (!user.premium) {
            action = 'User is not premium';
        }
        
        // Get updated user info
        const [updatedUserRows] = await pool.execute(`
            SELECT id, premium, premiumType, premiumCancelled, premiumEndDate, premiumStartDate
            FROM users WHERE id = ?
        `, [userId]);
        
        res.json({
            success: true,
            userId: parseInt(userId),
            expired: expired,
            action: action,
            beforeCheck: user,
            afterCheck: updatedUserRows[0],
            currentSystemDate: new Date(),
            simulated: !!simulatedDate
        });
        
    } catch (error) {
        console.error('Error checking expiration:', error);
        res.status(500).json({ 
            error: 'Failed to check expiration',
            details: error.message 
        });
    }
});

// Test endpoint to simulate upgrade scenario
app.post('/api/test/simulate-upgrade/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { newPlan } = req.body;
        
        if (!newPlan) {
            return res.status(400).json({ error: 'newPlan is required in request body' });
        }
        
        // Get current subscription
        const [rows] = await pool.execute(
            'SELECT premiumType, stripeSubscriptionId, stripeCustomerId FROM users WHERE id = ?',
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = rows[0];
        console.log(`🧪 Simulating upgrade for user ${userId}:`);
        console.log(`📊 Current: ${user.premiumType}, Target: ${newPlan}`);
        console.log(`🔗 Stripe IDs: Customer ${user.stripeCustomerId}, Subscription ${user.stripeSubscriptionId}`);
        
        // Simulate the upgrade checkout completion
        const fakeSession = {
            metadata: {
                userId: userId.toString(),
                planType: newPlan,
                planName: `Premium ${newPlan.charAt(0).toUpperCase() + newPlan.slice(1)}`,
                isUpgrade: 'true',
                oldPlan: user.premiumType
            },
            customer: user.stripeCustomerId || 'cus_test_upgrade',
            subscription: 'sub_test_new_plan',
            amount_total: 2999
        };
        
        console.log(`🎯 Processing simulated upgrade checkout...`);
        await handleCheckoutCompleted(fakeSession);
        
        // Get updated user data
        const [updatedRows] = await pool.execute(
            'SELECT premiumType, stripeSubscriptionId, stripeCustomerId, premiumStartDate, premiumEndDate FROM users WHERE id = ?',
            [userId]
        );
        
        res.json({
            success: true,
            message: `Simulated upgrade from ${user.premiumType} to ${newPlan}`,
            before: user,
            after: updatedRows[0],
            simulatedSession: fakeSession
        });
        
    } catch (error) {
        console.error('Error simulating upgrade:', error);
        res.status(500).json({ 
            error: 'Failed to simulate upgrade',
            details: error.message 
        });
    }
});

// Test endpoint to simulate cancellation (without session)
app.post('/api/test/cancel-subscription/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Get current subscription details
        const [rows] = await pool.execute(
            'SELECT premiumType, premiumStartDate, premiumEndDate, stripeSubscriptionId, stripeCustomerId FROM users WHERE id = ?',
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = rows[0];
        console.log(`🧪 Testing cancellation for user ${userId}:`, user);

        // Cancel the subscription in Stripe first
        if (user.stripeSubscriptionId) {
            try {
                console.log(`🚫 Cancelling Stripe subscription: ${user.stripeSubscriptionId}`);
                const cancelledSubscription = await stripe.subscriptions.cancel(user.stripeSubscriptionId);
                console.log(`✅ Stripe subscription cancelled successfully`);
                console.log(`📅 Access will end at: ${new Date(cancelledSubscription.current_period_end * 1000)}`);
                
                // Update our database with the actual end date from Stripe
                await pool.execute(
                    'UPDATE users SET premiumCancelled = 1, premiumEndDate = ? WHERE id = ?',
                    [new Date(cancelledSubscription.current_period_end * 1000), userId]
                );
                
                res.json({
                    success: true,
                    message: 'Subscription cancelled successfully in both Stripe and database',
                    stripeEndDate: new Date(cancelledSubscription.current_period_end * 1000),
                    stripeResponse: {
                        id: cancelledSubscription.id,
                        status: cancelledSubscription.status,
                        current_period_end: cancelledSubscription.current_period_end
                    }
                });
            } catch (stripeError) {
                console.error('❌ Error cancelling Stripe subscription:', stripeError);
                res.status(500).json({
                    error: 'Failed to cancel in Stripe',
                    stripeError: stripeError.message,
                    details: 'This indicates Stripe API issues or invalid subscription ID'
                });
            }
        } else {
            res.status(400).json({
                error: 'No Stripe subscription ID found',
                user: user,
                message: 'Cannot cancel in Stripe without subscription ID'
            });
        }
        
    } catch (error) {
        console.error('Error testing cancellation:', error);
        res.status(500).json({ 
            error: 'Failed to test cancellation',
            details: error.message 
        });
    }
});

// Test endpoint to check getActualPremiumStatus function
app.get('/api/test/check-premium-status/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Get user data
        const [userRows] = await pool.execute(`
            SELECT id, premium, premiumType, premiumStartDate, premiumEndDate, premiumCancelled
            FROM users WHERE id = ?
        `, [userId]);
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userRows[0];
        
        // Test the getActualPremiumStatus function
        const actualPremiumStatus = getActualPremiumStatus(user);
        
        // Also check the raw calculation
        const now = new Date();
        const endDate = user.premiumEndDate ? new Date(user.premiumEndDate) : null;
        
        res.json({
            success: true,
            userId: parseInt(userId),
            user: {
                premium: Boolean(user.premium),
                premiumType: user.premiumType,
                premiumStartDate: user.premiumStartDate,
                premiumEndDate: user.premiumEndDate,
                premiumCancelled: Boolean(user.premiumCancelled)
            },
            calculations: {
                currentDate: now,
                endDate: endDate,
                isExpired: endDate ? now >= endDate : 'No end date',
                actualPremiumStatus: actualPremiumStatus
            },
            simulated: !!simulatedDate,
            simulatedDate: simulatedDate
        });
        
    } catch (error) {
        console.error('Error checking premium status:', error);
        res.status(500).json({ 
            error: 'Failed to check premium status',
            details: error.message 
        });
    }
});

// Test endpoint to simulate first subscription (for testing $10 program)
app.post('/api/test/simulate-first-subscription/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        console.log(`🧪 Simulating first subscription for user ${userId}`);
        
        // Simulate a first subscription with $6.99 payment
        await processReferralEarning(userId, 6.99, true, false, getRealIP(req), req.get('User-Agent'), null); // isSubscription=true, isSecondMonth=false
        
        // Get referral earnings to see if $10 was awarded
        const [earningsRows] = await pool.execute(`
            SELECT * FROM referral_earnings 
            WHERE referred_user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 5
        `, [userId]);
        
        res.json({
            success: true,
            message: `Simulated first subscription for user ${userId}`,
            testParameters: {
                userId: userId,
                amount: 6.99,
                isSubscription: true,
                isSecondMonth: false
            },
            recentEarnings: earningsRows
        });
        
    } catch (error) {
        console.error('Error simulating first subscription:', error);
        res.status(500).json({ 
            error: 'Failed to simulate first subscription',
            details: error.message 
        });
    }
});

// Test endpoint to clean up duplicate referral earnings
app.post('/api/test/cleanup-duplicate-earnings', async (req, res) => {
    try {
        console.log('🧹 Cleaning up duplicate referral earnings...');
        
        // Find duplicates: same referrer_id, referred_user_id, and earning_type
        const [duplicates] = await pool.execute(`
            SELECT referrer_id, referred_user_id, earning_type, COUNT(*) as count
            FROM referral_earnings 
            GROUP BY referrer_id, referred_user_id, earning_type
            HAVING COUNT(*) > 1
        `);
        
        let totalDeleted = 0;
        
        for (const dup of duplicates) {
            console.log(`🔍 Found ${dup.count} duplicates for referrer ${dup.referrer_id}, user ${dup.referred_user_id}, type ${dup.earning_type}`);
            
            // Keep only the first (oldest) record, delete the rest
            const [allRecords] = await pool.execute(`
                SELECT id FROM referral_earnings 
                WHERE referrer_id = ? AND referred_user_id = ? AND earning_type = ?
                ORDER BY created_at ASC
            `, [dup.referrer_id, dup.referred_user_id, dup.earning_type]);
            
            // Delete all except the first one
            const toDelete = allRecords.slice(1); // Skip first record
            
            for (const record of toDelete) {
                await pool.execute('DELETE FROM referral_earnings WHERE id = ?', [record.id]);
                totalDeleted++;
                console.log(`🗑️  Deleted duplicate earning ID ${record.id}`);
            }
        }
        
        res.json({
            success: true,
            message: `Cleaned up ${totalDeleted} duplicate earnings`,
            duplicatesFound: duplicates.length,
            totalDeleted: totalDeleted
        });
        
    } catch (error) {
        console.error('Error cleaning up duplicates:', error);
        res.status(500).json({ 
            error: 'Failed to cleanup duplicates',
            details: error.message 
        });
    }
});

// Test endpoint to reset all premium/subscription data
app.post('/api/test/reset-all-subscriptions', async (req, res) => {
    try {
        console.log('🧹 Resetting all premium and subscription data...');
        
        // Reset all premium and subscription related fields
        const result = await pool.execute(`
            UPDATE users SET 
                premium = 0,
                premiumType = NULL,
                premiumStartDate = NULL,
                premiumEndDate = NULL,
                premiumCancelled = 0,
                stripeCustomerId = NULL,
                stripeSubscriptionId = NULL
        `);
        
        console.log(`✅ Reset ${result[0].affectedRows} users`);
        
        // Also clear all referral earnings
        const earningsResult = await pool.execute('DELETE FROM referral_earnings');
        console.log(`🗑️ Deleted ${earningsResult[0].affectedRows} referral earnings`);
        
        res.json({
            success: true,
            message: `Reset ${result[0].affectedRows} users and deleted ${earningsResult[0].affectedRows} referral earnings`,
            usersReset: result[0].affectedRows,
            earningsDeleted: earningsResult[0].affectedRows
        });
        
    } catch (error) {
        console.error('Error resetting subscriptions:', error);
        res.status(500).json({ 
            error: 'Failed to reset subscriptions',
            details: error.message 
        });
    }
});

// Simple endpoint to set user 30's end date to October 8th
app.post('/api/test/set-oct8', async (req, res) => {
    try {
        // Set user 30's end date to October 8th, 2025
        await pool.execute(
            'UPDATE users SET premiumEndDate = ? WHERE id = ?',
            ['2025-10-08 23:59:59', 30]
        );
        
        const [rows] = await pool.execute(
            'SELECT id, firstName, premium, premiumCancelled, premiumEndDate, premiumStartDate, premiumType FROM users WHERE id = ?',
            [30]
        );
        
        res.json({
            success: true,
            message: `User 30 end date set to October 8th, 2025`,
            user: rows[0]
        });
    } catch (error) {
        console.error('Error setting end date:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test endpoint to check if boosts column exists
app.get('/api/test/check-boosts', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, firstName, coins, boosts FROM users WHERE id = 30'
        );
        
        res.json({
            success: true,
            message: 'Boosts column check',
            user: rows[0] || 'User not found'
        });
    } catch (error) {
        console.error('Error checking boosts column:', error);
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to purchase items with coins
app.post('/api/purchase-with-coins', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const { itemType, amount, price } = req.body;
        
        if (!itemType || !amount || !price) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Server-side price validation - CRITICAL SECURITY FIX
        const validPrices = {
            'boosts': 250,
            'random-box': 250
        };

        if (!validPrices[itemType] || price !== validPrices[itemType]) {
            console.log(`🚨 SECURITY ALERT: User ${req.session.userId} attempted to purchase ${itemType} with invalid price ${price} (expected: ${validPrices[itemType]})`);
            return res.status(400).json({ 
                error: 'Invalid price for this item',
                expectedPrice: validPrices[itemType]
            });
        }

        // Validate amount
        if (amount !== 1) {
            console.log(`🚨 SECURITY ALERT: User ${req.session.userId} attempted to purchase ${amount} ${itemType} (expected: 1)`);
            return res.status(400).json({ 
                error: 'Invalid amount for this item',
                expectedAmount: 1
            });
        }

        console.log(`🪙 Processing coin purchase: ${itemType} x${amount} for ${price} coins`);

        // Get user's current coin balance
        const [userRows] = await pool.execute(
            'SELECT coins, boosts FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userRows[0];
        
        if (user.coins < price) {
            return res.status(400).json({ 
                error: 'Insufficient coins',
                currentCoins: user.coins,
                requiredCoins: price
            });
        }

        // Process the purchase based on item type
        switch (itemType) {
            case 'boosts':
                await pool.execute(
                    'UPDATE users SET coins = coins - ?, boosts = boosts + ? WHERE id = ?',
                    [price, amount, req.session.userId]
                );
                console.log(`✅ Added ${amount} boosts to user ${req.session.userId}`);
                break;
                
            case 'random-box':
                // For now, just give random coins as reward
                const randomReward = Math.floor(Math.random() * 100) + 50; // 50-150 coins
                await pool.execute(
                    'UPDATE users SET coins = coins - ? + ? WHERE id = ?',
                    [price, randomReward, req.session.userId]
                );
                console.log(`✅ Random box opened: user ${req.session.userId} got ${randomReward} coins`);
                break;
                
            default:
                return res.status(400).json({ error: 'Invalid item type' });
        }

        // Get updated user data
        const [updatedRows] = await pool.execute(
            'SELECT coins, boosts FROM users WHERE id = ?',
            [req.session.userId]
        );

        res.json({
            success: true,
            message: `Successfully purchased ${itemType}`,
            newBalance: {
                coins: updatedRows[0].coins,
                boosts: updatedRows[0].boosts
            }
        });

    } catch (error) {
        console.error('Error processing coin purchase:', error);
        res.status(500).json({ error: 'Failed to process purchase' });
    }
});

// Test endpoint to manually process referral earning
app.post('/api/test/process-referral', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
        const userId = req.session.userId;
        const { amount = 6.99, isSubscription = true, isSecondMonth = false } = req.body;
        
        console.log(`🧪 Manual referral processing test for user ${userId}`);
        
        // Process referral earning with IP tracking
        await processReferralEarning(userId, amount, isSubscription, isSecondMonth, getRealIP(req), req.get('User-Agent'), null);
        
        res.json({
            success: true,
            message: 'Referral processing completed',
            userId: userId,
            amount: amount,
            isSubscription: isSubscription
        });
        
    } catch (error) {
        console.error('Error in manual referral processing:', error);
        res.status(500).json({ 
            error: 'Failed to process referral',
            details: error.message 
        });
    }
});

// Test endpoint to check database schema
app.get('/api/test/db-schema', async (req, res) => {
    try {
        // Check users table structure
        const [columns] = await pool.execute('DESCRIBE users');
        
        const stripeColumns = columns.filter(col => 
            col.Field.includes('stripe') || 
            col.Field.includes('premium')
        );
        
        res.json({
            success: true,
            allColumns: columns.map(col => ({
                field: col.Field,
                type: col.Type,
                null: col.Null,
                default: col.Default
            })),
            stripeColumns: stripeColumns.map(col => ({
                field: col.Field,
                type: col.Type,
                null: col.Null,
                default: col.Default
            }))
        });
        
    } catch (error) {
        console.error('Error checking database schema:', error);
        res.status(500).json({ 
            error: 'Failed to check database schema',
            details: error.message 
        });
    }
});

// Test endpoint to check referral status
app.get('/api/test/referral-status', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
        const userId = req.session.userId;
        
        // Check if user has a referrer
        const [userRows] = await pool.execute(
            'SELECT id, firstName, referredBy, referralCode FROM users WHERE id = ?',
            [userId]
        );
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userRows[0];
        let referrerInfo = null;
        
        if (user.referredBy) {
            const [referrerRows] = await pool.execute(
                'SELECT id, firstName, referralProgramType FROM users WHERE id = ?',
                [user.referredBy]
            );
            if (referrerRows.length > 0) {
                referrerInfo = referrerRows[0];
            }
        }
        
        // Check existing earnings
        const [earningsRows] = await pool.execute(
            'SELECT * FROM referral_earnings WHERE referred_user_id = ?',
            [userId]
        );
        
        res.json({
            userId: userId,
            userName: user.firstName,
            hasReferrer: !!user.referredBy,
            referrer: referrerInfo,
            existingEarnings: earningsRows,
            referralCode: user.referralCode
        });
        
    } catch (error) {
        console.error('Error checking referral status:', error);
        res.status(500).json({ error: 'Failed to check referral status' });
    }
});

// Test endpoint to check Stripe configuration
app.get('/api/stripe/test', async (req, res) => {
    try {
        const hasSecretKey = !!process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_placeholder';
        const hasPublishableKey = !!process.env.STRIPE_PUBLISHABLE_KEY && process.env.STRIPE_PUBLISHABLE_KEY !== 'pk_test_placeholder';
        const hasWebhookSecret = !!process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_WEBHOOK_SECRET !== 'whsec_placeholder';
        
        if (!hasSecretKey) {
            return res.json({
                configured: false,
                error: 'Stripe secret key not configured',
                secretKey: process.env.STRIPE_SECRET_KEY ? 'Set but placeholder' : 'Not set'
            });
        }

        // Try to make a simple Stripe API call
        const prices = await stripe.prices.list({ limit: 1 });
        
        res.json({
            configured: true,
            secretKey: hasSecretKey ? 'Configured' : 'Missing',
            publishableKey: hasPublishableKey ? 'Configured' : 'Missing',
            webhookSecret: hasWebhookSecret ? 'Configured' : 'Missing',
            apiTest: 'Success',
            pricesCount: prices.data.length
        });
    } catch (error) {
        res.json({
            configured: false,
            error: error.message,
            type: error.type,
            code: error.code
        });
    }
});


app.get('/api/user/status', async (req, res) => {
    // User check
    if (!req.session.userId) {
        // It's better to send a 401 Unauthorized status for API routes
        return res.status(401).json({ error: "Authentication required." });
    }
    try {
        // Get user with premium status including cancelled subscriptions
        const [rows] = await pool.execute(
            'SELECT id, firstName, letterCredits, avatar, completedProfile, coins, boosts, premium, premiumType, premiumStartDate, premiumCancelled, premiumEndDate FROM users WHERE id = ?', 
            [req.session.userId] // Pass parameters as an array
        );


        if (rows.length === 0) {
            // A 404 is appropriate here since the user ID was not found
            return res.status(404).json({ error: "User not found." });
        }

        // Determine actual premium status (including cancelled but not expired)
        const actualPremiumStatus = getActualPremiumStatus(rows[0]);
        
        // If cancelled subscription has expired, update database
        if (rows[0].premiumCancelled && !actualPremiumStatus && rows[0].premium) {
            await pool.execute(
                'UPDATE users SET premium = false WHERE id = ?',
                [req.session.userId]
            );
        }

        // Prepare subscription details if user has premium
        let subscription = null;
        if (actualPremiumStatus && rows[0].premiumType && rows[0].premiumStartDate) {
            // Use premiumEndDate if available, otherwise calculate from start date
            let endDate;
            if (rows[0].premiumEndDate) {
                endDate = rows[0].premiumEndDate;
            } else {
                // Fallback calculation for older records
                const startDate = new Date(rows[0].premiumStartDate);
                switch (rows[0].premiumType) {
                    case 'monthly':
                        endDate = new Date(startDate.getTime() + (30 * 24 * 60 * 60 * 1000));
                        break;
                    case 'half-year':
                        endDate = new Date(startDate.getTime() + (6 * 30 * 24 * 60 * 60 * 1000));
                        break;
                    case 'yearly':
                        endDate = new Date(startDate.getTime() + (365 * 24 * 60 * 60 * 1000));
                        break;
                    default:
                        endDate = new Date(startDate.getTime() + (30 * 24 * 60 * 60 * 1000));
                }
            }
            
            subscription = {
                type: rows[0].premiumType,
                startDate: rows[0].premiumStartDate,
                endDate: endDate,
                cancelled: Boolean(rows[0].premiumCancelled)
            };
        }

        const currentUser = {
            id: rows[0].id,
            name: rows[0].firstName,
            letterCredits: rows[0].letterCredits || 0, 
            avatar: rows[0].avatar || DEFAULT_AVATAR,
            completedProfile: rows[0].completedProfile,
            coins: rows[0].coins || 0,
            boosts: rows[0].boosts || 0,
            premium: actualPremiumStatus,
            subscription: subscription
        };
        res.json(currentUser);

    } catch (error) {
        console.error("Failed to get user status:", error);
        res.status(500).json({ error: "An internal server error occurred." });
    }
});

app.get('/api/profiles', async (req, res) => {
    // 1. Authorization Check
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // 2. Get all necessary data for the current user
        const [currentUserRows] = await pool.execute(
            'SELECT interests, premium, premiumType, premiumStartDate, premiumCancelled, pastProfiles, currentProfiles, lastTimeProfilesRefresh FROM users WHERE id = ?', 
            [req.session.userId]
        );
        
        if (currentUserRows.length === 0) {
            return res.status(404).json({ error: "Current user not found." });
        }

        const currentUser = currentUserRows[0];
        
        // Determine actual premium status (including cancelled but not expired)
        const isPremium = getActualPremiumStatus(currentUser);
        
        // If cancelled subscription has expired, update database
        if (currentUser.premiumCancelled && !isPremium && currentUser.premium) {
            await pool.execute(
                'UPDATE users SET premium = false WHERE id = ?',
                [req.session.userId]
            );
        }
        const lastRefresh = currentUser.lastTimeProfilesRefresh ? new Date(currentUser.lastTimeProfilesRefresh) : null;
        let currentProfiles = currentUser.currentProfiles || [];

        if (typeof currentProfiles === 'string') {
            try {
                currentProfiles = JSON.parse(currentProfiles);
            } catch {
                currentProfiles = [];
            }
        }

        if (!Array.isArray(currentProfiles)) {
            currentProfiles = [];
        }

        currentProfiles = currentProfiles.map(withDefaultAvatar);
        
        // Helper function to format the time difference
        const formatTimeLeft = (ms) => {
            if (ms <= 0) return "Ready now";
            const days = Math.floor(ms / (1000 * 60 * 60 * 24));
            if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
            const hours = Math.floor(ms / (1000 * 60 * 60));
            if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
            const minutes = Math.floor(ms / (1000 * 60));
            return `${minutes} minute${minutes > 1 ? 's' : ''}`;
        };

        // 3. NEW: Check if we should serve existing profiles
        if (lastRefresh && currentProfiles.length > 0) {
            const refreshIntervalDays = isPremium ? 1 : 7;
            const now = new Date();
            
            const nextRefreshDate = new Date(lastRefresh.getTime());
            nextRefreshDate.setDate(lastRefresh.getDate() + refreshIntervalDays);

            if (now < nextRefreshDate) {
                const timeLeftMs = nextRefreshDate - now;
                
                // Get fresh premium data for existing profiles
                const profileIds = currentProfiles.map(p => p.id);
                const placeholders = profileIds.map(() => '?').join(',');
                
                let profilesWithPremiumData = [];
                if (placeholders) {
                    const [premiumRows] = await pool.execute(
                        `SELECT id, premium, premiumType, premiumStartDate, premiumCancelled FROM users WHERE id IN (${placeholders})`,
                        profileIds
                    );
                    
                    // Merge premium data with existing profile data
                    profilesWithPremiumData = currentProfiles.map(profile => {
                        const premiumData = premiumRows.find(row => row.id === profile.id);
                        return {
                            ...profile,
                            isPremium: premiumData ? getActualPremiumStatus(premiumData) : false
                        };
                    });
                } else {
                    profilesWithPremiumData = currentProfiles.map(profile => ({
                        ...profile,
                        isPremium: false
                    }));
                }
                
                console.log('Existing profiles with premium data:', profilesWithPremiumData.map(p => ({ id: p.id, firstName: p.firstName, isPremium: p.isPremium })));
                
                return res.json({
                    profiles: profilesWithPremiumData,
                    timeLeft: formatTimeLeft(timeLeftMs)
                });
            }
        }

        // --- If we proceed, it means we need to generate a new batch ---
        const currentUserInterests = currentUser.interests || [];
        let existingPastProfiles = currentUser.pastProfiles || [];
        const currentUserInterestsSet = new Set(currentUserInterests);
        
        const excludedIds = new Set(existingPastProfiles);
        excludedIds.add(req.session.userId);

        const placeholders = Array.from(excludedIds).map(() => '?').join(',');
        let allPotentialUsers = [];

        if (placeholders) {
            const [rows] = await pool.execute(
                `SELECT id, firstName, bio, interests, avatar, premium, premiumType, premiumStartDate, premiumCancelled FROM users WHERE id NOT IN (${placeholders}) AND completedProfile = 1`, 
                [...excludedIds]
            );
            allPotentialUsers = rows.map(withDefaultAvatar);
        } else {
            const [rows] = await pool.execute(
                'SELECT id, firstName, bio, interests, avatar, premium, premiumType, premiumStartDate, premiumCancelled FROM users WHERE id != ? AND completedProfile = 1', 
                [req.session.userId]
            );
            allPotentialUsers = rows.map(withDefaultAvatar);
        }

        const matchedProfiles = allPotentialUsers
            .map(user => {
                const userInterests = user.interests || [];
                const commonInterestsCount = userInterests.filter(interest => currentUserInterestsSet.has(interest)).length;
                return { ...user, commonInterestsCount };
            })
            .filter(user => user.commonInterestsCount > 0);
        
        const matchedIds = new Set(matchedProfiles.map(p => p.id));
        const nonMatchedProfiles = allPotentialUsers.filter(user => !matchedIds.has(user.id));

        const limit = isPremium ? 15 : 5;
        let finalProfiles = [];

        const shuffledMatched = matchedProfiles.sort(() => 0.5 - Math.random());
        finalProfiles.push(...shuffledMatched);

        if (finalProfiles.length < limit) {
            const needed = limit - finalProfiles.length;
            const shuffledNonMatched = nonMatchedProfiles.sort(() => 0.5 - Math.random());
            finalProfiles.push(...shuffledNonMatched.slice(0, needed));
        }

        finalProfiles = finalProfiles.slice(0, limit);

        if (finalProfiles.length < limit) {            
            const [freshRandomUsers] = await pool.execute(
                `SELECT id, firstName, bio, interests, avatar FROM users WHERE id != ? AND completedProfile = 1 ORDER BY RAND() LIMIT ${limit}`,
                [req.session.userId]
            );
            
            finalProfiles = freshRandomUsers.map(withDefaultAvatar);
            const finalProfileIds = finalProfiles.map(p => p.id);
            
            // Update DB: Reset pastProfiles, set currentProfiles, and update timestamp
            await pool.execute(
                'UPDATE users SET pastProfiles = ?, currentProfiles = ?, lastTimeProfilesRefresh = NOW() WHERE id = ?',
                [JSON.stringify(finalProfileIds), JSON.stringify(finalProfiles), req.session.userId]
            );

        } else if (finalProfiles.length > 0) {
            finalProfiles = finalProfiles.map(withDefaultAvatar);
            const finalProfileIds = finalProfiles.map(p => p.id);
            const combinedProfileIds = [...new Set([...existingPastProfiles, ...finalProfileIds])];
            
            // Update DB: Add to pastProfiles, set currentProfiles, and update timestamp
            await pool.execute(
                'UPDATE users SET pastProfiles = ?, currentProfiles = ?, lastTimeProfilesRefresh = NOW() WHERE id = ?',
                [JSON.stringify(combinedProfileIds), JSON.stringify(finalProfiles), req.session.userId]
            );
        }
        
        // When a new batch is generated, calculate the time left from the full interval
        const refreshIntervalDays = isPremium ? 1 : 7;
        const timeLeftMs = refreshIntervalDays * 24 * 60 * 60 * 1000;
        const newTimeLeft = formatTimeLeft(timeLeftMs);
        
                        // Add premium status to each profile
                const profilesWithPremiumStatus = finalProfiles.map(profile => ({
                    ...profile,
                    isPremium: getActualPremiumStatus(profile)
                }));
                
                console.log('Profiles with premium status:', profilesWithPremiumStatus.map(p => ({ id: p.id, firstName: p.firstName, isPremium: p.isPremium })));
                
                res.json({
                    profiles: profilesWithPremiumStatus,
                    timeLeft: newTimeLeft
                });

    } catch (error) {
        console.error("Error fetching profiles:", error);
        res.status(500).json({ error: "Failed to load profiles." });
    }
});


app.get('/api/getUserProfile', async (req, res) => {
    console.log('getUserProfile called, session:', req.session);
    console.log('session.userId:', req.session.userId);
    
    // Simulate fetching user profile from database
    if (!req.session.userId) {
        console.log('No userId in session, returning 401');
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    try {
    // Get user from db
    const [rows] = await pool.execute("SELECT * FROM users WHERE id = ?", [req.session.userId]);
    if (rows.length === 0) {
            console.log('User not found in database for id:', req.session.userId);
            return res.status(404).json({ error: "User not found" });
    }

    const userProfile = {
        "name": rows[0].firstName || "",
        "dob": rows[0].dob ? new Date(rows[0].dob).toISOString().split('T')[0] : null,
        "email": rows[0].email,
        "bio": rows[0].bio || null,
        "interests": rows[0].interests || [],
        "address": rows[0].address || null,
        "wantsPhysicalMail": rows[0].wantsPhysicalMail ? 1 : 0,
        "email_verified": rows[0].email_verified || false,
        "gender": rows[0].gender || null,
        "avatar": rows[0].avatar || DEFAULT_AVATAR,
        "premium": getActualPremiumStatus(rows[0])
      };
    res.json(userProfile);
    } catch (error) {
        console.error('Database error in getUserProfile:', error);
        return res.status(500).json({ error: "Database error" });
    }
});

app.get('/profile-settings', async (req, res) => {
    console.log('profile-settings route called, session:', req.session);
    console.log('session.userId:', req.session.userId);
    
    if (!req.session.userId) {
        console.log('No userId in session, redirecting to login');
        return res.redirect("/login");
    }
    console.log('Rendering profile-settings page');
    res.render("profile-settings");
}); 
  
app.post('/saveProfile', async (req, res) => {
    // 1. Authorization Check: Ensure the user is logged in.
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized. Please log in." });
    }

    const { name, dob, bio, interests, address, wantsPhysicalMail, gender, avatar } = req.body;
    // 2. Improved Validation: Matches the frontend logic.
    if (!name || !dob || !bio || !Array.isArray(interests) || interests.length < 3 || !gender || !avatar) {
        return res.status(400).json({ error: "Name, date of birth, bio, gender, avatar and at least 3 interests are required." });
    }

    // Only require an address if the user wants to receive mail.
    if (wantsPhysicalMail && !address) {
        return res.status(400).json({ error: "Mailing address is required if you want to receive physical letters." });
    }
    // 2a. Content Moderation: Check bio for inappropriate content using Perspective API.
    const isBioClean = await isContentAppropriate(bio + " " + name + " " + address);
    if (!isBioClean) {
        return res.status(400).json({ error: "Your profile contains inappropriate content. Please revise it." });
    }
    const [[{ email_verified }]] = await pool.execute(
        "SELECT email_verified FROM users WHERE id = ?", 
        [req.session.userId]
      );
      
      const verified = +email_verified;
          // 3. Database Interaction with Error Handling
    try {
        const sql = `
            UPDATE users 
            SET 
                firstName = ?, 
                dob = ?, 
                bio = ?, 
                interests = ?, 
                address = ?, 
                wantsPhysicalMail = ? ,
                gender = ?,
                avatar = ?,
                completedProfile = ?
            WHERE 
                id = ?
        `;
        const completedProfile = verified ? 1 : 0;
        // The interests array is converted to a JSON string for storage.
        await pool.execute(sql, [
            name, 
            dob, 
            bio, 
            JSON.stringify(interests), 
            address, 
            wantsPhysicalMail ? 1 : 0,
            gender,
            avatar,
            completedProfile,
            req.session.userId
        ]);

        // This ensures the rest of the app sees the updated profile immediately.
        req.session.firstName = name;


        // Send a success response.
        res.status(200).json({ message: "Profile saved successfully" });

    } catch (error) {
        // If the database query fails, log the error and send a generic server error message.
        console.error("Database error on /saveProfile:", error);
        return res.status(500).json({ error: "An error occurred while saving your profile. Please try again later." });
    }
});



app.post('/api/address-autocomplete', async (req, res) => {
    const { input } = req.body;

    if (!input) {
        return res.status(400).json({ error: 'Input is required' });
    }

    // It's crucial to store your API key in an environment variable (.env file)
    const apiKey = GOOGLE_MAPS_API_KEY;
    
    // The new URL for the Places API (New)
    const url = 'https://places.googleapis.com/v1/places:autocomplete';

    // The new request body format
    const requestBody = {
        input: input,
        includedRegionCodes: ["us"] // Optional: Restrict to the United States
    };

    try {
        // The new API uses a POST request with the key in the header
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        if (data.suggestions) {
            // The new API returns suggestions differently. We need to format them.
            const suggestions = data.suggestions.map(s => ({
                description: s.placePrediction.text.text,
                place_id: s.placePrediction.placeId
            }));
            res.json(suggestions);
        } else {
            // If there are no suggestions, return an empty array
            res.json([]);
        }
    } catch (error) {
        console.error('Error calling Google Maps API:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add these two new routes to your server.js file

// Route to INITIATE email verification
app.get('/verify-email', async (req, res) => {
    // Ensure user is logged in and we have their email in the session
    if (!req.session.userId || !req.session.email) {
        return res.status(401).json({ error: "Unauthorized. Please log in." });
    }
    const { email } = req.session;

    try {
        // You can reuse the "codes" table from your password reset system
        const [codes] = await pool.execute("SELECT wait_until FROM codes WHERE email = ?", [email]);
        
        if (codes.length > 0) {
            const waitUntil = codes[0].wait_until;
            if (new Date() < waitUntil) {
                // Still render the page, but pass an error message to it.
                const errorMessage = "Too many attempts. Please try again later.";
                return res.status(429).render("email-verify", { email, error: errorMessage });
            }
        }
        
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        const upsertSql = `
        INSERT INTO codes (email, code, expires_at, wait_until, number_of_tries, first_sent_at)
        VALUES (?, ?, NOW() + INTERVAL 15 MINUTE, NOW() - INTERVAL 1 MINUTE, 1, NOW())
        ON DUPLICATE KEY UPDATE
            code = VALUES(code),
            expires_at = VALUES(expires_at),
            wait_until = NOW() - INTERVAL 1 MINUTE,
            -- Conditional logic to reset after 24 hours
            number_of_tries = CASE
                WHEN first_sent_at < NOW() - INTERVAL 1 DAY THEN 1 -- If older than a day, reset tries to 1
                ELSE number_of_tries + 1 -- Otherwise, just increment
            END,
            first_sent_at = CASE
                WHEN first_sent_at < NOW() - INTERVAL 1 DAY THEN NOW() -- If older than a day, reset the timestamp
                ELSE first_sent_at -- Otherwise, keep the original timestamp
            END;
        `;
        await pool.execute(upsertSql, [email, code]);
        
        await transporter.sendMail({
            from: `"My App" <${process.env.SMTP_USER}>`,
            to: email,
            subject: "Verify Your Email Address",
            text: `Your verification code is ${code}`,
            html: `<p>Your verification code is <strong>${code}</strong>. It will expire in 15 minutes.</p>`
        });

        return res.render("email-verify", { email });

    } catch (err) {
        console.error("Email verification error:", err);
        return res.status(500).json({ error: "An error occurred while sending the verification code." });
    }
});


app.post('/verify-email/check', async (req, res) => {
    if (!req.session.userId || !req.session.email) {
        return res.status(401).json({ error: "Unauthorized. Please log in." });
    }
    const { code } = req.body;
    const { email, userId } = req.session;
    
    if (!code) {
        return res.status(400).json({ error: "Verification code is required." });
    }

    try {
        const [rows] = await pool.execute(
            "SELECT code, expires_at, number_of_tries, wait_until FROM codes WHERE email = ?", 
            [email]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "No verification code found. Please request another." });
        }

        const row = rows[0];
        if (new Date() < row.wait_until) {
            // CHANGED: Send JSON instead of rendering a page
            return res.status(429).json({ error: "Too many attempts. Please try again later." });
        }
        
        if (new Date() > row.expires_at) {
            return res.status(400).json({ error: "Verification code has expired." });
        }

        if (row.code === code) {
            // Success!
            await pool.execute("UPDATE users SET email_verified = 1 WHERE id = ?", [userId]);
            await pool.execute("DELETE FROM codes WHERE email = ?", [email]);
            return res.status(200).json({ message: "Email verified successfully!" });
        } else {
            // Logic for an invalid code
            if (row.number_of_tries + 1 >= 10) {
                await pool.execute(
                    "UPDATE codes SET number_of_tries = 0, wait_until = NOW() + INTERVAL 1 HOUR WHERE email = ?",
                    [email]
                );
                // CHANGED: Send JSON instead of rendering a page
                return res.status(429).json({ error: "Too many attempts. Please try again in one hour." });
            } else {
                await pool.execute(
                    "UPDATE codes SET number_of_tries = number_of_tries + 1 WHERE email = ?", 
                    [email]
                );
                return res.status(400).json({ error: "Invalid verification code." });
            }
        }
    } catch(err) {
        console.error("DB error during email verification check:", err);
        return res.status(500).json({ error: "Database error." });
    }
});

app.post('/api/purchase-matches', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = req.session.userId;
    const cost = 50;

    try {
        // Get user's coins, past profiles, current profiles, and interests in one query
        const [userRows] = await pool.execute(
            'SELECT coins, pastProfiles, currentProfiles, interests FROM users WHERE id = ?', 
            [userId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: "User not found." });
        }

        const user = userRows[0];

        // Check if the user has enough coins
        if (user.coins < cost) {
            return res.status(402).json({ error: "Not enough coins." });
        }

        let newMatch = null;
        let pastProfiles = user.pastProfiles || [];
        let currentProfiles = user.currentProfiles || [];
        const currentUserInterests = user.interests || [];
        const currentUserInterestsSet = new Set(currentUserInterests);

        // --- Find a new match that isn't in pastProfiles ---
        const excludedIds = [...pastProfiles, userId];
        const placeholders = excludedIds.map(() => '?').join(',');
        
        const [potentialUsersRows] = await pool.execute(
            `SELECT id, firstName, bio, interests, avatar FROM users WHERE id NOT IN (${placeholders}) AND completedProfile = 1`,
            excludedIds
        );
        const potentialUsers = potentialUsersRows.map(withDefaultAvatar);

        if (potentialUsers.length > 0) {
            // First, try to find a match with common interests
            const matchesWithInterest = potentialUsers.filter(p => {
                const pInterests = p.interests || [];
                return pInterests.some(interest => currentUserInterestsSet.has(interest));
            });

            if (matchesWithInterest.length > 0) {
                // If we found matches with interests, pick one randomly from that list
                newMatch = matchesWithInterest[Math.floor(Math.random() * matchesWithInterest.length)];
            } else {
                // If no matches with interests, pick a random user from the potential pool
                newMatch = potentialUsers[Math.floor(Math.random() * potentialUsers.length)];
            }

            newMatch = withDefaultAvatar(newMatch);
            
            // Add the new match to the beginning of the user's current profiles
            currentProfiles.unshift(newMatch); 
            // Add the new match's ID to the list of profiles they've seen
            pastProfiles.push(newMatch.id);

            // Update the database: deduct coins and update profile lists
            await pool.execute(
                'UPDATE users SET coins = coins - ?, pastProfiles = ?, currentProfiles = ? WHERE id = ?',
                [cost, JSON.stringify(pastProfiles), JSON.stringify(currentProfiles), userId]
            );

            res.status(200).json({ message: "Purchase successful! A new match has been added." });

        } else {
            // No new matches were found at all. Return an error and DO NOT charge coins.
            console.log(`No new profiles available for user ${userId}.`);
            return res.status(404).json({ error: "No new profiles available at this time." });
        }

    } catch (error) {
        console.error("Error purchasing matches:", error);
        res.status(500).json({ error: "Failed to purchase new matches." });
    }
});

app.post('/api/save-draft', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { content, recipientId, recipientName, action } = req.body;
    
    if (!content || !recipientId || !recipientName || !action) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        // Check if a draft already exists for this user and recipient
        const [existingDrafts] = await pool.execute(
            'SELECT id FROM drafts WHERE sender_id = ? AND recipient_id = ? AND action = ?',
            [req.session.userId, recipientId, action]
        );

        if (existingDrafts.length > 0) {
            // Update existing draft
            await pool.execute(
                'UPDATE drafts SET content = ?, recipient_name = ?, updated_at = NOW() WHERE sender_id = ? AND recipient_id = ? AND action = ?',
                [content, recipientName, req.session.userId, recipientId, action]
            );
        } else {
            // Create new draft
            await pool.execute(
                'INSERT INTO drafts (sender_id, recipient_id, recipient_name, content, action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
                [req.session.userId, recipientId, recipientName, content, action]
            );
        }

        res.status(200).json({ message: "Draft saved successfully" });
    } catch (error) {
        console.error("Error saving draft:", error);
        res.status(500).json({ error: "Failed to save draft" });
    }
});

app.get('/api/load-draft', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { recipientId, action } = req.query;
    
    if (!recipientId || !action) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const [drafts] = await pool.execute(
            'SELECT content, recipient_name, updated_at FROM drafts WHERE sender_id = ? AND recipient_id = ? AND action = ?',
            [req.session.userId, recipientId, action]
        );

        if (drafts.length > 0) {
            res.status(200).json({
                content: drafts[0].content,
                recipientName: drafts[0].recipient_name,
                updatedAt: drafts[0].updated_at
            });
        } else {
            res.status(404).json({ message: "No draft found" });
        }
    } catch (error) {
        console.error("Error loading draft:", error);
        res.status(500).json({ error: "Failed to load draft" });
    }
});

app.post('/api/send-message', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { content, recipientId, messageType, giftAmount, useBoost } = req.body;
    
    if (!content || !recipientId || !messageType) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    if (!['email', 'letter'].includes(messageType)) {
        return res.status(400).json({ error: "Invalid message type" });
    }

    try {
        // Check if user has enough credits (only for letters)
        if (messageType === 'letter') {
            const [userRows] = await pool.execute(
                'SELECT letterCredits FROM users WHERE id = ?',
                [req.session.userId]
            );

            if (userRows.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }

            if (userRows[0].letterCredits <= 0) {
                return res.status(402).json({ error: "Insufficient letter credits" });
            }
        }

        // Check if user has boosts for boost delivery (only for emails)
        if (useBoost && messageType === 'email') {
            const [boostRows] = await pool.execute(
                'SELECT boosts FROM users WHERE id = ?',
                [req.session.userId]
            );

            if (boostRows.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }

            if (boostRows[0].boosts <= 0) {
                return res.status(400).json({ error: "No boosts available" });
            }
        }

        // Handle gift if included
        if (giftAmount && giftAmount > 0) {

            // Check if sender has enough coins
            const [senderRows] = await pool.execute(
                'SELECT coins FROM users WHERE id = ?',
                [req.session.userId]
            );
            
            if (senderRows.length === 0) {
                return res.status(404).json({ error: 'Sender not found' });
            }
            
            if (senderRows[0].coins < giftAmount) {
                return res.status(400).json({ error: 'Insufficient coins for gift' });
            }
        }

        // Get sender's name for the message
        const [senderNameRows] = await pool.execute(
            'SELECT firstName FROM users WHERE id = ?',
            [req.session.userId]
        );
        const senderName = senderNameRows[0]?.firstName || 'Someone';

        // Check SafeSend preferences for both sender and recipient
        const [senderSafeSendRows] = await pool.execute(
            'SELECT safesendEnabled FROM users WHERE id = ?',
            [req.session.userId]
        );
        const [recipientSafeSendRows] = await pool.execute(
            'SELECT safesendEnabled FROM users WHERE id = ?',
            [recipientId]
        );

        const senderSafeSendEnabled = senderSafeSendRows[0]?.safesendEnabled ?? true;
        const recipientSafeSendEnabled = recipientSafeSendRows[0]?.safesendEnabled ?? true;

        // Apply content filtering if either sender or recipient has SafeSend enabled
        if (senderSafeSendEnabled || recipientSafeSendEnabled) {
            try {
                const isContentClean = await isContentAppropriate(content);
                if (!isContentClean) {
                    return res.status(400).json({ 
                        error: "Your message contains inappropriate content. Please revise it before sending.",
                        safesendBlocked: true
                    });
                }
                console.log(`SafeSend content check passed for message from user ${req.session.userId} to user ${recipientId}`);
            } catch (contentError) {
                console.error("SafeSend content check failed:", contentError);
                // If content check fails, still allow the message to be sent
                // This prevents SafeSend from blocking legitimate messages due to API issues
            }
        }

        // For letters, replace content with shipping message
        let displayContent = content;
        if (messageType === 'letter') {
            displayContent = `📬 **Letter from ${senderName}**\n\nYour letter has been sent and will be shipped within 24 hours! 🚚\n\n💌 *This is a physical letter that will be delivered to your address.*`;
        }

        // Add gift information to message if included
        if (giftAmount && giftAmount > 0) {
            displayContent += `\n\n🎁 **Gift included: ${giftAmount} coins!**`;
        }

        // Calculate delivery time for e-letters only (not regular letters)
        let deliveryTime = null;
        if (messageType === 'email') {
            if (useBoost) {
                deliveryTime = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now for boost delivery
            } else {
                deliveryTime = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now for normal delivery
            }
        }

        // Insert the message
        const [result] = await pool.execute(
            'INSERT INTO messages (sender_id, recipient_id, content, message_type, delivery_time) VALUES (?, ?, ?, ?, ?)',
            [req.session.userId, recipientId, content, messageType, deliveryTime]
        );

        // Deduct boost if used (only for e-letters)
        if (useBoost && messageType === 'email') {
            await pool.execute(
                'UPDATE users SET boosts = boosts - 1 WHERE id = ?',
                [req.session.userId]
            );
            console.log(`⚡ Boost used by user ${req.session.userId} for E-Letter delivery`);
        }

        // Process gift if included
        if (giftAmount && giftAmount > 0) {
            // Get a connection for transaction
            const connection = await pool.getConnection();
            
            try {
                // Start transaction
                await connection.query('START TRANSACTION');
                
                // Deduct coins from sender
                await connection.execute(
                    'UPDATE users SET coins = coins - ? WHERE id = ?',
                    [giftAmount, req.session.userId]
                );
                
                // Add coins to recipient
                await connection.execute(
                    'UPDATE users SET coins = coins + ? WHERE id = ?',
                    [giftAmount, recipientId]
                );
                
                // Log transaction
                await connection.execute(
                    'INSERT INTO transaction_logs (user_id, transaction_type, amount, status, created_at) VALUES (?, ?, ?, ?, NOW())',
                    [req.session.userId, 'purchase', -giftAmount, 'completed']
                );
                
                await connection.execute(
                    'INSERT INTO transaction_logs (user_id, transaction_type, amount, status, created_at) VALUES (?, ?, ?, ?, NOW())',
                    [recipientId, 'purchase', giftAmount, 'completed']
                );
                
                await connection.query('COMMIT');
                
            } catch (error) {
                await connection.query('ROLLBACK');
                throw error;
            } finally {
                connection.release();
            }
        }

        // Create message object for chat history (use display content for recipient)
        const messageObj = {
            id: result.insertId,
            senderId: req.session.userId,
            recipientId: recipientId,
            content: displayContent,
            messageType: messageType,
            timestamp: new Date().toISOString()
        };

        // Update sender's chat history
        const [senderRows] = await pool.execute(
            'SELECT chatHistory FROM users WHERE id = ?',
            [req.session.userId]
        );
        
        let senderChatHistory = {};
        if (senderRows[0].chatHistory) {
            // Check if it's already an object or needs parsing
            if (typeof senderRows[0].chatHistory === 'string') {
                try {
                    senderChatHistory = JSON.parse(senderRows[0].chatHistory);
                } catch (e) {
                    console.log('JSON parse error:', e);
                    senderChatHistory = {};
                }
            } else {
                // It's already an object
                senderChatHistory = senderRows[0].chatHistory;
            }
        }
        
        if (!senderChatHistory[recipientId]) {
            senderChatHistory[recipientId] = [];
        }
        senderChatHistory[recipientId].push(messageObj);
        
        await pool.execute(
            'UPDATE users SET chatHistory = ? WHERE id = ?',
            [JSON.stringify(senderChatHistory), req.session.userId]
        );

        // Update recipient's chat history
        const [recipientRows] = await pool.execute(
            'SELECT chatHistory FROM users WHERE id = ?',
            [recipientId]
        );
        
        let recipientChatHistory = {};
        if (recipientRows[0].chatHistory) {
            // Check if it's already an object or needs parsing
            if (typeof recipientRows[0].chatHistory === 'string') {
                try {
                    recipientChatHistory = JSON.parse(recipientRows[0].chatHistory);
                } catch (e) {
                    console.log('JSON parse error:', e);
                    recipientChatHistory = {};
                }
            } else {
                // It's already an object
                recipientChatHistory = recipientRows[0].chatHistory;
            }
        }
        
        if (!recipientChatHistory[req.session.userId]) {
            recipientChatHistory[req.session.userId] = [];
        }
        recipientChatHistory[req.session.userId].push(messageObj);
        
        await pool.execute(
            'UPDATE users SET chatHistory = ? WHERE id = ?',
            [JSON.stringify(recipientChatHistory), recipientId]
        );

        // Deduct credit if it's a letter
        if (messageType === 'letter') {
            await pool.execute(
                'UPDATE users SET letterCredits = letterCredits - 1 WHERE id = ?',
                [req.session.userId]
            );
        }

        // Delete the draft after successful send
        await pool.execute(
            'DELETE FROM drafts WHERE sender_id = ? AND recipient_id = ? AND action = ?',
            [req.session.userId, recipientId, messageType]
        );

        let successMessage = `${messageType === 'email' ? 'E-Letter' : 'Letter'} sent successfully`;
        if (giftAmount && giftAmount > 0) {
            successMessage += ` with ${giftAmount} coins gift!`;
        }

        res.status(200).json({ 
            message: successMessage,
            messageId: result.insertId
        });
    } catch (error) {
        console.error("Error sending message:", error);
        res.status(500).json({ error: "Failed to send message" });
    }
});

// API endpoint to edit a message
app.post('/api/edit-message', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { messageId, content } = req.body;

    if (!messageId || !content) {
        return res.status(400).json({ error: "Message ID and content are required" });
    }

    try {
        // Check if the message exists and belongs to the user
        const [messageRows] = await pool.execute(
            'SELECT id, sender_id, message_type, delivery_time FROM messages WHERE id = ? AND sender_id = ?',
            [messageId, req.session.userId]
        );

        if (messageRows.length === 0) {
            return res.status(404).json({ error: "Message not found or you don't have permission to edit it" });
        }

        const message = messageRows[0];

        // Only allow editing e-letters that haven't been delivered yet
        if (message.message_type !== 'email') {
            return res.status(400).json({ error: "Only e-letters can be edited" });
        }

        if (message.delivery_time) {
            const now = new Date();
            const deliveryTime = new Date(message.delivery_time);
            if (now >= deliveryTime) {
                return res.status(400).json({ error: "Cannot edit delivered messages" });
            }
        }

        // Check if user has premium for editing delivered messages
        const [userRows] = await pool.execute(
            'SELECT premium, safesendEnabled FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (!userRows[0].premium) {
            return res.status(403).json({ 
                error: "Premium subscription required to edit messages after they've been sent",
                requiresPremium: true
            });
        }

        if (userRows[0].safesendEnabled) {
            const isAppropriate = await isContentAppropriate(content);
            if (!isAppropriate) {
                return res.status(400).json({ 
                    safesendBlocked: true,
                    error: "Message blocked by SafeSend due to inappropriate content" 
                });
            }
        }

        // Update the message content
        await pool.execute(
            'UPDATE messages SET content = ? WHERE id = ?',
            [content, messageId]
        );

        res.json({ success: true, message: "Message updated successfully" });

    } catch (error) {
        console.error("Error editing message:", error);
        res.status(500).json({ error: "Failed to edit message" });
    }
});

app.get('/api/chat-history/:userId', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId } = req.params;
    
    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    try {
        // Query messages directly from the messages table with delivery time filtering
        let messages;
        try {
            [messages] = await pool.execute(`
                SELECT 
                    id, sender_id, recipient_id, content, message_type, status, created_at, delivery_time
                FROM messages 
                WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
                ORDER BY created_at ASC
            `, [req.session.userId, userId, userId, req.session.userId]);
        } catch (error) {
            // Fallback to query without delivery_time if column doesn't exist
            if (error.code === 'ER_BAD_FIELD_ERROR') {
                [messages] = await pool.execute(`
                    SELECT 
                        id, sender_id, recipient_id, content, message_type, status, created_at
                    FROM messages 
                    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
                    ORDER BY created_at ASC
                `, [req.session.userId, userId, userId, req.session.userId]);
            } else {
                throw error;
            }
        }

        // Filter messages based on delivery time
        const now = new Date();
        const filteredMessages = [];
        
        for (const msg of messages) {
            const message = {
                id: msg.id,
                senderId: msg.sender_id,
                recipientId: msg.recipient_id,
                content: msg.content,
                messageType: msg.message_type,
                timestamp: msg.created_at.toISOString(),
                status: msg.status,
                deliveryTime: msg.delivery_time ? msg.delivery_time.toISOString() : null
            };

            // For regular letters, show shipping notification to recipients instead of actual content
            if (msg.message_type === 'letter' && msg.recipient_id === req.session.userId) {
                // Get sender's name
                const [senderNameRows] = await pool.execute(
                    'SELECT firstName FROM users WHERE id = ?',
                    [msg.sender_id]
                );
                const senderName = senderNameRows[0]?.firstName || 'Someone';
                message.content = `📬 **Letter from ${senderName}**\n\nA letter will be shipped to you today! 🚚\n\n💌 *This letter will be prepared and shipped within the day.*`;
            }

            // For e-letters only, check if delivery time has passed
            if (msg.message_type === 'email' && msg.delivery_time) {
                const deliveryTime = new Date(msg.delivery_time);
                if (now < deliveryTime) {
                    // Message not yet delivered, show pending message to recipient only
                    if (msg.recipient_id === req.session.userId) {
                        const hoursLeft = Math.ceil((deliveryTime - now) / (1000 * 60 * 60));
                        // Get sender's name
                        const [senderNameRows] = await pool.execute(
                            'SELECT firstName FROM users WHERE id = ?',
                            [msg.sender_id]
                        );
                        const senderName = senderNameRows[0]?.firstName || 'Someone';
                        
                        message.content = `📧 **Email from ${senderName}**\n\nYour email will be delivered in ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}! ⏰\n\n💌 *This email is being processed and will arrive soon.*`;
                    }
                }
            } else if (msg.message_type === 'email' && !msg.delivery_time) {
                // Fallback for emails without delivery_time (old messages)
                if (msg.recipient_id === req.session.userId) {
                    // Get sender's name
                    const [senderNameRows] = await pool.execute(
                        'SELECT firstName FROM users WHERE id = ?',
                        [msg.sender_id]
                    );
                    const senderName = senderNameRows[0]?.firstName || 'Someone';
                    message.content = `📧 **Email from ${senderName}**\n\nYour email will be delivered soon! ⏰\n\n💌 *This email is being processed and will arrive shortly.*`;
                }
            }

            filteredMessages.push(message);
        }

        // Get the other user's name for display
        const [otherUserRows] = await pool.execute(
            'SELECT firstName FROM users WHERE id = ?',
            [userId]
        );

        const otherUserName = otherUserRows.length > 0 ? otherUserRows[0].firstName : 'Unknown User';
        res.status(200).json({
            conversation: filteredMessages,
            otherUserName: otherUserName,
            otherUserId: userId
        });
    } catch (error) {
        console.error("Error loading chat history:", error);
        res.status(500).json({ error: "Failed to load chat history" });
    }
});

// API endpoint to get unread message counts
app.get('/api/unread-counts', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const now = new Date();
        
        // Get unread messages (delivered but not read)
        let unreadMessages;
        try {
            [unreadMessages] = await pool.execute(`
                SELECT 
                    id, sender_id, message_type, delivery_time, created_at
                FROM messages 
                WHERE recipient_id = ? 
                AND status IN ('sent', 'delivered')
                ORDER BY created_at DESC
            `, [req.session.userId]);
        } catch (error) {
            // Fallback if delivery_time column doesn't exist
            if (error.code === 'ER_BAD_FIELD_ERROR') {
                [unreadMessages] = await pool.execute(`
                    SELECT 
                        id, sender_id, message_type, created_at
                    FROM messages 
                    WHERE recipient_id = ? 
                    AND status IN ('sent', 'delivered')
                    ORDER BY created_at DESC
                `, [req.session.userId]);
            } else {
                throw error;
            }
        }

        // All unread messages are considered delivered for unread count purposes
        // (delivery time is used for other features like showing pending status)
        const deliveredUnreadMessages = unreadMessages;

        // Count unread messages by type and by sender
        const unreadByType = {
            email: 0,
            letter: 0,
            gift: 0,
            total: deliveredUnreadMessages.length
        };

        const unreadBySender = {};

        for (const msg of deliveredUnreadMessages) {
            unreadByType[msg.message_type]++;
            
            if (!unreadBySender[msg.sender_id]) {
                unreadBySender[msg.sender_id] = {
                    email: 0,
                    letter: 0,
                    gift: 0,
                    total: 0
                };
            }
            unreadBySender[msg.sender_id][msg.message_type]++;
            unreadBySender[msg.sender_id].total++;
        }

        res.json({
            unreadByType,
            unreadBySender,
            hasUnread: deliveredUnreadMessages.length > 0
        });

    } catch (error) {
        console.error("Error getting unread counts:", error);
        res.status(500).json({ error: "Failed to get unread counts" });
    }
});

// API endpoint to mark messages as read
app.post('/api/mark-as-read/:userId', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId } = req.params;
    
    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    try {
        // Mark all messages from the specified user to the current user as read
        const [result] = await pool.execute(`
            UPDATE messages 
            SET status = 'read' 
            WHERE sender_id = ? 
            AND recipient_id = ? 
            AND status IN ('sent', 'delivered')
        `, [userId, req.session.userId]);

        res.json({ 
            success: true, 
            markedAsRead: result.affectedRows 
        });

    } catch (error) {
        console.error("Error marking messages as read:", error);
        res.status(500).json({ error: "Failed to mark messages as read" });
    }
});

// API endpoint to get referral information
app.get('/api/referral-info', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // Get user's referral information including program type
        const [userRows] = await pool.execute(
            'SELECT referralCode, referralCount, referredBy, referralProgramType FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userRows[0];
        let referrerInfo = null;

        // Get referrer information if user was referred
        if (user.referredBy) {
            const [referrerRows] = await pool.execute(
                'SELECT firstName, referralCode FROM users WHERE id = ?',
                [user.referredBy]
            );
            if (referrerRows.length > 0) {
                referrerInfo = {
                    name: referrerRows[0].firstName,
                    referralCode: referrerRows[0].referralCode
                };
            }
        }

        // Get list of users referred by current user (limited to recent 10 for performance)
        // Show newest referrals first (most recent at top)
        const [referredUsers] = await pool.execute(
            'SELECT firstName, email, created_at FROM users WHERE referredBy = ? ORDER BY created_at DESC LIMIT 10',
            [req.session.userId]
        );

        // Get earnings for this user
        const [earningsRows] = await pool.execute(
            'SELECT SUM(amount) as totalEarnings, SUM(CASE WHEN status = "pending" THEN amount ELSE 0 END) as pendingEarnings FROM referral_earnings WHERE referrer_id = ?',
            [req.session.userId]
        );
        
        const earnings = earningsRows[0] || { totalEarnings: 0, pendingEarnings: 0 };
        
        // Get program details
        const getProgramDetails = (programType) => {
            switch(programType) {
                case 'standard':
                    return {
                        name: 'Standard Program',
                        description: '5% commission on all purchases',
                        type: 'percentage',
                        value: 5
                    };
                case 'offer_5':
                    return {
                        name: '$5 Offer Program',
                        description: '$5 per new subscriber (first subscription only) + 15% for 6 months',
                        type: 'mixed',
                        signupBonus: 5,
                        percentage: 15,
                        duration: '6 months'
                    };
                case 'offer_10':
                    return {
                        name: '$10 Signup Program',
                        description: '$10 when referred user subscribes (first subscription only)',
                        type: 'signup',
                        value: 10
                    };
                default:
                    return {
                        name: 'Standard Program',
                        description: '5% commission on all purchases',
                        type: 'percentage',
                        value: 5
                    };
            }
        };

        res.json({
            referralCode: user.referralCode,
            referralCount: user.referralCount,
            referredBy: referrerInfo,
            referredUsers: referredUsers.map(u => ({
                name: u.firstName,
                email: maskEmail(u.email),
                joinedAt: u.created_at
            })),
            programType: user.referralProgramType || 'standard',
            programDetails: getProgramDetails(user.referralProgramType || 'standard'),
            earnings: {
                total: parseFloat(earnings.totalEarnings || 0),
                pending: parseFloat(earnings.pendingEarnings || 0),
                paid: parseFloat(earnings.totalEarnings || 0) - parseFloat(earnings.pendingEarnings || 0)
            }
        });

    } catch (error) {
        console.error("Error getting referral info:", error);
        res.status(500).json({ error: "Failed to get referral information" });
    }
});

app.get('/api/chat-history', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // Query all messages for the current user with delivery time filtering
        let messages;
        try {
            [messages] = await pool.execute(`
                SELECT 
                    id, sender_id, recipient_id, content, message_type, status, created_at, delivery_time
                FROM messages 
                WHERE sender_id = ? OR recipient_id = ?
                ORDER BY created_at DESC
            `, [req.session.userId, req.session.userId]);
        } catch (error) {
            // Fallback to query without delivery_time if column doesn't exist
            if (error.code === 'ER_BAD_FIELD_ERROR') {
                [messages] = await pool.execute(`
                    SELECT 
                        id, sender_id, recipient_id, content, message_type, status, created_at
                    FROM messages 
                    WHERE sender_id = ? OR recipient_id = ?
                    ORDER BY created_at DESC
                `, [req.session.userId, req.session.userId]);
            } else {
                throw error;
            }
        }

        // Group messages by conversation and filter by delivery time
        const now = new Date();
        const chatHistory = {};
        
        for (const msg of messages) {
            const otherUserId = msg.sender_id === req.session.userId ? msg.recipient_id : msg.sender_id;
            
            // Only keep the latest message for each conversation (since messages are ordered by created_at DESC)
            if (!chatHistory[otherUserId]) {
                const message = {
                    id: msg.id,
                    senderId: msg.sender_id,
                    recipientId: msg.recipient_id,
                    content: msg.content,
                    messageType: msg.message_type,
                    timestamp: msg.created_at.toISOString(),
                    status: msg.status
                };

                // For regular letters, show shipping notification to recipients instead of actual content
                if (msg.message_type === 'letter' && msg.recipient_id === req.session.userId) {
                    // Get sender's name
                    const [senderNameRows] = await pool.execute(
                        'SELECT firstName FROM users WHERE id = ?',
                        [msg.sender_id]
                    );
                    const senderName = senderNameRows[0]?.firstName || 'Someone';
                    message.content = `📬 **Letter from ${senderName}**\n\nA letter will be shipped to you today! 🚚\n\n💌 *This letter will be prepared and shipped within the day.*`;
                }

                // For e-letters only, check if delivery time has passed
                if (msg.message_type === 'email' && msg.delivery_time) {
                    const deliveryTime = new Date(msg.delivery_time);
                    if (now < deliveryTime) {
                        // Message not yet delivered, show pending message to recipient only
                        if (msg.recipient_id === req.session.userId) {
                            const hoursLeft = Math.ceil((deliveryTime - now) / (1000 * 60 * 60));
                            // Get sender's name
                            const [senderNameRows] = await pool.execute(
                                'SELECT firstName FROM users WHERE id = ?',
                                [msg.sender_id]
                            );
                            const senderName = senderNameRows[0]?.firstName || 'Someone';
                            
                            message.content = `📧 **Email from ${senderName}**\n\nYour email will be delivered in ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}! ⏰\n\n💌 *This email is being processed and will arrive soon.*`;
                        }
                    }
                } else if (msg.message_type === 'email' && !msg.delivery_time) {
                    // Fallback for emails without delivery_time (old messages)
                    if (msg.recipient_id === req.session.userId) {
                        // Get sender's name
                        const [senderNameRows] = await pool.execute(
                            'SELECT firstName FROM users WHERE id = ?',
                            [msg.sender_id]
                        );
                        const senderName = senderNameRows[0]?.firstName || 'Someone';
                        message.content = `📧 **Email from ${senderName}**\n\nYour email will be delivered soon! ⏰\n\n💌 *This email is being processed and will arrive shortly.*`;
                    }
                }

                chatHistory[otherUserId] = [message]; // Only store the latest message
            }
        }

        res.status(200).json({
            chatHistory: chatHistory
        });
    } catch (error) {
        console.error("Error loading chat history:", error);
        res.status(500).json({ error: "Failed to load chat history" });
    }
});

app.get('/api/user-info/:userId', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId } = req.params;
    
    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    try {
        const [userRows] = await pool.execute(
            'SELECT id, firstName, avatar FROM users WHERE id = ?',
            [userId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json({
            id: userRows[0].id,
            firstName: userRows[0].firstName,
            avatar: userRows[0].avatar || DEFAULT_AVATAR
        });
    } catch (error) {
        console.error("Error loading user info:", error);
        res.status(500).json({ error: "Failed to load user info" });
    }
});

// Watch ad to earn coins
app.post('/api/watch-ad', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // Add 100 coins to user account
        await pool.execute(
            'UPDATE users SET coins = COALESCE(coins, 0) + 100 WHERE id = ?',
            [req.session.userId]
        );

        res.status(200).json({ 
            message: "Coins added successfully",
            coinsEarned: 100
        });
    } catch (error) {
        console.error("Error adding coins:", error);
        res.status(500).json({ error: "Failed to add coins" });
    }
});

// Buy coin package
app.post('/api/buy-coins', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { package: packageType, amount, price } = req.body;
    
    if (!packageType || !amount || !price) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        // In a real app, you would verify payment here
        // For now, we'll just add the coins
        
        // Add coins to user account
        await pool.execute(
            'UPDATE users SET coins = COALESCE(coins, 0) + ? WHERE id = ?',
            [amount, req.session.userId]
        );

        // Log the transaction (you might want to create a transactions table)
        console.log(`User ${req.session.userId} purchased ${amount} coins for $${price}`);

        res.status(200).json({ 
            message: "Coins purchased successfully",
            coinsAdded: amount,
            package: packageType
        });
    } catch (error) {
        console.error("Error purchasing coins:", error);
        res.status(500).json({ error: "Failed to purchase coins" });
    }
});

// Upgrade to premium
app.post('/api/upgrade-premium', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { plan, price, period } = req.body;

    try {
        // In a real app, you would verify subscription payment here
        // For now, we'll just upgrade the user
        
        // Check if user already has premium (active or cancelled) and calculate remaining time
        const [existingRows] = await pool.execute(
            'SELECT premium, premiumType, premiumStartDate, premiumCancelled FROM users WHERE id = ?',
            [req.session.userId]
        );

        let newStartDate = new Date();
        
        if (existingRows.length > 0 && existingRows[0].premiumStartDate) {
            // Calculate remaining time from existing subscription (active or cancelled)
            const existingStart = new Date(existingRows[0].premiumStartDate);
            const existingType = existingRows[0].premiumType;
            
            let remainingTime = 0;
            const now = new Date();
            
            switch (existingType) {
                case 'monthly':
                    remainingTime = Math.max(0, (existingStart.getTime() + (30 * 24 * 60 * 60 * 1000)) - now.getTime());
                    break;
                case 'half-year':
                    remainingTime = Math.max(0, (existingStart.getTime() + (6 * 30 * 24 * 60 * 60 * 1000)) - now.getTime());
                    break;
                case 'yearly':
                    remainingTime = Math.max(0, (existingStart.getTime() + (365 * 24 * 60 * 60 * 1000)) - now.getTime());
                    break;
            }
            
            if (remainingTime > 0) {
                // For premium upgrade (including after cancellation), start new plan when current one ends
                // This preserves all remaining time by starting the new plan at the end of current
                newStartDate = new Date(existingStart.getTime() + getPlanDuration(existingType));
            }
        }
        
        // Upgrade user to premium with accumulated time and reset cancelled status
        await pool.execute(
            'UPDATE users SET premium = true, premiumType = ?, premiumStartDate = ?, premiumCancelled = false WHERE id = ?',
            [plan, newStartDate, req.session.userId]
        );

        // Refresh user's profiles to give them more (premium users get 15 vs 5)
        try {
            // Get current user's existing profiles
            const [userRows] = await pool.execute(
                'SELECT pastProfiles, currentProfiles FROM users WHERE id = ?',
                [req.session.userId]
            );
            
            if (userRows.length > 0) {
                const user = userRows[0];
                let existingPastProfiles = [];
                
                // Safely parse past profiles
                try {
                    existingPastProfiles = user.pastProfiles ? JSON.parse(user.pastProfiles) : [];
                } catch (parseError) {
                    console.log('Error parsing past profiles, starting fresh:', parseError.message);
                    existingPastProfiles = [];
                }
                
                // Get all potential users (excluding current user and past profiles)
                const excludedIds = new Set(existingPastProfiles);
                excludedIds.add(req.session.userId);
                
                let allPotentialUsers = [];
                
                if (excludedIds.size > 1) { // More than just current user
                    const placeholders = Array.from(excludedIds).map(() => '?').join(',');
                    const [potentialRows] = await pool.execute(
                        `SELECT id, firstName, bio, avatar FROM users WHERE id NOT IN (${placeholders}) AND completedProfile = 1`,
                        Array.from(excludedIds)
                    );
                    allPotentialUsers = potentialRows.map(withDefaultAvatar);
                } else {
                    const [potentialRows] = await pool.execute(
                        'SELECT id, firstName, bio, avatar FROM users WHERE id != ? AND completedProfile = 1',
                        [req.session.userId]
                    );
                    allPotentialUsers = potentialRows.map(withDefaultAvatar);
                }
                
                // Premium users get 15 profiles, regular users get 5
                const limit = 15; // User is now premium
                let finalProfiles = [];
                
                // Shuffle and take first 15 profiles
                const shuffledProfiles = allPotentialUsers.sort(() => 0.5 - Math.random());
                finalProfiles = shuffledProfiles.slice(0, limit).map(withDefaultAvatar);
                
                if (finalProfiles.length > 0) {
                    const finalProfileIds = finalProfiles.map(p => p.id);
                    const combinedProfileIds = [...new Set([...existingPastProfiles, ...finalProfileIds])];
                    
                    // Update DB: Add to pastProfiles, set currentProfiles, and update timestamp
                    await pool.execute(
                        'UPDATE users SET pastProfiles = ?, currentProfiles = ?, lastTimeProfilesRefresh = NOW() WHERE id = ?',
                        [JSON.stringify(combinedProfileIds), JSON.stringify(finalProfiles), req.session.userId]
                    );
                    
                    console.log(`User ${req.session.userId} profiles refreshed: ${finalProfiles.length} new profiles available`);
                }
            }
        } catch (profileError) {
            console.log('Error refreshing profiles during premium upgrade:', profileError.message);
            // Don't fail the premium upgrade if profile refresh fails
        }

        console.log(`User ${req.session.userId} upgraded to premium ${plan} for ${price} with accumulated time`);

        res.status(200).json({ 
            message: "Premium upgrade successful",
            premium: true,
            plan: plan,
            period: period,
            startDate: newStartDate,
            profilesRefreshed: true
        });
    } catch (error) {
        console.error("Error upgrading to premium:", error);
        res.status(500).json({ error: "Failed to upgrade to premium" });
    }
});

// Buy letter credits
app.post('/api/buy-letter-credits', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { package: packageType, amount, price } = req.body;
    
    if (!packageType || !amount || !price) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        // In a real app, you would verify payment here
        // For now, we'll just add the credits
        
        // Add letter credits to user account
        await pool.execute(
            'UPDATE users SET letterCredits = COALESCE(letterCredits, 0) + ? WHERE id = ?',
            [amount, req.session.userId]
        );

        // Log the transaction
        console.log(`User ${req.session.userId} purchased ${amount} letter credits for $${price}`);

        res.status(200).json({ 
            message: "Letter credits purchased successfully",
            creditsAdded: amount,
            package: packageType
        });
    } catch (error) {
        console.error("Error purchasing letter credits:", error);
        res.status(500).json({ error: "Failed to purchase letter credits" });
    }
});

// Get subscription details
app.get('/api/subscription-details', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT premium, premiumType, premiumStartDate, premiumCancelled, premiumEndDate FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = rows[0];
        
        if (!user.premium) {
            return res.status(200).json({ premium: false });
        }

        // Calculate subscription end date based on type
        let endDate = null;
        if (user.premiumStartDate && user.premiumType) {
            let startDate = new Date(user.premiumStartDate);
            
            // Check if start date is in the past (invalid billing date)
            const now = new Date();
            if (startDate < now) {
                // Reset invalid billing date to now
                await pool.execute(
                    'UPDATE users SET premiumStartDate = NOW() WHERE id = ?',
                    [req.session.userId]
                );
                startDate = new Date();
            }
            
            switch (user.premiumType) {
                case 'monthly':
                    endDate = new Date(startDate.getTime() + (30 * 24 * 60 * 60 * 1000));
                    break;
                case 'half-year':
                    endDate = new Date(startDate.getTime() + (6 * 30 * 24 * 60 * 60 * 1000));
                    break;
                case 'yearly':
                    endDate = new Date(startDate.getTime() + (365 * 24 * 60 * 60 * 1000));
                    break;
            }
        }

        // If subscription is cancelled, check if it has expired
        if (user.premiumCancelled && endDate) {
            const now = new Date();
            if (now >= endDate) {
                // Subscription has expired, set premium to false
                await pool.execute(
                    'UPDATE users SET premium = false WHERE id = ?',
                    [req.session.userId]
                );
                return res.status(200).json({ premium: false });
            }
        }

        // Also check if any other users have expired cancelled subscriptions and clean them up
        try {
            await cleanupExpiredSubscriptions();
        } catch (cleanupError) {
            console.log('Error during cleanup of expired subscriptions:', cleanupError.message);
        }

        // Use premiumEndDate if available, otherwise use calculated endDate
        const actualEndDate = user.premiumEndDate ? user.premiumEndDate : endDate;

        res.status(200).json({
            premium: true,
            type: user.premiumType,
            startDate: user.premiumStartDate,
            endDate: actualEndDate,
            cancelled: Boolean(user.premiumCancelled)
        });
    } catch (error) {
        console.error("Error getting subscription details:", error);
        res.status(500).json({ error: "Failed to get subscription details" });
    }
});



// Upgrade subscription - REDIRECT TO STRIPE CHECKOUT
app.post('/api/upgrade-subscription', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { newPlan } = req.body;

    if (!newPlan) {
        return res.status(400).json({ error: "New plan is required" });
    }
    
    // Get subscription price IDs from environment variables
    const stripePriceIds = {
        'monthly': process.env.STRIPE_PRICE_MONTHLY_SUB,
        'half-year': process.env.STRIPE_PRICE_HALF_YEAR_SUB, 
        'yearly': process.env.STRIPE_PRICE_YEARLY_SUB
    };
    
    const priceId = stripePriceIds[newPlan];
    if (!priceId) {
        return res.status(400).json({ error: 'Invalid plan selected' });
    }
    
    try {
        // Get existing customer info for upgrade
        const [userRows] = await pool.execute(
            'SELECT email, stripeCustomerId, premiumType FROM users WHERE id = ?',
            [req.session.userId]
        );
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userRows[0];
        console.log(`🔄 Creating upgrade checkout for user ${req.session.userId} from ${user.premiumType} to ${newPlan}`);
        
        // Prepare checkout session configuration
        const sessionConfig = {
            payment_method_types: ['card'],
            line_items: [{
                price: priceId,
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${req.headers.origin}/marketplace?upgrade=success`,
            cancel_url: `${req.headers.origin}/marketplace?upgrade=cancelled`,
            metadata: {
                userId: req.session.userId.toString(),
                planType: newPlan,
                planName: `Premium ${newPlan.charAt(0).toUpperCase() + newPlan.slice(1)}`,
                isUpgrade: 'true',
                oldPlan: user.premiumType || 'none'
            }
        };
        
        // Use existing customer if available, otherwise use email
        if (user.stripeCustomerId) {
            console.log(`🔗 Using existing Stripe customer: ${user.stripeCustomerId}`);
            sessionConfig.customer = user.stripeCustomerId;
        } else {
            console.log(`📧 Using customer email: ${user.email}`);
            sessionConfig.customer_email = user.email;
        }
        
        // Create Stripe checkout session for upgrade
        const session = await stripe.checkout.sessions.create(sessionConfig);

        res.json({ 
            success: true, 
            url: session.url,
            message: 'Redirecting to Stripe checkout for upgrade payment...'
        });
        
    } catch (error) {
        console.error('Error creating upgrade checkout session:', error);
        res.status(500).json({ 
            error: 'Failed to create checkout session for upgrade',
            details: error.message 
        });
    }
    
    return; // Skip the old direct upgrade logic below

    try {
        // Get current subscription details to calculate remaining time
        const [existingRows] = await pool.execute(
            'SELECT premiumType, premiumStartDate FROM users WHERE id = ?',
            [req.session.userId]
        );

        // Prevent downgrades - only allow upgrades
        if (existingRows.length > 0 && existingRows[0].premiumType) {
            const currentPlan = existingRows[0].premiumType;
            if (!isPlanUpgrade(currentPlan, newPlan)) {
                return res.status(400).json({ 
                    error: "Downgrades are not allowed. You can only upgrade to a longer plan.",
                    currentPlan: currentPlan,
                    requestedPlan: newPlan
                });
            }
        }

        let newStartDate = new Date();
        
        if (existingRows.length > 0 && existingRows[0].premiumStartDate) {
            // Calculate remaining time from existing subscription
            const existingStart = new Date(existingRows[0].premiumStartDate);
            const existingType = existingRows[0].premiumType;
            
            let remainingTime = 0;
            const now = new Date();
            
            switch (existingType) {
                case 'monthly':
                    remainingTime = Math.max(0, (existingStart.getTime() + (30 * 24 * 60 * 60 * 1000)) - now.getTime());
                    break;
                case 'half-year':
                    remainingTime = Math.max(0, (existingStart.getTime() + (6 * 30 * 24 * 60 * 60 * 1000)) - now.getTime());
                    break;
                case 'yearly':
                    remainingTime = Math.max(0, (existingStart.getTime() + (365 * 24 * 60 * 60 * 1000)) - now.getTime());
                    break;
            }
            
            // Only allow upgrades - accumulate remaining time
            if (remainingTime > 0) {
                // For upgrades, start new plan when current one ends
                // This preserves all remaining time by starting the new plan at the end of current
                newStartDate = new Date(existingStart.getTime() + getPlanDuration(existingType));
            }
        }
        
        // Update user's premium type with accumulated time
        await pool.execute(
            'UPDATE users SET premiumType = ?, premiumStartDate = ? WHERE id = ?',
            [newPlan, newStartDate, req.session.userId]
        );

        // Refresh user's profiles to give them more (premium users get 15 vs 5)
        try {
            // Get current user's existing profiles
            const [userRows] = await pool.execute(
                'SELECT pastProfiles, currentProfiles FROM users WHERE id = ?',
                [req.session.userId]
            );
            
            if (userRows.length > 0) {
                const user = userRows[0];
                let existingPastProfiles = [];
                
                // Safely parse past profiles
                try {
                    existingPastProfiles = user.pastProfiles ? JSON.parse(user.pastProfiles) : [];
                } catch (parseError) {
                    console.log('Error parsing past profiles, starting fresh:', parseError.message);
                    existingPastProfiles = [];
                }
                
                // Get all potential users (excluding current user and past profiles)
                const excludedIds = new Set(existingPastProfiles);
                excludedIds.add(req.session.userId);
                
                let allPotentialUsers = [];
                
                if (excludedIds.size > 1) { // More than just current user
                    const placeholders = Array.from(excludedIds).map(() => '?').join(',');
                    const [potentialRows] = await pool.execute(
                        `SELECT id, firstName, bio, avatar FROM users WHERE id NOT IN (${placeholders}) AND completedProfile = 1`,
                        Array.from(excludedIds)
                    );
                    allPotentialUsers = potentialRows.map(withDefaultAvatar);
                } else {
                    const [potentialRows] = await pool.execute(
                        'SELECT id, firstName, bio, avatar FROM users WHERE id != ? AND completedProfile = 1',
                        [req.session.userId]
                    );
                    allPotentialUsers = potentialRows.map(withDefaultAvatar);
                }
                
                // Premium users get 15 profiles, regular users get 5
                const limit = 15; // User is now premium
                let finalProfiles = [];
                
                // Shuffle and take first 15 profiles
                const shuffledProfiles = allPotentialUsers.sort(() => 0.5 - Math.random());
                finalProfiles = shuffledProfiles.slice(0, limit).map(withDefaultAvatar);
                
                if (finalProfiles.length > 0) {
                    const finalProfileIds = finalProfiles.map(p => p.id);
                    const combinedProfileIds = [...new Set([...existingPastProfiles, ...finalProfileIds])];
                    
                    // Update DB: Add to pastProfiles, set currentProfiles, and update timestamp
                    await pool.execute(
                        'UPDATE users SET pastProfiles = ?, currentProfiles = ?, lastTimeProfilesRefresh = NOW() WHERE id = ?',
                        [JSON.stringify(combinedProfileIds), JSON.stringify(finalProfiles), req.session.userId]
                    );
                    
                    console.log(`User ${req.session.userId} profiles refreshed during subscription upgrade: ${finalProfiles.length} new profiles available`);
                }
            }
        } catch (profileError) {
            console.log('Error refreshing profiles during subscription upgrade:', profileError.message);
            // Don't fail the subscription upgrade if profile refresh fails
        }

        const isUpgrade = isPlanUpgrade(existingRows[0].premiumType, newPlan);
        const actionType = isUpgrade ? 'upgraded' : 'downgraded';
        console.log(`User ${req.session.userId} ${actionType} subscription from ${existingRows[0].premiumType} to ${newPlan} with preserved time`);
        
        res.status(200).json({ 
            message: `Subscription ${actionType} successfully`,
            newPlan: newPlan,
            startDate: newStartDate,
            actionType: actionType,
            profilesRefreshed: true
        });
    } catch (error) {
        console.error("Error upgrading subscription:", error);
        res.status(500).json({ error: "Failed to upgrade subscription" });
    }
});

// Reactivate cancelled subscription
app.post('/api/reactivate-subscription', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Authentication required" });
    }

    try {
        console.log('🔄 Reactivating subscription for user:', req.session.userId);
        
        // Get user's current subscription info
        const [rows] = await pool.execute(
            'SELECT stripeSubscriptionId, premiumCancelled, premium FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = rows[0];
        
        if (!user.premium) {
            return res.status(400).json({ error: "No active subscription to reactivate" });
        }

        if (!user.premiumCancelled) {
            return res.status(400).json({ error: "Subscription is not cancelled" });
        }

        if (!user.stripeSubscriptionId) {
            return res.status(400).json({ error: "No Stripe subscription found" });
        }

        // Reactivate the subscription in Stripe
        try {
            console.log('🔄 Reactivating Stripe subscription:', user.stripeSubscriptionId);
            const subscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
                cancel_at_period_end: false
            });
            
            console.log('✅ Stripe subscription reactivated');
            console.log('📅 Subscription will continue until:', new Date(subscription.current_period_end * 1000));
            
            // Update local database - remove cancellation only (DO NOT change end date)
            await pool.execute(
                'UPDATE users SET premiumCancelled = 0 WHERE id = ?',
                [req.session.userId]
            );
            
            console.log('✅ Database updated - subscription reactivated');
            
            res.json({ 
                success: true, 
                message: "Subscription reactivated successfully",
                nextBilling: new Date(subscription.current_period_end * 1000)
            });
            
        } catch (stripeError) {
            console.error('❌ Stripe reactivation failed:', stripeError.message);
            
            // If Stripe fails, still update locally (maybe subscription was already active in Stripe)
            await pool.execute(
                'UPDATE users SET premiumCancelled = 0, premiumEndDate = NULL WHERE id = ?',
                [req.session.userId]
            );
            
            res.json({ 
                success: true, 
                message: "Subscription reactivated locally (Stripe may have already been active)",
                warning: "Please verify your subscription status in Stripe"
            });
        }
        
    } catch (error) {
        console.error('❌ Error reactivating subscription:', error);
        res.status(500).json({ 
            error: "Failed to reactivate subscription",
            details: error.message 
        });
    }
});

// Cancel subscription
app.post('/api/cancel-subscription', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // Get current subscription details including Stripe subscription ID
        const [rows] = await pool.execute(
            'SELECT premiumType, premiumStartDate, premiumEndDate, stripeSubscriptionId FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = rows[0];
        
        if (!user.premiumType || !user.premiumStartDate) {
            return res.status(400).json({ error: "No active subscription found" });
        }

        // Cancel the subscription in Stripe (set to cancel at period end to allow reactivation)
        if (user.stripeSubscriptionId) {
            try {
                console.log(`🚫 Setting Stripe subscription to cancel at period end: ${user.stripeSubscriptionId}`);
                const cancelledSubscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
                    cancel_at_period_end: true
                });
                console.log(`✅ Stripe subscription set to cancel at period end`);
                console.log(`📅 Access will end at: ${new Date(cancelledSubscription.current_period_end * 1000)}`);
                console.log(`🔄 Can be reactivated until: ${new Date(cancelledSubscription.current_period_end * 1000)}`);
                
                // Update our database with the actual end date from Stripe
                await pool.execute(
                    'UPDATE users SET premiumEndDate = ? WHERE id = ?',
                    [new Date(cancelledSubscription.current_period_end * 1000), req.session.userId]
                );
            } catch (stripeError) {
                console.error('❌ Error cancelling Stripe subscription:', stripeError);
                console.error('Stripe error details:', stripeError.message);
                
                // Don't fail the whole operation - continue with local cancellation
                console.log('⚠️  Continuing with local cancellation despite Stripe error');
            }
        } else {
            console.log('⚠️  No Stripe subscription ID found - only cancelling locally');
        }

        // Get updated user data after potential premiumEndDate update
        const [updatedRows] = await pool.execute(
            'SELECT premiumEndDate FROM users WHERE id = ?',
            [req.session.userId]
        );
        const updatedUser = updatedRows[0];

        // Calculate when subscription will end (use updated premiumEndDate or fallback)
        let endDate = null;
        if (updatedUser.premiumEndDate) {
            endDate = new Date(updatedUser.premiumEndDate);
        } else if (user.premiumStartDate && user.premiumType) {
            const startDate = new Date(user.premiumStartDate);
            switch (user.premiumType) {
                case 'monthly':
                    endDate = new Date(startDate.getTime() + (30 * 24 * 60 * 60 * 1000));
                    break;
                case 'half-year':
                    endDate = new Date(startDate.getTime() + (6 * 30 * 24 * 60 * 60 * 1000));
                    break;
                case 'yearly':
                    endDate = new Date(startDate.getTime() + (365 * 24 * 60 * 60 * 1000));
                    break;
            }
        }

        // Mark subscription as cancelled locally (keep premium active until end date)
        const cancelResult = await pool.execute(
            'UPDATE users SET premiumCancelled = 1 WHERE id = ?',
            [req.session.userId]
        );

        console.log(`User ${req.session.userId} cancelled subscription - DB update result:`, cancelResult[0]);
        
        // Verify the update worked
        const [verifyRows] = await pool.execute(
            'SELECT premiumCancelled FROM users WHERE id = ?',
            [req.session.userId]
        );
        console.log(`✅ Verified premiumCancelled status:`, verifyRows[0].premiumCancelled);

        res.status(200).json({ 
            message: "Subscription cancelled successfully",
            endDate: endDate,
            type: user.premiumType
        });
    } catch (error) {
        console.error("Error cancelling subscription:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ 
            error: "Failed to cancel subscription", 
            details: error.message 
        });
    }
});

// Update SafeSend preferences
app.post('/api/update-safesend', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: "Enabled status must be a boolean" });
    }

    try {
        // Update user's SafeSend preference
        await pool.execute(
            'UPDATE users SET safesendEnabled = ? WHERE id = ?',
            [enabled, req.session.userId]
        );

        console.log(`User ${req.session.userId} ${enabled ? 'enabled' : 'disabled'} SafeSend`);

        res.status(200).json({ 
            message: `SafeSend ${enabled ? 'enabled' : 'disabled'} successfully`,
            safesendEnabled: enabled
        });
    } catch (error) {
        console.error("Error updating SafeSend preferences:", error);
        res.status(500).json({ error: "Failed to update SafeSend preferences" });
    }
});

// Get SafeSend preferences
app.get('/api/safesend-preferences', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // Get user's SafeSend preference
        const [rows] = await pool.execute(
            'SELECT safesendEnabled FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json({ 
            safesendEnabled: rows[0].safesendEnabled
        });
    } catch (error) {
        console.error("Error getting SafeSend preferences:", error);
        res.status(500).json({ error: "Failed to get SafeSend preferences" });
    }
});


  
app.listen(PORT, () => {
  initializeDatabase(); // Initialize DB when server starts
  console.log(`Server is running on http://localhost:${PORT}`);
  
  // Set up periodic cleanup of expired subscriptions (every hour)
  setInterval(cleanupExpiredSubscriptions, 60 * 60 * 1000);
  console.log('Periodic subscription cleanup scheduled (every hour)');
  
  // Set up monthly coin distribution (check daily at 9 AM)
  setInterval(distributeMonthlyCoins, 24 * 60 * 60 * 1000);
  console.log('Monthly coin distribution scheduled (daily check)');
  
  // Automatic referral payments removed - admin now has full manual control
});

// Unity Ads Configuration API
app.get('/api/unity-ads-config', (req, res) => {
    res.json({
        gameId: process.env.UNITY_GAME_ID || '',
        rewardedPlacementId: process.env.UNITY_REWARDED_PLACEMENT_ID || '',
        testMode: process.env.NODE_ENV !== 'production' // Test mode in development
    });
});

// Send Gift API
app.post('/api/send-gift', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Please log in to send gifts' });
        }
        
        const { recipientId, amount, message } = req.body;
        
        if (!recipientId || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid gift data' });
        }
        
        
        const senderId = req.session.userId;
        
        // Check if sender has enough coins
        const [senderRows] = await pool.execute(
            'SELECT coins FROM users WHERE id = ?',
            [senderId]
        );
        
        if (senderRows.length === 0) {
            return res.status(404).json({ error: 'Sender not found' });
        }
        
        if (senderRows[0].coins < amount) {
            return res.status(400).json({ error: 'Insufficient coins' });
        }
        
        // Check if recipient exists
        const [recipientRows] = await pool.execute(
            'SELECT id, firstName FROM users WHERE id = ?',
            [recipientId]
        );
        
        if (recipientRows.length === 0) {
            return res.status(404).json({ error: 'Recipient not found' });
        }
        
        // Get a connection for transaction
        const connection = await pool.getConnection();
        
        try {
            // Start transaction
            await connection.query('START TRANSACTION');
            
            // Deduct coins from sender
            await connection.execute(
                'UPDATE users SET coins = coins - ? WHERE id = ?',
                [amount, senderId]
            );
            
            // Add coins to recipient
            await connection.execute(
                'UPDATE users SET coins = coins + ? WHERE id = ?',
                [amount, recipientId]
            );
            
            // Get sender's name
            const [senderNameRows] = await connection.execute(
                'SELECT firstName FROM users WHERE id = ?',
                [senderId]
            );
            const senderName = senderNameRows[0]?.firstName || 'Anonymous';
            
            // Create gift message in chat
            await connection.execute(
                'INSERT INTO messages (sender_id, recipient_id, content, message_type, created_at) VALUES (?, ?, ?, ?, NOW())',
                [senderId, recipientId, JSON.stringify({
                    type: 'gift',
                    amount: amount,
                    message: message || '',
                    senderName: senderName
                }), 'gift']
            );
            
            // Log transaction
            await connection.execute(
                'INSERT INTO transaction_logs (user_id, transaction_type, amount, status, created_at) VALUES (?, ?, ?, ?, NOW())',
                [senderId, 'purchase', -amount, 'completed']
            );
            
            await connection.execute(
                'INSERT INTO transaction_logs (user_id, transaction_type, amount, status, created_at) VALUES (?, ?, ?, ?, NOW())',
                [recipientId, 'purchase', amount, 'completed']
            );
            
            await connection.query('COMMIT');
            
            res.json({
                success: true,
                message: `Gift of ${amount} coins sent successfully!`
            });
            
      } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
        } finally {
            connection.release();
        }
        
    } catch (error) {
        console.error('Error sending gift:', error);
        res.status(500).json({ error: 'Failed to send gift' });
    }
});

// Watch Ad Reward API
app.post('/api/watch-ad-reward', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ success: false, message: 'Please log in to watch ads' });
        }
        
        const userId = req.session.userId;
        const coinsEarned = 50; // 50 coins per ad
        
        // Add coins to user's existing balance
        await pool.execute(
            'UPDATE users SET coins = coins + ? WHERE id = ?',
            [coinsEarned, userId]
        );
        
        // Log transaction
        await pool.execute(
            'INSERT INTO transaction_logs (user_id, transaction_type, amount, status, created_at) VALUES (?, ?, ?, ?, NOW())',
            [userId, 'purchase', coinsEarned, 'completed']
        );
        
        res.json({
            success: true,
            coinsEarned: coinsEarned,
            message: `You earned ${coinsEarned} coins!`
        });
        
    } catch (error) {
        console.error('Error processing ad reward:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process ad reward'
        });
    }
});