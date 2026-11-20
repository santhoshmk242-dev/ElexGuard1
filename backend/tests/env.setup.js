'use strict';
// Loaded by Jest before every test file.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/elexguard_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-change-me-0123456789';
process.env.OTP_HASH_SECRET = 'test-only-otp-secret-0123456789';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.SMTP_USER = 'test@example.com';
process.env.SMTP_PASS = 'test-app-password';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
process.env.SKIP_TTL_INDEXES = process.env.SKIP_TTL_INDEXES || 'true'; // FerretDB (used for local test runs) has no TTL indexes; Atlas/MongoDB do
