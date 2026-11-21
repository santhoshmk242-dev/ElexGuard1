'use strict';

const createApp = require('../app');
const { connectDB, mongoose } = require('../config/db');

let app;

module.exports = async function handler(req, res) {
  if (mongoose.connection.readyState !== 1) {
    await connectDB();
  }

  if (!app) {
    app = createApp();
  }

  return app(req, res);
};
