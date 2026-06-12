const { pool } = require('../src/db/pool');

async function main() {
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE pass_status AS ENUM ('pending_payment', 'active', 'expired', 'cancelled');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE pass_period AS ENUM ('week', 'month', 'quarter');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS athlete_passes (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      athlete_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payment_model       payment_model NOT NULL,
      period_type         pass_period,
      status              pass_status NOT NULL DEFAULT 'pending_payment',
      price_cents         INTEGER NOT NULL,
      price_currency      VARCHAR(3) NOT NULL DEFAULT 'UYU',
      class_credits_total INTEGER,
      class_credits_used  INTEGER NOT NULL DEFAULT 0,
      starts_at           TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      preference_id       TEXT,
      provider_payment_id TEXT,
      checkout_url        TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT athlete_passes_period_check CHECK (
        (payment_model = 'monthly_unlimited' AND period_type IS NULL)
        OR (payment_model = 'per_period' AND period_type IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_athlete_passes_athlete ON athlete_passes(athlete_user_id);
    CREATE INDEX IF NOT EXISTS idx_athlete_passes_active
      ON athlete_passes(athlete_user_id, status, expires_at);

    ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS athlete_pass_id UUID REFERENCES athlete_passes(id);

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS athlete_pass_id UUID REFERENCES athlete_passes(id) ON DELETE CASCADE;

    ALTER TABLE payments
      ALTER COLUMN booking_id DROP NOT NULL;
  `);

  console.log('Athlete passes migration completed.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
