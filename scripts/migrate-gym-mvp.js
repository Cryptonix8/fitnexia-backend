/**
 * Gym MVP: SaaS tiers, club profile fields, job postings.
 * Run: node scripts/migrate-gym-mvp.js
 */
const { pool } = require('../src/db/pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE gym_saas_tier AS ENUM ('basic', 'professional', 'premium', 'enterprise');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE job_posting_status AS ENUM ('draft', 'open', 'closed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE job_application_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      ALTER TABLE institutions
        ADD COLUMN IF NOT EXISTS saas_tier gym_saas_tier NOT NULL DEFAULT 'basic',
        ADD COLUMN IF NOT EXISTS contact_phone TEXT,
        ADD COLUMN IF NOT EXISTS contact_email TEXT,
        ADD COLUMN IF NOT EXISTS website TEXT,
        ADD COLUMN IF NOT EXISTS opening_hours JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS job_postings (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        role_type       TEXT NOT NULL DEFAULT 'instructor',
        description     TEXT NOT NULL DEFAULT '',
        disciplines     TEXT[] NOT NULL DEFAULT '{}',
        status          job_posting_status NOT NULL DEFAULT 'open',
        expires_at      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_job_postings_institution
        ON job_postings(institution_id, status, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS job_applications (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id          UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
        instructor_id   UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
        message         TEXT NOT NULL DEFAULT '',
        status          job_application_status NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (job_id, instructor_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_job_applications_job
        ON job_applications(job_id, status, created_at DESC);
    `);

    await client.query('COMMIT');
    console.log('Gym MVP migration completed.');
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
