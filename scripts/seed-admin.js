const { pool } = require('../src/db/pool');
const { seedDefaultAdmin } = require('../src/db/seed-admin');

seedDefaultAdmin()
  .catch((err) => {
    console.error('Admin seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
