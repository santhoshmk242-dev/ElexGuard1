'use strict';
/**
 * Secure initial administrator creation.
 *
 *   npm run create-admin                      (interactive – password typed hidden)
 *   ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npm run create-admin     (non-interactive, e.g. CI / Render shell)
 *
 * No default credentials exist anywhere in this project.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { connectDB, disconnectDB } = require('../config/db');
const { User, Administrator } = require('../models');
const v = require('../utils/validators');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = function writeMasked(str) {
        if (str.includes(question)) rl.output.write(str); else if (str.trim() === '') rl.output.write(str); else rl.output.write('*');
      };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

async function main() {
  let email = process.env.ADMIN_EMAIL;
  let name = process.env.ADMIN_NAME;
  let password = process.env.ADMIN_PASSWORD;

  if (!email) email = await ask('Administrator email: ');
  if (!name) name = await ask('Full name: ');
  if (!password) {
    password = await ask('Password (min 8, upper, lower, digit, symbol; typed hidden): ', { hidden: true });
    const again = await ask('Repeat password: ', { hidden: true });
    if (password !== again) throw new Error('Passwords do not match.');
  }

  const parsed = v.auth.register.pick({ email: true, fullName: true, password: true }).safeParse({ email, fullName: name, password });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  if (config.isProd && parsed.data.password.length < 12) throw new Error('In production the administrator password must be at least 12 characters.');

  await connectDB();
  if (await User.findOne({ email: parsed.data.email })) throw new Error(`A user with email ${parsed.data.email} already exists.`);
  const user = await User.create({
    fullName: parsed.data.fullName,
    email: parsed.data.email,
    passwordHash: await bcrypt.hash(parsed.data.password, 12),
    role: 'admin',
    emailVerified: true,
  });
  await Administrator.create({ user: user._id });
  console.log(`\n✔ Administrator created: ${user.email}\n  Log in at /admin/login`);
}

main()
  .catch((e) => { console.error(`\n✖ ${e.message}`); process.exitCode = 1; })
  .finally(() => disconnectDB().catch(() => {}));
