/**
 * Adds notification_deliveries, review_invites pref column for existing databases.
 * Safe to run multiple times.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { pool } = require('../src/db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE notification_preferences
      ADD COLUMN IF NOT EXISTS review_invites BOOLEAN NOT NULL DEFAULT TRUE
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        booking_id  UUID REFERENCES bookings(id) ON DELETE CASCADE,
        invite_id   UUID,
        type        TEXT NOT NULL,
        channel     TEXT NOT NULL DEFAULT 'push' CHECK (channel IN ('push', 'email')),
        dedupe_key  TEXT NOT NULL UNIQUE,
        sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notification_deliveries_user_idx
        ON notification_deliveries (user_id, sent_at DESC)
    `);

    await client.query('COMMIT');
    console.log('Notification migration completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Notification migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
