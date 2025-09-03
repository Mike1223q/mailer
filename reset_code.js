// reset_code.js
import nodemailer from 'nodemailer';
import dotenv from "dotenv";
dotenv.config();
// Typically store these in .env
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,      // e.g. "smtp.gmail.com"
  port: process.env.SMTP_PORT || 587,
  secure: false,                    // true for port 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,    // your SMTP username
    pass: process.env.SMTP_PASS     // your SMTP password or app-specific password
  }
});

export default transporter;