const { pool } = require('../src/db/pool');

async function main() {
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE mp_connection_status AS ENUM ('disconnected', 'pending', 'connected', 'revoked');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE payment_split_mode AS ENUM ('single_collector', 'marketplace');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE payout_ledger_status AS ENUM ('pending_disbursement', 'disbursed');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    ALTER TABLE instructors
      ADD COLUMN IF NOT EXISTS mp_collector_id TEXT,
      ADD COLUMN IF NOT EXISTS mp_user_id TEXT,
      ADD COLUMN IF NOT EXISTS mp_access_token TEXT,
      ADD COLUMN IF NOT EXISTS mp_refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS mp_token_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS mp_connection_status mp_connection_status NOT NULL DEFAULT 'disconnected',
      ADD COLUMN IF NOT EXISTS mp_connected_at TIMESTAMPTZ;

    ALTER TABLE institutions
      ADD COLUMN IF NOT EXISTS mp_collector_id TEXT,
      ADD COLUMN IF NOT EXISTS mp_user_id TEXT,
      ADD COLUMN IF NOT EXISTS mp_access_token TEXT,
      ADD COLUMN IF NOT EXISTS mp_refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS mp_token_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS mp_connection_status mp_connection_status NOT NULL DEFAULT 'disconnected',
      ADD COLUMN IF NOT EXISTS mp_connected_at TIMESTAMPTZ;

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS seller_collector_id TEXT,
      ADD COLUMN IF NOT EXISTS seller_type TEXT,
      ADD COLUMN IF NOT EXISTS platform_fee_cents INTEGER,
      ADD COLUMN IF NOT EXISTS seller_net_cents INTEGER,
      ADD COLUMN IF NOT EXISTS split_mode payment_split_mode NOT NULL DEFAULT 'single_collector',
      ADD COLUMN IF NOT EXISTS mp_disbursement_status TEXT;

    CREATE TABLE IF NOT EXISTS payout_ledger (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      instructor_id       UUID NOT NULL REFERENCES instructors(id),
      institution_id      UUID REFERENCES institutions(id),
      gross_cents         INTEGER NOT NULL,
      platform_fee_cents  INTEGER NOT NULL,
      net_cents           INTEGER NOT NULL,
      currency            VARCHAR(3) NOT NULL DEFAULT 'UYU',
      source              TEXT NOT NULL DEFAULT 'pass_ledger',
      status              payout_ledger_status NOT NULL DEFAULT 'pending_disbursement',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (booking_id)
    );

    CREATE INDEX IF NOT EXISTS idx_payout_ledger_instructor
      ON payout_ledger(instructor_id, status, created_at DESC);
  `);

  console.log('Mercado Pago marketplace migration completed.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
