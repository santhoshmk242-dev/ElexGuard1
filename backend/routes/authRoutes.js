'use strict';
const router = require('express').Router();
const c = require('../controllers/authController');
const v = require('../utils/validators');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/security');

router.post('/register', authLimiter, validate(v.auth.register), c.register);
router.post('/verify-otp', otpLimiter, validate(v.auth.verifyOtp), c.verifyOtp);
router.post('/resend-otp', otpLimiter, validate(v.auth.resendOtp), c.resendOtp);
router.post('/login', authLimiter, validate(v.auth.login), c.login);
router.post('/admin/login', authLimiter, validate(v.auth.login), c.adminLogin);
router.post('/forgot-password', authLimiter, validate(v.auth.forgot), c.forgotPassword);
router.post('/reset-password', authLimiter, validate(v.auth.reset), c.resetPassword);

router.get('/me', authenticate, c.me);
router.put('/me', authenticate, validate(v.auth.profile), c.updateProfile);
router.put('/change-password', authenticate, validate(v.auth.changePassword), c.changePassword);
router.post('/logout', authenticate, c.logout);

module.exports = router;
