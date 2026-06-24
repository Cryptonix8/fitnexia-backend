const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const { seedDefaultAdmin } = require('./seed-admin');

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  try {
    await seedDefaultAdmin();
  } catch (err) {
    console.error('Admin seed failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
