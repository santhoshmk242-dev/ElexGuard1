
'use strict';

const nodemailer = require('nodemailer');
const config = require('../../config/env');
const AppError = require('../../utils/AppError');

let transporter = null;

function isConfigured() {
  return Boolean(config.smtp.user && config.smtp.pass);
}

function getTransporter() {
  if (!isConfigured()) {
    throw new AppError(
      'Email delivery is not configured on the server.',
      503,
      'EMAIL_NOT_CONFIGURED'
    );
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }

  return transporter;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function layout(title, bodyHtml) {
  return `<!doctype html>
  <html>
  <body style="margin:0;background:#F5F7FA;font-family:Arial,sans-serif;color:#1F2937">
    <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px">
      <div style="background:#142B4F;color:#fff;padding:18px 24px;font-size:20px;font-weight:700">ElexGuard</div>
      <div style="padding:24px">
        <h2 style="color:#142B4F">${escapeHtml(title)}</h2>
        ${bodyHtml}
      </div>
      <div style="padding:14px 24px;background:#F5F7FA;color:#64748B;font-size:12px">
        Educational prototype — not for real elections.
      </div>
    </div>
  </body>
  </html>`;
}

async function send(to, subject, html, text) {
  const t = getTransporter();

  try {
    await t.sendMail({
      from: config.smtp.from || `ElexGuard <${config.smtp.user}>`,
      to,
      subject,
      html,
      text,
    });
  } catch (err) {
    console.error(
      `[email] delivery failed (${err.code || 'unknown'}):`,
      err.message
    );

    throw new AppError(
      'We could not deliver the email. Please check the email settings.',
      502,
      'EMAIL_DELIVERY_FAILED'
    );
  }
}

async function sendOtpEmail(to, name, otp) {
  // Local development demo: show OTP in backend terminal instead of email.
  if (config.otp.consoleOtp) {
    console.log('\n========================================');
    console.log('[ElexGuard DEMO] VOTER VERIFICATION OTP');
    console.log('Email:', to);
    console.log('OTP:', otp);
    console.log('This code expires in', config.otp.ttlMinutes, 'minutes.');
    console.log('========================================\n');
    return;
  }

  const minutes = config.otp.ttlMinutes;

  const html = layout(
    'Verify your email address',
    `
      <p>Hello ${escapeHtml(name)},</p>
      <p>Your ElexGuard verification code is:</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#2563EB">
        ${escapeHtml(otp)}
      </p>
      <p>This code expires in ${minutes} minutes and can only be used once.</p>
    `
  );

  const text = `Your ElexGuard verification code is ${otp}. It expires in ${minutes} minutes.`;

  await send(to, 'Your ElexGuard verification code', html, text);
}

async function sendPasswordResetEmail(to, name, link) {
  const html = layout(
    'Reset your password',
    `
      <p>Hello ${escapeHtml(name)},</p>
      <p>Use this link to reset your ElexGuard password:</p>
      <p><a href="${escapeHtml(link)}">Reset Password</a></p>
      <p>This link expires in 30 minutes.</p>
    `
  );

  const text = `Reset your ElexGuard password: ${link}`;

  await send(to, 'Your ElexGuard password reset', html, text);
}

module.exports = {
  sendOtpEmail,
  sendPasswordResetEmail,
  isConfigured,
};
