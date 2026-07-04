/**
 * Recurring class series: template table + series_id on classes.
 * Run: npm run db:migrate-recurring
 */
const { pool } = require('../src/db/pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE class_series_status AS ENUM ('active', 'paused', 'deleted');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS class_series (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title                     TEXT NOT NULL,
        description               TEXT,
        discipline                TEXT NOT NULL,
        modality                  modality NOT NULL,
        class_format              class_format NOT NULL DEFAULT 'group',
        level                     class_level,
        language                  TEXT,
        instructor_id             UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
        institution_id            UUID REFERENCES institutions(id) ON DELETE CASCADE,
        duration_minutes          INTEGER NOT NULL CHECK (duration_minutes >= 15),
        price_cents               INTEGER NOT NULL,
        price_currency            VARCHAR(3) NOT NULL DEFAULT 'UYU',
        capacity                  INTEGER CHECK (capacity >= 1),
        cancellation_policy_hours INTEGER NOT NULL DEFAULT 24,
        location_label            TEXT,
        location_lat              DOUBLE PRECISION,
        location_lng              DOUBLE PRECISION,
        weekdays                  SMALLINT[] NOT NULL,
        time_of_day               TIME NOT NULL,
        anchor_start_at           TIMESTAMPTZ NOT NULL,
        status                    class_series_status NOT NULL DEFAULT 'active',
        paused_at                 TIMESTAMPTZ,
        deleted_at                TIMESTAMPTZ,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT class_series_weekdays_nonempty CHECK (cardinality(weekdays) >= 1)
      );
    `);

    await client.query(`
      ALTER TABLE classes
        ADD COLUMN IF NOT EXISTS series_id UUID REFERENCES class_series(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS is_series_exception BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_class_series_status ON class_series(status);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_classes_series_start ON classes(series_id, start_at)
        WHERE cancelled_at IS NULL;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_series_occurrence
        ON classes(series_id, start_at)
        WHERE series_id IS NOT NULL AND cancelled_at IS NULL;
    `);

    await client.query('COMMIT');
    console.log('Recurring classes migration completed.');
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
