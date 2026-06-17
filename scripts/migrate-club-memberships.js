/**
 * Club membership module (F-39–F-44): plans, members, subscriptions, payments, invites.
 * Run: node scripts/migrate-club-memberships.js
 */
const { pool } = require('../src/db/pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE membership_billing_frequency AS ENUM ('monthly', 'quarterly', 'annual');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE membership_plan_type AS ENUM ('individual', 'family');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE club_member_status AS ENUM (
          'invited', 'pending_authorization', 'active', 'pending_payment', 'overdue', 'inactive'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE membership_subscription_status AS ENUM (
          'pending_authorization', 'active', 'past_due', 'cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE membership_payment_status AS ENUM ('pending', 'approved', 'rejected', 'refunded');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE membership_invite_status AS ENUM ('pending', 'accepted', 'expired', 'cancelled');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS membership_plans (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        description     TEXT DEFAULT '',
        price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
        price_currency  VARCHAR(3) NOT NULL DEFAULT 'UYU',
        billing_frequency membership_billing_frequency NOT NULL,
        plan_type       membership_plan_type NOT NULL DEFAULT 'individual',
        max_members     INTEGER,
        active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS institution_membership_settings (
        institution_id      UUID PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
        grace_days          INTEGER NOT NULL DEFAULT 7,
        due_reminder_days   INTEGER NOT NULL DEFAULT 3,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS membership_invites (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        institution_id      UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        plan_id             UUID NOT NULL REFERENCES membership_plans(id) ON DELETE CASCADE,
        code                TEXT NOT NULL UNIQUE,
        email               TEXT,
        invited_name        TEXT,
        invited_phone       TEXT,
        status              membership_invite_status NOT NULL DEFAULT 'pending',
        expires_at          TIMESTAMPTZ,
        accepted_by_user_id UUID REFERENCES users(id),
        accepted_at         TIMESTAMPTZ,
        bulk_batch_id       TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS club_members (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
        plan_id         UUID NOT NULL REFERENCES membership_plans(id),
        status          club_member_status NOT NULL DEFAULT 'invited',
        invite_id       UUID REFERENCES membership_invites(id),
        contact_name    TEXT,
        contact_email   TEXT,
        contact_phone   TEXT,
        joined_at       TIMESTAMPTZ,
        left_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS club_members_active_user_idx
        ON club_members (institution_id, user_id)
        WHERE left_at IS NULL AND user_id IS NOT NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS membership_subscriptions (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        club_member_id      UUID NOT NULL UNIQUE REFERENCES club_members(id) ON DELETE CASCADE,
        institution_id      UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        plan_id             UUID NOT NULL REFERENCES membership_plans(id),
        status              membership_subscription_status NOT NULL DEFAULT 'pending_authorization',
        mp_preapproval_id   TEXT,
        next_billing_at     TIMESTAMPTZ,
        last_billed_at      TIMESTAMPTZ,
        retry_count         INTEGER NOT NULL DEFAULT 0,
        last_failure_at     TIMESTAMPTZ,
        authorization_url   TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS membership_payments (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id     UUID NOT NULL REFERENCES membership_subscriptions(id) ON DELETE CASCADE,
        club_member_id      UUID NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
        institution_id      UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        provider            TEXT NOT NULL DEFAULT 'mercado_pago',
        provider_payment_id TEXT,
        preference_id       TEXT,
        status              membership_payment_status NOT NULL DEFAULT 'pending',
        amount_cents        INTEGER NOT NULL,
        currency            VARCHAR(3) NOT NULL DEFAULT 'UYU',
        period_start        TIMESTAMPTZ,
        period_end          TIMESTAMPTZ,
        is_manual           BOOLEAN NOT NULL DEFAULT FALSE,
        checkout_url        TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_membership_plans_institution
        ON membership_plans (institution_id) WHERE active = TRUE;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_club_members_institution
        ON club_members (institution_id) WHERE left_at IS NULL;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_membership_subscriptions_billing
        ON membership_subscriptions (next_billing_at)
        WHERE status IN ('active', 'past_due');
    `);

    await client.query('COMMIT');
    console.log('Club memberships migration completed.');
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
