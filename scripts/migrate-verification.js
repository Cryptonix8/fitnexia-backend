/**
 * F-03 Profile verification: documents, profile status, reminder tracking.
 * Run: node scripts/migrate-verification-f03.js
 */
const { pool } = require('../src/db/pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE profile_verification_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE verification_document_type AS ENUM ('dni_front', 'dni_back', 'certification');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      ALTER TABLE instructors
        ADD COLUMN IF NOT EXISTS verification_status profile_verification_status NOT NULL DEFAULT 'unverified';
    `);

    await client.query(`
      ALTER TABLE institutions
        ADD COLUMN IF NOT EXISTS verification_status profile_verification_status NOT NULL DEFAULT 'unverified';
    `);

    await client.query(`
      UPDATE instructors SET verification_status = 'verified' WHERE verified = TRUE AND verification_status = 'unverified';
    `);

    await client.query(`
      UPDATE institutions SET verification_status = 'verified' WHERE verified = TRUE AND verification_status = 'unverified';
    `);

    await client.query(`
      ALTER TABLE verification_requests
        ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
        ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS verification_documents (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        verification_request_id UUID NOT NULL REFERENCES verification_requests(id) ON DELETE CASCADE,
        document_type           verification_document_type NOT NULL,
        storage_key             TEXT NOT NULL,
        mime_type               TEXT NOT NULL,
        original_name           TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (verification_request_id, document_type)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verification_requests_pending
        ON verification_requests (submitted_at)
        WHERE status = 'pending';
    `);

    await client.query('COMMIT');
    console.log('F-03 verification migration completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
