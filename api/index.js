'use strict';
// Vercel serverless entry point: every request that is not a static file is rewritten here
// (see vercel.json) and handled by the Express app.
module.exports = require('../src/server');
