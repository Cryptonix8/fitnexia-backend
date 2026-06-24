const { pool } = require('./pool');
const { hashPassword } = require('../utils/password');

const DEFAULT_EMAIL = 'admin@fitnexia.com';
const DEFAULT_PASSWORD = 'admin123';

async function seedDefaultAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL || DEFAULT_EMAIL).trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_PASSWORD;

  if (!password) {
    console.log('Admin seed skipped — SEED_ADMIN_PASSWORD is empty.');
    return { created: false, email };
  }

  const { rows: existing } = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [email],
  );
  if (existing.length) {
    console.log(`Admin seed skipped — user already exists: ${email}`);
    return { created: false, email };
  }

  const { rows: softDeleted } = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND deleted_at IS NOT NULL`,
    [email],
  );

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (softDeleted.length) {
      await client.query(`DELETE FROM users WHERE id = $1`, [softDeleted[0].id]);
    }

    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, role, email_verified)
       VALUES ($1, $2, 'admin', TRUE)
       RETURNING id`,
      [email, passwordHash],
    );

    await client.query(`INSERT INTO notification_preferences (user_id) VALUES ($1)`, [
      userResult.rows[0].id,
    ]);

    await client.query('COMMIT');
    console.log(`Default admin created: ${email}`);
    return { created: true, email };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seedDefaultAdmin };
