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

// Helper function to determine actual premium status (including cancelled but not expired)
const getActualPremiumStatus = (user) => {
    if (!user.premiumCancelled || !user.premiumStartDate || !user.premiumType) {
        return user.premium;
    }
    
    // Check if cancelled subscription has expired
    const startDate = new Date(user.premiumStartDate);
    const now = new Date();
    const endDate = new Date(startDate.getTime() + getPlanDuration(user.premiumType));
    
    // If not expired, user still has premium access
    return now < endDate;
};


// --- Middleware (mostly unchanged) ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set('view engine', 'ejs');



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
  

const client = new OAuth2Client("409368143445-v7ukcrsjh9lc9vj2h1t70ufg1fa4ej1v.apps.googleusercontent.com");
const CLIENT_ID = "409368143445-v7ukcrsjh9lc9vj2h1t70ufg1fa4ej1v.apps.googleusercontent.com";


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
        
        const totalCleaned = monthlyResult.affectedRows + halfYearResult.affectedRows + yearlyResult.affectedRows;
        if (totalCleaned > 0) {
            console.log(`Cleaned up ${totalCleaned} expired cancelled subscriptions`);
        }
    } catch (error) {
        console.log('Error during cleanup of expired subscriptions:', error.message);
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
          creditLetters INT DEFAULT 0,
          completedProfile BOOLEAN DEFAULT 0,
          coins INT DEFAULT 0,
          premium BOOLEAN DEFAULT 0,
          premiumType ENUM('monthly', 'half-year', 'yearly') NULL,
          premiumStartDate DATETIME NULL,
          premiumCancelled BOOLEAN DEFAULT FALSE,
          safesendEnabled BOOLEAN DEFAULT TRUE,
          pastProfiles JSON,
          lastTimeProfilesRefresh DATETIME,
          currentProfiles JSON,
          chatHistory JSON
      )
    `);

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
          message_type ENUM('email', 'letter') NOT NULL,
          status ENUM('sent', 'delivered', 'read') DEFAULT 'sent',
          delivery_time DATETIME NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Add delivery_time column to existing messages table if it doesn't exist
    try {
        await connection.query(`
            ALTER TABLE messages 
            ADD COLUMN delivery_time DATETIME NULL
        `);
        console.log('Added delivery_time column to messages table');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('Column delivery_time already exists, skipping.');
        } else {
            console.log('Error adding delivery_time column:', err.message);
        }
    }

    // Add premium type and start date columns to existing users table if they don't exist
    try {
        await connection.query(`
            ALTER TABLE users 
            ADD COLUMN premiumType ENUM('monthly', 'half-year', 'yearly') NULL
        `);
        console.log('Added premiumType column to users table');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('Column premiumType already exists, skipping.');
        } else {
            console.log('Error adding premiumType column:', err.message);
        }
    }

    try {
        await connection.query(`
            ALTER TABLE users 
            ADD COLUMN premiumStartDate DATETIME NULL
        `);
        console.log('Added premiumStartDate column to users table');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('Column premiumStartDate already exists, skipping.');
        } else {
            console.log('Error adding premiumStartDate column:', err.message);
        }
    }

    // Add premiumCancelled column to existing users table if it doesn't exist
    try {
        await connection.query(`
            ALTER TABLE users 
            ADD COLUMN premiumCancelled BOOLEAN DEFAULT FALSE
        `);
        console.log('Added premiumCancelled column to users table');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('Column premiumCancelled already exists, skipping.');
        } else {
            console.log('Error adding premiumCancelled column:', err.message);
        }
    }

    // Add SafeSend preferences column to existing users table if it doesn't exist
    try {
        await connection.query(`
            ALTER TABLE users 
            ADD COLUMN safesendEnabled BOOLEAN DEFAULT TRUE
        `);
        console.log('Added safesendEnabled column to users table');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('Column safesendEnabled already exists, skipping.');
        } else {
            console.log('Error adding safesendEnabled column:', err.message);
        }
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

    // Clean up expired cancelled subscriptions
    try {
        await cleanupExpiredSubscriptions();
    } catch (err) {
        console.log('Error during initial cleanup of expired subscriptions:', err.message);
    }

    // await connection.query(`
    //   CREATE TABLE IF NOT EXISTS reset_tokens (
    //       id INT PRIMARY KEY AUTO_INCREMENT,
    //       email VARCHAR(255) NOT NULL,
    //       token VARCHAR(255) NOT NULL UNIQUE,
    //       expires_at DATETIME NOT NULL
    //   )
    // `);
//     try {
//         await connection.query(
//           `UPDATE messages 
//            SET created_at = NOW() - INTERVAL 230 HOUR
//            WHERE id = ?`,
//           [17]
//         );
//         // pool.execute("DELETE FROM users WHERE id = ?", [26]);
//         // pool.execute("DROP TABLE users");

// console.log('cool');
//       } catch (err) {
//         console.error(err);
//       }

    // pool.execute("DELETE FROM codes", [22]);


// // Wrap the code in an async function and call it immediately
//     (async () => {
//         try {
//             await connection.query(
//                 `ALTER TABLE users
// ADD COLUMN chatHistory JSON`,
//             );
//             console.log('Column added');
//         } catch (err) {
//             if (err.code === 'ER_DUP_FIELDNAME') {
//                 console.log('Column first_sent_at already exists, skipping.');
//             } else {
//                 console.error('Error adding column:', err);
//             }
//         }
//     })();
//     const users = [
//         { firstName: 'Liam', lastName: 'Garcia', newsletter: true, email: 'liam.g@example.com', password: 'hashed_password_1', email_verified: true, dob: '1992-11-20', bio: 'Exploring the world one city at a time.', interests: ['✈️ Travel', '📸 Photography', '🌍 Languages'], address: '101 Adventurer Ave, Wanderlust, USA', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/F4B400/000000?text=LG' },
//         { firstName: 'Olivia', lastName: 'Martinez', newsletter: false, email: 'olivia.m@example.com', password: 'hashed_password_2', email_verified: true, dob: '1995-03-15', bio: 'Fitness enthusiast and healthy recipe creator.', interests: ['🏋️ Fitness', '👨‍🍳 Cooking', '🧘‍♀️ Yoga'], address: '202 Wellness Way, Greenville, CA', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/4285F4/FFFFFF?text=OM' },
//         { firstName: 'Noah', lastName: 'Rodriguez', newsletter: true, email: 'noah.r@example.com', password: 'hashed_password_3', email_verified: false, dob: '1988-07-22', bio: 'Digital artist and sci-fi movie buff.', interests: ['🎨 Art', '🎬 Movies', '👽 Science Fiction'], address: '303 Creative Ct, Metropolis, NY', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/DB4437/FFFFFF?text=NR' },
//         { firstName: 'Emma', lastName: 'Hernandez', newsletter: true, email: 'emma.h@example.com', password: 'hashed_password_4', email_verified: true, dob: '2000-01-30', bio: 'Passionate about sustainable living and gardening.', interests: ['🌱 Gardening', '🌿 Environment', '♻️ Sustainability'], address: '404 Eco Lane, Verdant, OR', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/0F9D58/FFFFFF?text=EH' },
//         { firstName: 'Oliver', lastName: 'Lopez', newsletter: false, email: 'oliver.l@example.com', password: 'hashed_password_5', email_verified: true, dob: '1998-09-05', bio: 'Gamer, streamer, and tech reviewer.', interests: ['🎮 Gaming', '💻 Technology', '📡 Streaming'], address: '505 Pixel Place, Silicon Valley, CA', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/F4B400/000000?text=OL' },
//         { firstName: 'Ava', lastName: 'Gonzalez', newsletter: true, email: 'ava.g@example.com', password: 'hashed_password_6', email_verified: false, dob: '1993-06-12', bio: 'Musician and live music lover.', interests: ['🎵 Music', '🎙️ Podcasts', '🌃 Nightlife'], address: '606 Melody Mews, Austin, TX', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/4285F4/FFFFFF?text=AG' },
//         { firstName: 'Elijah', lastName: 'Wilson', newsletter: false, email: 'elijah.w@example.com', password: 'hashed_password_7', email_verified: true, dob: '1985-02-18', bio: 'History buff and volunteer at the local museum.', interests: ['📜 History', '🤝 Volunteering', '📖 Reading'], address: '707 Archive Ave, Boston, MA', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/DB4437/FFFFFF?text=EW' },
//         { firstName: 'Sophia', lastName: 'Anderson', newsletter: true, email: 'sophia.a@example.com', password: 'hashed_password_8', email_verified: true, dob: '1999-12-01', bio: 'Fashion blogger and DIY enthusiast.', interests: ['👗 Fashion', '🛍️ Shopping', '🔨 DIY Projects'], address: '808 Style Street, New York, NY', wantsPhysicalMail: true, gender: 'Female', avatar: 'https://placehold.co/200x200/0F9D58/FFFFFF?text=SA' },
//         { firstName: 'Mateo', lastName: 'Thomas', newsletter: false, email: 'mateo.t@example.com', password: 'hashed_password_9', email_verified: false, dob: '1991-04-25', bio: 'Outdoor adventurer and camper.', interests: ['🌄 Adventure', '🏕️ Outdoors', '🥾 Hiking'], address: '909 Summit Trail, Denver, CO', wantsPhysicalMail: false, gender: 'Male', avatar: 'https://placehold.co/200x200/F4B400/000000?text=MT' },
//         { firstName: 'Isabella', lastName: 'Taylor', newsletter: true, email: 'isabella.t@example.com', password: 'hashed_password_10', email_verified: true, dob: '1996-08-14', bio: 'Animal lover and pet shelter volunteer.', interests: ['🐶 Animals', '🐾 Pets', '❤️ Charity'], address: '1010 Paws Place, San Diego, CA', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/4285F4/FFFFFF?text=IT' },
//         { firstName: 'Lucas', lastName: 'Moore', newsletter: true, email: 'lucas.m@example.com', password: 'hashed_password_11', email_verified: true, dob: '1990-10-03', bio: 'Entrepreneur and startup enthusiast.', interests: ['💼 Business', '🚀 Entrepreneurship', '🌐 Startup Culture'], address: '1111 Innovation Drive, San Francisco, CA', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/DB4437/FFFFFF?text=LM' },
//         { firstName: 'Mia', lastName: 'Jackson', newsletter: false, email: 'mia.j@example.com', password: 'hashed_password_12', email_verified: false, dob: '2002-05-21', bio: 'Dancer, choreographer, and theatre kid.', interests: ['💃 Dancing', '🎭 Theatre', '😂 Comedy'], address: '1212 Stage St, Los Angeles, CA', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/0F9D58/FFFFFF?text=MJ' },
//         { firstName: 'Levi', lastName: 'White', newsletter: true, email: 'levi.w@example.com', password: 'hashed_password_13', email_verified: true, dob: '1989-03-09', bio: 'Car fanatic and motorcycle rider.', interests: ['🚗 Cars', '🏍️ Motorcycles', '🚙 Road Trips'], address: '1313 Gearshift Grove, Detroit, MI', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/F4B400/000000?text=LW' },
//         { firstName: 'Amelia', lastName: 'Harris', newsletter: false, email: 'amelia.h@example.com', password: 'hashed_password_14', email_verified: true, dob: '1997-06-28', bio: 'Home decor blogger and interior design student.', interests: ['🏡 Home Decor', '🛋️ Interior Design', '📝 Blogging'], address: '1414 Design District, Miami, FL', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/4285F4/FFFFFF?text=AH' },
//         { firstName: 'Asher', lastName: 'Martin', newsletter: true, email: 'asher.m@example.com', password: 'hashed_password_15', email_verified: false, dob: '1994-01-11', bio: 'Coffee connoisseur and aspiring mixologist.', interests: ['☕ Coffee Culture', '🍸 Mixology', '🍷 Wine Tasting'], address: '1515 Barista Blvd, Seattle, WA', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/DB4437/FFFFFF?text=AM' },
//         { firstName: 'Charlotte', lastName: 'Thompson', newsletter: true, email: 'charlotte.t@example.com', password: 'hashed_password_16', email_verified: true, dob: '1992-09-19', bio: 'Financial analyst and crypto investor.', interests: ['💰 Investing', '🪙 Crypto', '📈 Self-Improvement'], address: '1616 Bull Market, New York, NY', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/0F9D58/FFFFFF?text=CT' },
//         { firstName: 'Leo', lastName: 'Garcia', newsletter: false, email: 'leo.g@example.com', password: 'hashed_password_17', email_verified: true, dob: '1999-04-02', bio: 'Sports fanatic, especially soccer and cycling.', interests: ['⚽ Sports', '🚴 Cycling', '🎮 Esports'], address: '1717 Champion Circle, Chicago, IL', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/F4B400/000000?text=LG' },
//         { firstName: 'Evelyn', lastName: 'Clark', newsletter: true, email: 'evelyn.c@example.com', password: 'hashed_password_18', email_verified: true, dob: '1987-08-30', bio: 'Loves board games, puzzles, and a good fantasy novel.', interests: ['♟️ Board Games', '🧩 Puzzles', '🐉 Fantasy'], address: '1818 Meeple Manor, Portland, OR', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/4285F4/FFFFFF?text=EC' },
//         { firstName: 'Ezra', lastName: 'Lewis', newsletter: false, email: 'ezra.l@example.com', password: 'hashed_password_19', email_verified: false, dob: '2001-02-14', bio: 'Skateboarder, surfer, and beach bum.', interests: ['🛹 Skateboarding', '🏄 Surfing', '🏖️ Beach Life'], address: '1919 Wave Rider Way, Honolulu, HI', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/DB4437/FFFFFF?text=EL' },
//         { firstName: 'Harper', lastName: 'Robinson', newsletter: true, email: 'harper.r@example.com', password: 'hashed_password_20', email_verified: true, dob: '1993-10-27', bio: 'Vlogger and social media influencer.', interests: ['📱 Social Media', '📹 Vlogging', '💄 Makeup'], address: '2020 Viral View, Los Angeles, CA', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/0F9D58/FFFFFF?text=HR' },
//         { firstName: 'Hudson', lastName: 'Walker', newsletter: true, email: 'hudson.w@example.com', password: 'hashed_password_21', email_verified: true, dob: '1986-12-12', bio: 'Programmer specializing in AI and robotics.', interests: ['👨‍💻 Programming', '🤖 Robotics', '🧠 AI & Machine Learning'], address: '2121 Code Canyon, Pittsburgh, PA', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/F4B400/000000?text=HW' },
//         { firstName: 'Luna', lastName: 'Perez', newsletter: false, email: 'luna.p@example.com', password: 'hashed_password_22', email_verified: false, dob: '1998-06-06', bio: 'Into astrology, meditation, and spiritual growth.', interests: ['🌌 Astrology', '🧘 Meditation', '✨ Spirituality'], address: '2222 Cosmic Cres, Sedona, AZ', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/4285F4/FFFFFF?text=LP' },
//         { firstName: 'Jack', lastName: 'Hall', newsletter: true, email: 'jack.h@example.com', password: 'hashed_password_23', email_verified: true, dob: '1995-07-17', bio: 'Foodie who loves trying new restaurants and recipes.', interests: ['🍔 Food & Drink', '🍽️ Foodie Life', '🍺 Beer Tasting'], address: '2323 Gourmet Gateway, New Orleans, LA', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/DB4437/FFFFFF?text=JH' },
//         { firstName: 'Aria', lastName: 'Young', newsletter: false, email: 'aria.y@example.com', password: 'hashed_password_24', email_verified: true, dob: '2003-03-03', bio: 'Anime and manga enthusiast.', interests: ['🗾 Anime', '📚 Comics', '✍️ Writing'], address: '2424 Otaku Oasis, Akihabara, JP', wantsPhysicalMail: false, gender: 'Female', avatar: 'https://placehold.co/200x200/0F9D58/FFFFFF?text=AY' },
//         { firstName: 'Jayden', lastName: 'Allen', newsletter: true, email: 'jayden.a@example.com', password: 'hashed_password_25', email_verified: false, dob: '1996-05-05', bio: 'Political science student and debate club president.', interests: ['🗳️ Politics', '🧠 Psychology', '🎓 Education'], address: '2525 Capitol Hill, Washington, DC', wantsPhysicalMail: true, gender: 'Male', avatar: 'https://placehold.co/200x200/F4B400/000000?text=JA' }
//     ];

//     const query = `
//     INSERT IGNORE INTO users (
//       firstName, lastName, newsletter, email, password, email_verified, 
//       dob, bio, interests, address, wantsPhysicalMail, gender, avatar
//     ) VALUES ?
//   `;

//   // Map the array of user objects to an array of arrays for the query.
//   const values = users.map(user => [
//     user.firstName,
//     user.lastName,
//     user.newsletter,
//     user.email,
//     user.password,
//     user.email_verified,
//     user.dob,
//     user.bio,
//     JSON.stringify(user.interests), // MySQL JSON type accepts a stringified JSON
//     user.address,
//     user.wantsPhysicalMail,
//     user.gender,
//     user.avatar
//   ]);
  
//   // The .query method can handle bulk inserts when the values are structured this way.
//   const [result] = await pool.query(query, [values]);


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
        const sql = "INSERT INTO users (email, password, firstName, lastName, newsletter) VALUES (?, ?, ?, ?, ?)";
        const [result] = await pool.execute(sql, [email, hashedPassword, firstName, lastName, newsletter ? 1 : 0]);
        
        req.session.userId = result.insertId; // UPDATED: Get last inserted ID
        req.session.email = email;
        req.session.firstName = firstName;

        res.sendStatus(200);
    } catch (err) {
        console.error(err);
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

    const sql = `INSERT INTO users (email, password, firstName, lastName, newsletter, email_verified) VALUES (?, ?, ?, ?, ?, ?)`;
    const [result] = await pool.execute(sql, [
        email, null, given_name || "", family_name || "", 1, email_verified ? 1 : 0
    ]);
        
    req.session.userId = result.insertId;
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

app.get("/register-page", (req, res) => res.render("register-page"));
app.get("/login-page", (req, res) => res.render("login-page"));
app.get("/forgot", (req, res) => res.render("forgot-password"));

app.get("/", (req, res) => {
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
        return res.redirect("/login-page");
    }
    res.render("mathes", { user: { "name": req.session.firstName, "email": req.session.email } });
});


app.get("/writing", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login-page");
    }
    res.render("writing");
});

app.get("/chats", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login-page");
    }
    res.render("chats", { user: { "name": req.session.firstName, "email": req.session.email } });
});

app.get("/chat-view", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login-page");
    }
    res.render("chat-view", { user: { "name": req.session.firstName, "email": req.session.email } });
});

app.get("/marketplace", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login-page");
    }
    res.render("marketplace");
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
            'SELECT id, firstName, creditLetters, avatar, completedProfile, coins, premium, premiumType, premiumStartDate, premiumCancelled FROM users WHERE id = ?', 
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

        const currentUser = {
            id: rows[0].id,
            name: rows[0].firstName,
            letterCredits: rows[0].creditLetters, 
            avatar: rows[0].avatar,
            completedProfile: rows[0].completedProfile,
            coins: rows[0].coins,
            premium: actualPremiumStatus
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
        const currentProfiles = currentUser.currentProfiles || [];
        
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
                `SELECT id, firstName, bio, interests, avatar, premium, premiumType, premiumStartDate, premiumCancelled FROM users WHERE id NOT IN (${placeholders})`, 
                [...excludedIds]
            );
            allPotentialUsers = rows;
        } else {
            const [rows] = await pool.execute(
                'SELECT id, firstName, bio, interests, avatar, premium, premiumType, premiumStartDate, premiumCancelled FROM users WHERE id != ?', 
                [req.session.userId]
            );
            allPotentialUsers = rows;
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
                `SELECT id, firstName, bio, interests, avatar FROM users WHERE id != ? ORDER BY RAND() LIMIT ${limit}`,
                [req.session.userId]
            );
            
            finalProfiles = freshRandomUsers;
            const finalProfileIds = finalProfiles.map(p => p.id);
            
            // Update DB: Reset pastProfiles, set currentProfiles, and update timestamp
            await pool.execute(
                'UPDATE users SET pastProfiles = ?, currentProfiles = ?, lastTimeProfilesRefresh = NOW() WHERE id = ?',
                [JSON.stringify(finalProfileIds), JSON.stringify(finalProfiles), req.session.userId]
            );

        } else if (finalProfiles.length > 0) {
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
        "avatar": rows[0].avatar || null,
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
        return res.redirect("/login-page");
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
    const cost = 100;

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
        
        const [potentialUsers] = await pool.execute(
            `SELECT id, firstName, bio, interests, avatar FROM users WHERE id NOT IN (${placeholders})`,
            excludedIds
        );

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

    const { content, recipientId, messageType } = req.body;
    
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
                'SELECT creditLetters FROM users WHERE id = ?',
                [req.session.userId]
            );

            if (userRows.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }

            if (userRows[0].creditLetters <= 0) {
                return res.status(402).json({ error: "Insufficient letter credits" });
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

        // Calculate delivery time for emails and letters (24 hours from now)
        let deliveryTime = null;
        if (messageType === 'email' || messageType === 'letter') {
            deliveryTime = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
        }

        // Insert the message
        const [result] = await pool.execute(
            'INSERT INTO messages (sender_id, recipient_id, content, message_type, delivery_time) VALUES (?, ?, ?, ?, ?)',
            [req.session.userId, recipientId, content, messageType, deliveryTime]
        );

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
                'UPDATE users SET creditLetters = creditLetters - 1 WHERE id = ?',
                [req.session.userId]
            );
        }

        // Delete the draft after successful send
        await pool.execute(
            'DELETE FROM drafts WHERE sender_id = ? AND recipient_id = ? AND action = ?',
            [req.session.userId, recipientId, messageType]
        );

        res.status(200).json({ 
            message: `${messageType === 'email' ? 'Email' : 'Letter'} sent successfully`,
            messageId: result.insertId
        });
    } catch (error) {
        console.error("Error sending message:", error);
        res.status(500).json({ error: "Failed to send message" });
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
                status: msg.status
            };

            // For emails and letters, check if delivery time has passed
            if ((msg.message_type === 'email' || msg.message_type === 'letter') && msg.delivery_time) {
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
                        
                        if (msg.message_type === 'email') {
                            message.content = `📧 **Email from ${senderName}**\n\nYour email will be delivered in ${hoursLeft} hours! ⏰\n\n💌 *This email is being processed and will arrive soon.*`;
                        } else {
                            message.content = `📬 **Letter from ${senderName}**\n\nYour letter will be shipped in ${hoursLeft} hours! 🚚\n\n💌 *This letter is being prepared and will be shipped soon.*`;
                        }
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
            } else if (msg.message_type === 'letter' && !msg.delivery_time) {
                // Fallback for letters without delivery_time (old messages)
                if (msg.recipient_id === req.session.userId) {
                    // Get sender's name
                    const [senderNameRows] = await pool.execute(
                        'SELECT firstName FROM users WHERE id = ?',
                        [msg.sender_id]
                    );
                    const senderName = senderNameRows[0]?.firstName || 'Someone';
                    message.content = `📬 **Letter from ${senderName}**\n\nYour letter will be shipped soon! 🚚\n\n💌 *This letter is being prepared and will be shipped shortly.*`;
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

        // Filter messages that have been delivered (delivery time has passed)
        const deliveredUnreadMessages = [];
        for (const msg of unreadMessages) {
            // Check if message has been delivered
            if (msg.delivery_time) {
                const deliveryTime = new Date(msg.delivery_time);
                if (now >= deliveryTime) {
                    deliveredUnreadMessages.push(msg);
                }
            } else {
                // For messages without delivery_time, consider them delivered after 24 hours
                const createdTime = new Date(msg.created_at);
                const deliveryTime = new Date(createdTime.getTime() + (24 * 60 * 60 * 1000));
                if (now >= deliveryTime) {
                    deliveredUnreadMessages.push(msg);
                }
            }
        }

        // Count unread messages by type and by sender
        const unreadByType = {
            email: 0,
            letter: 0,
            total: deliveredUnreadMessages.length
        };

        const unreadBySender = {};

        for (const msg of deliveredUnreadMessages) {
            unreadByType[msg.message_type]++;
            
            if (!unreadBySender[msg.sender_id]) {
                unreadBySender[msg.sender_id] = {
                    email: 0,
                    letter: 0,
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

                // For emails and letters, check if delivery time has passed
                if ((msg.message_type === 'email' || msg.message_type === 'letter') && msg.delivery_time) {
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
                            
                            if (msg.message_type === 'email') {
                                message.content = `📧 **Email from ${senderName}**\n\nYour email will be delivered in ${hoursLeft} hours! ⏰\n\n💌 *This email is being processed and will arrive soon.*`;
                            } else {
                                message.content = `📬 **Letter from ${senderName}**\n\nYour letter will be shipped in ${hoursLeft} hours! 🚚\n\n💌 *This letter is being prepared and will be shipped soon.*`;
                            }
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
                } else if (msg.message_type === 'letter' && !msg.delivery_time) {
                    // Fallback for letters without delivery_time (old messages)
                    if (msg.recipient_id === req.session.userId) {
                        // Get sender's name
                        const [senderNameRows] = await pool.execute(
                            'SELECT firstName FROM users WHERE id = ?',
                            [msg.sender_id]
                        );
                        const senderName = senderNameRows[0]?.firstName || 'Someone';
                        message.content = `📬 **Letter from ${senderName}**\n\nYour letter will be shipped soon! 🚚\n\n💌 *This letter is being prepared and will be shipped shortly.*`;
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
            avatar: userRows[0].avatar
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
                        `SELECT id, firstName, bio, avatar FROM users WHERE id NOT IN (${placeholders})`,
                        Array.from(excludedIds)
                    );
                    allPotentialUsers = potentialRows;
                } else {
                    const [potentialRows] = await pool.execute(
                        'SELECT id, firstName, bio, avatar FROM users WHERE id != ?',
                        [req.session.userId]
                    );
                    allPotentialUsers = potentialRows;
                }
                
                // Premium users get 15 profiles, regular users get 5
                const limit = 15; // User is now premium
                let finalProfiles = [];
                
                // Shuffle and take first 15 profiles
                const shuffledProfiles = allPotentialUsers.sort(() => 0.5 - Math.random());
                finalProfiles = shuffledProfiles.slice(0, limit);
                
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
            'UPDATE users SET creditLetters = COALESCE(creditLetters, 0) + ? WHERE id = ?',
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
            'SELECT premium, premiumType, premiumStartDate FROM users WHERE id = ?',
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

        res.status(200).json({
            premium: true,
            type: user.premiumType,
            startDate: user.premiumStartDate,
            endDate: endDate,
            cancelled: user.premiumCancelled || false
        });
    } catch (error) {
        console.error("Error getting subscription details:", error);
        res.status(500).json({ error: "Failed to get subscription details" });
    }
});



// Upgrade subscription
app.post('/api/upgrade-subscription', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { newPlan } = req.body;

    if (!newPlan) {
        return res.status(400).json({ error: "New plan is required" });
    }

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
                        `SELECT id, firstName, bio, avatar FROM users WHERE id NOT IN (${placeholders})`,
                        Array.from(excludedIds)
                    );
                    allPotentialUsers = potentialRows;
                } else {
                    const [potentialRows] = await pool.execute(
                        'SELECT id, firstName, bio, avatar FROM users WHERE id != ?',
                        [req.session.userId]
                    );
                    allPotentialUsers = potentialRows;
                }
                
                // Premium users get 15 profiles, regular users get 5
                const limit = 15; // User is now premium
                let finalProfiles = [];
                
                // Shuffle and take first 15 profiles
                const shuffledProfiles = allPotentialUsers.sort(() => 0.5 - Math.random());
                finalProfiles = shuffledProfiles.slice(0, limit);
                
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

// Cancel subscription
app.post('/api/cancel-subscription', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // Get current subscription details
        const [rows] = await pool.execute(
            'SELECT premiumType, premiumStartDate FROM users WHERE id = ?',
            [req.session.userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = rows[0];
        
        // Calculate when subscription will end
        let endDate = null;
        if (user.premiumStartDate && user.premiumType) {
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

        // Cancel subscription (keep premium active until end date, but mark as cancelled)
        // Don't set premium = false immediately - user keeps access until end date
        await pool.execute(
            'UPDATE users SET premium = false, premiumCancelled = true WHERE id = ?',
            [req.session.userId]
        );

        console.log(`User ${req.session.userId} cancelled subscription`);

        res.status(200).json({ 
            message: "Subscription cancelled successfully",
            endDate: endDate,
            type: user.premiumType
        });
    } catch (error) {
        console.error("Error cancelling subscription:", error);
        res.status(500).json({ error: "Failed to cancel subscription" });
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
});