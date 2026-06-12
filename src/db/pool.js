const { Pool } = require('pg');
const { databaseUrl } = require('../config/env');

const pool = new Pool({
  connectionString: databaseUrl,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error', err);
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
