/**
 * V2 features: advanced search, waitlist, review replies, notification inbox,
 * metrics, club collections, courts/reservations.
 * Run: node scripts/migrate-v2-features.js
 */
const { pool } = require('../src/db/pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE instructor_gender AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      ALTER TABLE instructors
        ADD COLUMN IF NOT EXISTS gender instructor_gender;
    `);

    await client.query(`
      ALTER TABLE reviews
        ADD COLUMN IF NOT EXISTS response TEXT,
        ADD COLUMN IF NOT EXISTS response_at TIMESTAMPTZ;
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE waitlist_status AS ENUM ('waiting', 'spot_offered', 'confirmed', 'expired', 'cancelled');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS waitlist_entries (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        class_id        UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        athlete_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position        INTEGER NOT NULL,
        status          waitlist_status NOT NULL DEFAULT 'waiting',
        offered_at      TIMESTAMPTZ,
        offer_expires_at TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (class_id, athlete_user_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_waitlist_class_status
        ON waitlist_entries(class_id, status, position);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_notifications (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        data        JSONB NOT NULL DEFAULT '{}'::jsonb,
        read        BOOLEAN NOT NULL DEFAULT FALSE,
        read_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_notifications_user
        ON user_notifications(user_id, read, created_at DESC);
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE court_sport_type AS ENUM (
          'football_5', 'football_7', 'football_11', 'padel', 'tennis', 'rugby', 'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE court_surface AS ENUM ('grass', 'synthetic', 'clay', 'hard', 'other');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE court_location_type AS ENUM ('indoor', 'outdoor');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE court_reservation_status AS ENUM (
          'pending_payment', 'confirmed', 'cancelled', 'completed', 'refunded'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS institution_court_settings (
        institution_id              UUID PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
        cancellation_policy_hours   INTEGER NOT NULL DEFAULT 24,
        default_slot_minutes        INTEGER NOT NULL DEFAULT 60,
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS courts (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        sport_type      court_sport_type NOT NULL DEFAULT 'other',
        surface         court_surface NOT NULL DEFAULT 'synthetic',
        location_type   court_location_type NOT NULL DEFAULT 'outdoor',
        has_lighting    BOOLEAN NOT NULL DEFAULT FALSE,
        operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
        active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_courts_institution
        ON courts(institution_id, active);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS court_pricing_rules (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        institution_id        UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        court_id              UUID REFERENCES courts(id) ON DELETE CASCADE,
        label                 TEXT NOT NULL DEFAULT '',
        days_of_week          SMALLINT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
        start_time            TIME NOT NULL DEFAULT '08:00',
        end_time              TIME NOT NULL DEFAULT '22:00',
        is_peak               BOOLEAN NOT NULL DEFAULT FALSE,
        is_weekend            BOOLEAN NOT NULL DEFAULT FALSE,
        member_price_cents    INTEGER NOT NULL CHECK (member_price_cents >= 0),
        non_member_price_cents INTEGER NOT NULL CHECK (non_member_price_cents >= 0),
        price_currency        VARCHAR(3) NOT NULL DEFAULT 'UYU',
        priority              INTEGER NOT NULL DEFAULT 0,
        active                BOOLEAN NOT NULL DEFAULT TRUE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_court_pricing_institution
        ON court_pricing_rules(institution_id, active, priority DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS court_reservations (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        court_id        UUID NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
        institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        athlete_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        club_member_id  UUID REFERENCES club_members(id) ON DELETE SET NULL,
        start_at        TIMESTAMPTZ NOT NULL,
        end_at          TIMESTAMPTZ NOT NULL,
        duration_minutes INTEGER NOT NULL,
        status          court_reservation_status NOT NULL DEFAULT 'pending_payment',
        price_cents     INTEGER NOT NULL,
        price_currency  VARCHAR(3) NOT NULL DEFAULT 'UYU',
        is_member_rate  BOOLEAN NOT NULL DEFAULT FALSE,
        provider_payment_id TEXT,
        cancelled_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (end_at > start_at)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_court_reservations_court_time
        ON court_reservations(court_id, start_at, end_at)
        WHERE status IN ('pending_payment', 'confirmed');
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_court_reservations_user
        ON court_reservations(athlete_user_id, start_at DESC);
    `);

    await client.query('COMMIT');
    console.log('V2 features migration completed.');
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
