import express from "express";
import bodyParser from "body-parser";
import bcrypt from "bcrypt";
import sqlite3 from "sqlite3";
import { OAuth2Client } from 'google-auth-library';
import transporter from "./reset_code.js"; // Import the transporter
import crypto from "crypto";
import session from "express-session";
import cors from "cors";


const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set('view engine', 'ejs');
const client = new OAuth2Client("409368143445-v7ukcrsjh9lc9vj2h1t70ufg1fa4ej1v.apps.googleusercontent.com");
const CLIENT_ID = "409368143445-v7ukcrsjh9lc9vj2h1t70ufg1fa4ej1v.apps.googleusercontent.com";
app.use(session({
    secret: "owlejdpjwejp",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // only true in prod
      httpOnly: true,
      sameSite: "lax"
    }
  }));

  app.use(cors({
    origin: "http://localhost:3000",  // frontend URL
    credentials: true                 // allow cookies to pass
  }));


// Create & connect DB
const db = new sqlite3.Database("./database/users.db", (err) => {
    if (err) console.error("DB connection error:", err);
    else console.log("Connected to SQLite database.");
  });
  
  // Create table if not exists
  db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      firstName TEXT,
      lastName TEXT,
      newsletter BOOLEAN DEFAULT 0,
      email TEXT UNIQUE,
      password TEXT,
      email_verified BOOLEAN DEFAULT 0
  )`);

    // Create table if not exists
    db.run(`CREATE TABLE IF NOT EXISTS codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        code TEXT,
        number_of_tries INTEGER DEFAULT 0,
        wait_until TIMESTAMP DEFAULT (datetime('now','localtime','-1 hour')),
        expires_at TIMESTAMP DEFAULT (datetime('now','localtime','+1 hour'))
    )`);

  // Create table if not exists
  db.run(`CREATE TABLE IF NOT EXISTS reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL
)`);

    // db.run(
    //     `UPDATE codes SET wait_until = datetime('now','localtime','-1 hour') WHERE id = ?`,
    //     [45],
    //     function (err) {
    //       if (err) {
    //         return console.error(err.message);
    //       }
    //       console.log(`Row(s) updated: ${this.changes}`);
    //     }
    //   );

//     db.run(`DELETE FROM codes WHERE id = ?`, [39],
//     function (err) {
//       if (err) {
//         return console.error(err.message);
//       }
//       console.log(`Row(s) deleted: ${this.changes}`);
//     }
//   );

//     db.run(`DELETE FROM users WHERE id = ?`, [4],
//     function (err) {
//       if (err) {
//         return console.error(err.message);
//       }
//       console.log(`Row(s) deleted: ${this.changes}`);
//     }
//   );
      
//   Register route
app.post("/register", async (req, res) => {
    const { email, password, firstName, lastName, newsletter } = req.body;
    // Basic validation
    if (!email || !password || !firstName || !lastName) {
        return res.status(400).send("All fields are required");
    }
    // Check if password is strong enough
    if (password.length < 8) {
        return res.status(406).send("Password must be at least 8 characters long");
    }

    // hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    db.run(
        "INSERT INTO users (email, password, firstName, lastName, newsletter) VALUES (?, ?, ?, ?, ?)",
        [email, hashedPassword, firstName, lastName, newsletter ? 1 : 0],
        function(err) {
        if (err) {
            console.error(err);
            res.status(400).send("User already exists or error occurred");
        } else {
                // Save user info in session
                req.session.userId = this.lastID;
                req.session.email = email;
                req.session.firstName = firstName;
                if (err) {
                    console.error("DB lookup error:", err);
                    return res.status(500).send("Database error");
                }
            res.sendStatus(200);
        }
        }
    );
    });

// Login route
app.post("/login", (req, res) => {
const { email, password } = req.body;
if (!email || !password) {
    return res.status(400).send("Email and password are required");
}
db.get("SELECT * FROM users WHERE email = ?", [email], async (err, row) => {
    if (err) {
    return res.status(500).send("Database error");
    } else if (!row) {
    return res.status(401).send("User not found");
    } else {
    const match = await bcrypt.compare(password, row.password);
    if (match) {
        // Save user info in session
        req.session.userId = row.id;
        req.session.email = row.email;
        req.session.firstName = row.firstName;
        return res.sendStatus(200);
    } else {
        return res.status(401).send("Invalid password");
    }
    }
});
});
  

app.get("/register-page", (req, res) => {
  res.render("register-page");
});

app.get("/login-page", (req, res) => {
    res.render("login-page");
  });
  

app.post("/auth/google", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    const ticket  = await client.verifyIdToken({
      idToken: token,
      audience: CLIENT_ID
    });
    const payload = ticket.getPayload();
    const { email, email_verified, given_name, family_name } = payload;

    // Check if user already exists
    db.get(
      "SELECT id FROM users WHERE email = ?",
      [email],
      (err, row) => {
        if (err) {
          console.error("DB lookup error:", err);
          return res.status(500).json({ error: "Database error" });
        }

        if (row) {
            // User exists
            // Save user info in session
            req.session.userId = row.id;
            req.session.email = email;
            req.session.firstName = given_name || "";
            return res.json({ message: "User already exists", email });
        }

        // Otherwise, create a new user
        db.run(
          `INSERT INTO users
             (email, password, firstName, lastName, newsletter, email_verified)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            email,
            null,                  // no password for Google-only accounts
            given_name || "",
            family_name || "",
            1,                     // default newsletter opt-in
            email_verified ? 1 : 0
          ],
          function (err) {
            if (err) {
              console.error("DB insert error:", err);
              return res.status(500).json({ error: "Database error" });
            }
            // Save user info in session
            req.session.userId = this.lastID;
            req.session.email = email;
            req.session.firstName = given_name || "";
            // this.lastID holds the new user’s id
            res.json({ message: "Google sign-up successful", email });
          }
        );
      }
    );

  } catch (err) {
    console.error("Google auth error:", err);
    return res.status(400).json({ error: "Invalid Google token" });
  }
});

app.get("/forgot", (req, res) => {
  res.render("forgot-password");
}); 

app.post("/forgot-password", (req, res) => {
    const { email } = req.body;
  
    // 1. Verify the user exists
    db.get("SELECT id FROM users WHERE email = ?", [email], (err, userRow) => {
      if (err)   return res.status(500).json({ error: "Database error" });
      if (!userRow) return res.status(404).json({ error: "User not found" });
  
      // 2. Upsert a codes row if missing, with wait_until in the past
      const initSql = `
        INSERT INTO codes (email, code, number_of_tries, wait_until, expires_at)
        VALUES (?, '', 0, datetime('now','localtime','-1 hour'), datetime('now','localtime','+10 minutes'))
        ON CONFLICT(email) DO NOTHING
      `;
      db.run(initSql, [email], (initErr) => {
        if (initErr) return res.status(500).json({ error: "Database error" });
  
        // 3. Now _fetch_ wait_until reliably
        db.get("SELECT wait_until FROM codes WHERE email = ?", [email], (wErr, waitRow) => {
          if (wErr)   return res.status(500).json({ error: "Database error" });
          const now = new Date();
          const waitUntil = new Date(waitRow.wait_until);
  
          // 4. Throttle check
          if (now < waitUntil) {
            return res.status(429).json({ error: "Too many attempts. Try later." });
          }
  
          // 5. Generate code and upsert it, advancing wait_until by e.g. 5 minutes
          const code = Math.floor(100000 + Math.random() * 900000).toString();
          const upsertSql = `
          INSERT INTO codes (email, code, number_of_tries, wait_until, expires_at)
          VALUES (?, ?, 0, datetime('now','localtime'), datetime('now','localtime','+10 minutes'))
          ON CONFLICT(email) DO UPDATE SET
            code = excluded.code,
            wait_until = excluded.wait_until,
            expires_at = excluded.expires_at
        `;        
          db.run(upsertSql, [email, code], (upErr) => {
            if (upErr) return res.status(500).json({ error: "Database error" });
  
            // 6. Send email
            // + Increment the number of tries
            db.run("UPDATE codes SET number_of_tries = number_of_tries + 1 WHERE email = ?", [email], (err) => {
                if (err) {
                    console.error("DB update error:", err);
                    return res.status(500).json({ error: "Database error" });
                }
            });
            // Check if the number of tries exceeds the limit
            db.get("SELECT number_of_tries, wait_until FROM codes WHERE email = ?", [email], (err, row) => {
            if (row.number_of_tries + 1 >= 10) {
                const waitUntil = new Date(row.wait_until);
                if (now < waitUntil) {
                    return res.status(429).json({ error: "Too many attempts. Please try again later." });
                } else {
                    // Reset tries and set wait_until to 1 hour from now
                    db.run(
                        "UPDATE codes SET number_of_tries = 0, wait_until = datetime('now','localtime','+1 hour') WHERE email = ?",
                        [email],
                        (err) => {
                            if (err) {
                                console.error("DB update error:", err);
                                return res.status(500).json({ error: "Database error" });
                            }
                        }
                    );
                }
            }});
            

            transporter.sendMail({
              from: `"My App" <${process.env.SMTP_USER}>`,
              to: email,
              subject: "Your Password Reset Code",
              text: `Your code is ${code}`,
              html: `<p>Your code is <strong>${code}</strong></p>`
            }, (mailErr) => {
              if (mailErr) {
                console.error(mailErr);
                return res.status(500).json({ error: "Failed to send email" });
              }
              // 7. Single success response
              return res.json({ message: "Code sent successfully" });
            });
          });
        });
      });
    });
  });
  

app.post("/forgot-password/verify", (req, res) => {
    console.log("Verification code received:", req.body);
    const { email, code } = req.body;

    db.get("SELECT code, expires_at, number_of_tries, wait_until FROM codes WHERE email = ?", [email], (err, row) => {
        if (err) {
            console.error("DB lookup error:", err);
            return res.status(500).json({ error: "Database error" });
        }
        if (!row) {
            return res.status(404).json({ error: "No code found for this email" });
        }

        const now = new Date();
        const expiresAt = new Date(row.expires_at);
        const waitUntil = new Date(row.wait_until);

        // Check if the number of tries exceeds the limit
        if (now < waitUntil) {
            return res.status(429).json({ error: "Too many attempts. Please try again later." });
        }

        // Check if the code has expired
        if (now > expiresAt) {
            return res.status(400).json({ error: "Verification code has expired" });
        }

        // Check if the code matches
        if (row.code === code) {
            // Reset the number of tries on successful verification
            db.run("UPDATE codes SET number_of_tries = 0 WHERE email = ?", [email], (err) => {
                if (err) {
                    console.error("DB update error:", err);
                    return res.status(500).json({ error: "Database error" });
                }
            });
            const token = crypto.randomBytes(32).toString("hex");
            db.run(
            `INSERT INTO reset_tokens (email, token, expires_at) 
            VALUES (?, ?, datetime('now', 'localtime', '+10 minutes'))`,
            [email, token],
            function (err) {
                if (err) {
                return console.error("DB error:", err.message);
                }
                console.log("Reset token stored for", email);
            }
            );
            return res.status(200).json({ message: "Code verified successfully", token });
        } else {
            // Increment the number of tries
            db.run("UPDATE codes SET number_of_tries = number_of_tries + 1 WHERE email = ?", [email], (err) => {
                if (err) {
                    console.error("DB update error:", err);
                    return res.status(500).json({ error: "Database error" });
                }
            });

            console.log(`Invalid code for ${email}. Incremented tries.`);

            // Check if the number of tries exceeds the limit
            if (row.number_of_tries + 1 >= 11) {
                const waitUntil = new Date(row.wait_until);
                if (now < waitUntil) {
                    return res.status(429).json({ error: "Too many attempts. Please try again later." });
                } else {
                    // Reset tries and set wait_until to 1 hour from now
                    db.run(
                        "UPDATE codes SET number_of_tries = 0, wait_until = datetime('now','localtime','+1 hour') WHERE email = ?",
                        [email],
                        (err) => {
                            if (err) {
                                console.error("DB update error:", err);
                                return res.status(500).json({ error: "Database error" });
                            }
                        }
                    );
                }
            }

            return res.status(406).json({ error: "Invalid verification code" });
        }
    });
});

app.get("/reset-password", (req, res) => {
    const { token } = req.query; // get token from URL

    if (!token) {
        return res.status(404).send("Missing token");
    }

    db.get(
        `SELECT email FROM reset_tokens 
         WHERE token = ? AND expires_at > datetime('now','localtime')`,
        [token],
        (err, row) => {
            if (err) {
                console.error(err.message);
                return res.status(500).send("Database error");
            }

            if (row) {
                // Token is valid, render the reset page
                res.render("reset-password", { token }); // pass token to page
            } else {
                // Invalid or expired token
                res.status(400).send("Invalid or expired token");
            }
        }
    );
});

app.post("/reset-password", async (req, res) => {
    const { token, password } = req.body;

    if (!token || !password) {
        return res.status(400).json({ error: "Missing token or password" });
    }

    // 1. Find token
    db.get(
        `SELECT email FROM reset_tokens 
         WHERE token = ? AND expires_at > datetime('now','localtime')`,
        [token],
        async (err, row) => {
            if (err) {
                console.error(err.message);
                return res.status(500).json({ error: "Database error" });
            }

            if (!row) {
                return res.status(400).json({ error: "Invalid or expired token" });
            }

            const email = row.email;

            // 2. Hash new password
            const hashedPassword = await bcrypt.hash(password, 10);

            // 3. Update user's password
            db.run(
                `UPDATE users SET password = ? WHERE email = ?`,
                [hashedPassword, email],
                (updateErr) => {
                    if (updateErr) {
                        console.error(updateErr.message);
                        return res.status(500).json({ error: "Failed to update password" });
                    }

                    // 4. Delete token
                    db.run(`DELETE FROM reset_tokens WHERE token = ?`, [token], (delErr) => {
                        if (delErr) console.error(delErr.message);
                    });

                    // 5. Success
                    return res.json({ message: "Password reset successful" });
                }
            );
        }
    );
});

function isAuthenticated(req, res, next) {
    if (req.session.userId) return next();
    res.status(401).send('Not logged in');
  }

app.get("/", (req, res) => {
    if (!req.session.userId) {
        return res.render("index", { user: false}); // Example user object
    }
    else {
    return res.render("index", { user:  {"name": req.session.firstName, "email": req.session.email}}); // Example user object
    }
});


const sampleProfiles = [
  { id: 1, name: 'Alex', age: 28, bio: 'Loves hiking and dogs. 🌲🐶', image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?q=80&w=1887&auto=format&fit=crop' },
  { id: 2, name: 'Bella', age: 25, bio: 'Artist and coffee enthusiast. 🎨☕', image: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?q=80&w=1887&auto=format&fit=crop' },
  { id: 3, name: 'Charlie', age: 31, bio: 'Musician looking for a duet partner. 🎸', image: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?q=80&w=1887&auto=format&fit=crop' },
  { id: 4, name: 'Diana', age: 27, bio: 'Traveler and foodie. ✈️🍜', image: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?q=80&w=1961&auto=format&fit=crop' },
  { id: 5, name: 'Ethan', age: 29, bio: 'Just a guy who loves to code. 💻', image: 'https://images.unsplash.com/photo-1568602471122-7832951cc4c5?q=80&w=2070&auto=format&fit=crop' }
];

// API endpoint to get profiles
app.get('/api/profiles', (req, res) => {
  // In a real app, you would fetch users from your database.
  // You'd also add logic to not show users the current user has already seen.
  res.json(sampleProfiles);
});

// API endpoint to handle a swipe action (placeholder)
app.post('/api/swipe', express.json(), (req, res) => {
  const { userId, targetUserId, action } = req.body; // e.g., action: 'like' or 'dislike'

  console.log(`User ${userId} swiped ${action} on ${targetUserId}`);
  
  // **MATCHING LOGIC GOES HERE**
  // 1. Record the swipe in your database.
  // 2. Check if targetUserId has also 'liked' userId.
  // 3. If yes, it's a match! Send back a match notification.
  
  // For now, just send a success response
  if (action === 'like') {
      // Example: check for a match
      // if (hasLikedBack(targetUserId, userId)) {
      //     return res.json({ status: 'success', match: true });
      // }
  }
  
  res.json({ status: 'success', match: false });
});


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});