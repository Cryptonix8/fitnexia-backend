-- Fitnexia MVP schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('athlete', 'instructor', 'institution', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE instructor_plan AS ENUM ('basic', 'pro', 'institutional');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE modality AS ENUM ('in_person', 'online');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE class_format AS ENUM ('individual', 'group');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE class_level AS ENUM ('beginner', 'intermediate', 'advanced');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM (
    'pending_payment', 'confirmed', 'cancelled', 'refunded', 'completed', 'no_show'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_model AS ENUM ('per_class', 'monthly_unlimited', 'per_period');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE link_status AS ENUM ('active', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE verification_subject AS ENUM ('instructor', 'institution');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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

DO $$ BEGIN
  CREATE TYPE gym_saas_tier AS ENUM ('basic', 'professional', 'premium', 'enterprise');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE saas_billing_status AS ENUM (
    'not_required', 'inactive', 'pending', 'active', 'past_due', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE job_posting_status AS ENUM ('draft', 'open', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE job_application_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE verification_document_type AS ENUM ('dni_front', 'dni_back', 'certification');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE profile_verification_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Users & auth ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT UNIQUE NOT NULL,
  password_hash   TEXT,
  role            user_role NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

-- ─── Profiles ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS athlete_profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  photo_url        TEXT,
  favorite_sports  TEXT[] NOT NULL DEFAULT '{}',
  locale           TEXT DEFAULT 'en'
);

CREATE TABLE IF NOT EXISTS instructors (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name          TEXT NOT NULL,
  bio                   TEXT DEFAULT '',
  photo_url             TEXT,
  disciplines           TEXT[] NOT NULL DEFAULT '{}',
  verified              BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status   profile_verification_status NOT NULL DEFAULT 'unverified',
  available_now         BOOLEAN NOT NULL DEFAULT FALSE,
  hourly_rate_cents     INTEGER,
  hourly_rate_currency  VARCHAR(3),
  plan                  instructor_plan NOT NULL DEFAULT 'basic',
  average_rating        NUMERIC(3,2) NOT NULL DEFAULT 0,
  review_count          INTEGER NOT NULL DEFAULT 0,
  saas_billing_status   saas_billing_status NOT NULL DEFAULT 'not_required',
  saas_mp_preapproval_id TEXT,
  saas_authorization_url TEXT,
  saas_last_billed_at   TIMESTAMPTZ,
  saas_next_billing_at  TIMESTAMPTZ,
  saas_pending_plan     instructor_plan,
  mp_collector_id       TEXT,
  mp_user_id            TEXT,
  mp_access_token       TEXT,
  mp_refresh_token      TEXT,
  mp_token_expires_at   TIMESTAMPTZ,
  mp_connection_status  mp_connection_status NOT NULL DEFAULT 'disconnected',
  mp_connected_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS instructor_certifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id  UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  issuer         TEXT NOT NULL,
  year           SMALLINT NOT NULL
);

CREATE TABLE IF NOT EXISTS instructor_schedule (
  instructor_id  UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  weekday        SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  start_time     TIME NOT NULL DEFAULT '09:00',
  end_time       TIME NOT NULL DEFAULT '17:00',
  PRIMARY KEY (instructor_id, weekday)
);

CREATE TABLE IF NOT EXISTS institutions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  logo_url    TEXT,
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status profile_verification_status NOT NULL DEFAULT 'unverified',
  plan        instructor_plan NOT NULL DEFAULT 'institutional',
  saas_tier   gym_saas_tier NOT NULL DEFAULT 'basic',
  saas_billing_status   saas_billing_status NOT NULL DEFAULT 'not_required',
  saas_mp_preapproval_id TEXT,
  saas_authorization_url TEXT,
  saas_last_billed_at   TIMESTAMPTZ,
  saas_next_billing_at  TIMESTAMPTZ,
  saas_pending_tier     gym_saas_tier,
  contact_phone TEXT,
  contact_email TEXT,
  website     TEXT,
  opening_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  address     TEXT,
  city        TEXT,
  country     CHAR(2),
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  mp_collector_id       TEXT,
  mp_user_id            TEXT,
  mp_access_token       TEXT,
  mp_refresh_token      TEXT,
  mp_token_expires_at   TIMESTAMPTZ,
  mp_connection_status  mp_connection_status NOT NULL DEFAULT 'disconnected',
  mp_connected_at       TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS institution_gallery (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  sort_order      SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS institution_instructors (
  institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  instructor_id   UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  status          link_status NOT NULL DEFAULT 'active',
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, instructor_id)
);

CREATE TABLE IF NOT EXISTS institution_instructor_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  email           CITEXT NOT NULL,
  message         TEXT,
  status          invite_status NOT NULL DEFAULT 'pending',
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at     TIMESTAMPTZ
);

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

CREATE INDEX IF NOT EXISTS idx_job_postings_institution
  ON job_postings(institution_id, status, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_job_applications_job
  ON job_applications(job_id, status, created_at DESC);

-- ─── Classes & bookings ─────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE class_series_status AS ENUM ('active', 'paused', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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

CREATE INDEX IF NOT EXISTS idx_class_series_status ON class_series(status);

CREATE TABLE IF NOT EXISTS classes (
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
  start_at                  TIMESTAMPTZ NOT NULL,
  duration_minutes          INTEGER NOT NULL CHECK (duration_minutes >= 15),
  price_cents               INTEGER NOT NULL,
  price_currency            VARCHAR(3) NOT NULL DEFAULT 'UYU',
  capacity                  INTEGER CHECK (capacity >= 1),
  cancellation_policy_hours INTEGER NOT NULL DEFAULT 24,
  location_label            TEXT,
  location_lat              DOUBLE PRECISION,
  location_lng              DOUBLE PRECISION,
  recurrence                JSONB,
  series_id                 UUID REFERENCES class_series(id) ON DELETE SET NULL,
  is_series_exception       BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classes_start_at ON classes(start_at);
CREATE INDEX IF NOT EXISTS idx_classes_discipline ON classes(discipline);
CREATE INDEX IF NOT EXISTS idx_classes_instructor ON classes(instructor_id);
CREATE INDEX IF NOT EXISTS idx_classes_institution ON classes(institution_id);
CREATE INDEX IF NOT EXISTS idx_classes_series_start ON classes(series_id, start_at)
  WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_series_occurrence
  ON classes(series_id, start_at)
  WHERE series_id IS NOT NULL AND cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id        UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  athlete_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          booking_status NOT NULL DEFAULT 'confirmed',
  payment_model   payment_model NOT NULL DEFAULT 'per_class',
  price_cents     INTEGER NOT NULL,
  price_currency  VARCHAR(3) NOT NULL DEFAULT 'UYU',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bookings_athlete ON bookings(athlete_user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_unique
  ON bookings(class_id, athlete_user_id)
  WHERE status IN ('pending_payment', 'confirmed');

-- ─── Athlete passes (monthly / per-period) ───────────────────────────────────

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

-- ─── Payments (Mercado Pago) ──────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'approved', 'rejected', 'refunded', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            UUID REFERENCES bookings(id) ON DELETE CASCADE,
  athlete_pass_id       UUID REFERENCES athlete_passes(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL DEFAULT 'mercado_pago',
  provider_payment_id   TEXT,
  preference_id         TEXT,
  status                payment_status NOT NULL DEFAULT 'pending',
  amount_cents          INTEGER NOT NULL,
  currency              VARCHAR(3) NOT NULL DEFAULT 'UYU',
  checkout_url          TEXT,
  seller_collector_id   TEXT,
  seller_type           TEXT,
  platform_fee_cents    INTEGER,
  seller_net_cents      INTEGER,
  split_mode            payment_split_mode NOT NULL DEFAULT 'single_collector',
  mp_disbursement_status TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);

CREATE TABLE IF NOT EXISTS payout_ledger (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  instructor_id       UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  institution_id      UUID REFERENCES institutions(id) ON DELETE SET NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_payment
  ON payments(provider_payment_id) WHERE provider_payment_id IS NOT NULL;

-- ─── Reviews ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  instructor_id   UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  athlete_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at      TIMESTAMPTZ,
  removed_by      UUID REFERENCES users(id),
  removed_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_instructor_created
  ON reviews(instructor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id          UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS idx_review_reports_review
  ON review_reports(review_id, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  instructor_id   UUID NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  author_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  verified        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, instructor_id)
);

-- ─── Notifications ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  booking_confirmed  BOOLEAN NOT NULL DEFAULT TRUE,
  class_reminders    BOOLEAN NOT NULL DEFAULT TRUE,
  payment_updates    BOOLEAN NOT NULL DEFAULT TRUE,
  credits_expiring   BOOLEAN NOT NULL DEFAULT TRUE,
  review_invites     BOOLEAN NOT NULL DEFAULT TRUE,
  marketing          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS notification_devices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, token)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id  UUID REFERENCES bookings(id) ON DELETE CASCADE,
  invite_id   UUID,
  type        TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'push' CHECK (channel IN ('push', 'email')),
  dedupe_key  TEXT NOT NULL UNIQUE,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_deliveries_user_idx
  ON notification_deliveries (user_id, sent_at DESC);

-- ─── Club memberships (F-39–F-44) ────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE membership_billing_frequency AS ENUM ('monthly', 'quarterly', 'annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_plan_type AS ENUM ('individual', 'family');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE club_member_status AS ENUM (
    'invited', 'pending_authorization', 'active', 'pending_payment', 'overdue', 'inactive'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_subscription_status AS ENUM (
    'pending_authorization', 'active', 'past_due', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_payment_status AS ENUM ('pending', 'approved', 'rejected', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_invite_status AS ENUM ('pending', 'accepted', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

CREATE TABLE IF NOT EXISTS institution_membership_settings (
  institution_id      UUID PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  grace_days          INTEGER NOT NULL DEFAULT 7,
  due_reminder_days   INTEGER NOT NULL DEFAULT 3,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_at         TIMESTAMPTZ,
  bulk_batch_id       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE UNIQUE INDEX IF NOT EXISTS club_members_active_user_idx
  ON club_members (institution_id, user_id)
  WHERE left_at IS NULL AND user_id IS NOT NULL;

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

CREATE INDEX IF NOT EXISTS idx_membership_plans_institution
  ON membership_plans (institution_id) WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_club_members_institution
  ON club_members (institution_id) WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_membership_subscriptions_billing
  ON membership_subscriptions (next_billing_at)
  WHERE status IN ('active', 'past_due');

-- ─── Admin / verification ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS verification_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type    verification_subject NOT NULL,
  instructor_id   UUID REFERENCES instructors(id),
  institution_id  UUID REFERENCES institutions(id),
  status          verification_status NOT NULL DEFAULT 'pending',
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID REFERENCES users(id),
  notes           TEXT,
  rejection_reason TEXT,
  reminder_sent_at TIMESTAMPTZ
);

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

CREATE INDEX IF NOT EXISTS idx_verification_requests_pending
  ON verification_requests (submitted_at)
  WHERE status = 'pending';

-- ─── Rating refresh trigger ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION refresh_instructor_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE instructors SET
    average_rating = COALESCE((
      SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE instructor_id = NEW.instructor_id
    ), 0),
    review_count = (SELECT COUNT(*) FROM reviews WHERE instructor_id = NEW.instructor_id),
    updated_at = now()
  WHERE id = NEW.instructor_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reviews_rating ON reviews;
CREATE TRIGGER trg_reviews_rating
  AFTER INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION refresh_instructor_rating();
