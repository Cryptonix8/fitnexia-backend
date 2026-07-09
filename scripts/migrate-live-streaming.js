/**
 * Live streaming: class stream sessions + LiveKit room metadata.
 * Run: npm run db:migrate-live-streaming
 */
const { pool } = require('../src/db/pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE class_stream_status AS ENUM (
          'scheduled', 'live', 'ended', 'cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS class_streams (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        class_id          UUID NOT NULL UNIQUE REFERENCES classes(id) ON DELETE CASCADE,
        room_name         TEXT NOT NULL UNIQUE,
        status            class_stream_status NOT NULL DEFAULT 'scheduled',
        livekit_room_sid  TEXT,
        started_at        TIMESTAMPTZ,
        ended_at          TIMESTAMPTZ,
        host_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_class_streams_status
        ON class_streams(status, started_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS class_stream_participants (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        stream_id       UUID NOT NULL REFERENCES class_streams(id) ON DELETE CASCADE,
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK (role IN ('host', 'participant')),
        joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        left_at         TIMESTAMPTZ,
        UNIQUE (stream_id, user_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_class_stream_participants_stream
        ON class_stream_participants(stream_id, joined_at DESC);
    `);

    await client.query('COMMIT');
    console.log('Live streaming migration completed.');
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
