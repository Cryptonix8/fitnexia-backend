/**
 * V3 features: loyalty credits, fixed court shifts, open games.
 * Run: npm run db:migrate-v3
 */
const { pool } = require('../src/db/pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_accounts (
        user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance           INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        last_booking_at   TIMESTAMPTZ,
        expires_at        TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE loyalty_transaction_type AS ENUM ('earn', 'redeem', 'expire', 'adjust');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_credit_transactions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type            loyalty_transaction_type NOT NULL,
        amount          INTEGER NOT NULL,
        balance_after   INTEGER NOT NULL CHECK (balance_after >= 0),
        booking_id      UUID REFERENCES bookings(id) ON DELETE SET NULL,
        note            TEXT NOT NULL DEFAULT '',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user
        ON loyalty_credit_transactions(user_id, created_at DESC);
    `);

    await client.query(`
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS loyalty_redemption BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS court_recurring_shifts (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        athlete_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        court_id          UUID NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
        institution_id    UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        weekday           SMALLINT NOT NULL CHECK (weekday >= 0 AND weekday <= 6),
        start_time        TIME NOT NULL,
        duration_minutes  INTEGER NOT NULL CHECK (duration_minutes > 0),
        label             TEXT NOT NULL DEFAULT '',
        group_label       TEXT,
        active            BOOLEAN NOT NULL DEFAULT TRUE,
        next_occurrence_at TIMESTAMPTZ,
        last_generated_at TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_court_recurring_shifts_active
        ON court_recurring_shifts(active, next_occurrence_at)
        WHERE active = TRUE;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_court_recurring_shifts_user
        ON court_recurring_shifts(athlete_user_id, active);
    `);

    await client.query(`
      ALTER TABLE court_reservations
        ADD COLUMN IF NOT EXISTS recurring_shift_id UUID REFERENCES court_recurring_shifts(id) ON DELETE SET NULL;
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE open_game_status AS ENUM ('open', 'full', 'cancelled', 'completed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE open_game_participant_status AS ENUM ('joined', 'left');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS open_games (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        creator_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sport_type        court_sport_type NOT NULL,
        title             TEXT NOT NULL,
        description       TEXT NOT NULL DEFAULT '',
        start_at          TIMESTAMPTZ NOT NULL,
        duration_minutes  INTEGER NOT NULL DEFAULT 90 CHECK (duration_minutes > 0),
        location_label    TEXT NOT NULL DEFAULT '',
        latitude          DOUBLE PRECISION,
        longitude         DOUBLE PRECISION,
        institution_id    UUID REFERENCES institutions(id) ON DELETE SET NULL,
        court_id          UUID REFERENCES courts(id) ON DELETE SET NULL,
        capacity          INTEGER NOT NULL CHECK (capacity >= 2),
        level             TEXT,
        status            open_game_status NOT NULL DEFAULT 'open',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_open_games_status_start
        ON open_games(status, start_at)
        WHERE status = 'open';
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS open_game_participants (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        game_id     UUID NOT NULL REFERENCES open_games(id) ON DELETE CASCADE,
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status      open_game_participant_status NOT NULL DEFAULT 'joined',
        joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        left_at     TIMESTAMPTZ,
        UNIQUE (game_id, user_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_open_game_participants_game
        ON open_game_participants(game_id, status);
    `);

    await client.query('COMMIT');
    console.log('V3 features migration completed.');
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
