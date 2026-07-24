/**
 * Adds SaaS billing columns for gym tiers and instructor plans (Fitnexia monthly fees).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { pool } = require('../src/db/pool');

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

async function addColumn(client, table, column, ddl) {
  if (await columnExists(client, table, column)) {
    console.log(`skip ${table}.${column}`);
    return;
  }
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`added ${table}.${column}`);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE saas_billing_status AS ENUM (
          'not_required', 'inactive', 'pending', 'active', 'past_due', 'cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    for (const table of ['institutions', 'instructors']) {
      await addColumn(client, table, 'saas_billing_status', `saas_billing_status NOT NULL DEFAULT 'not_required'`);
      await addColumn(client, table, 'saas_mp_preapproval_id', 'TEXT');
      await addColumn(client, table, 'saas_authorization_url', 'TEXT');
      await addColumn(client, table, 'saas_last_billed_at', 'TIMESTAMPTZ');
      await addColumn(client, table, 'saas_next_billing_at', 'TIMESTAMPTZ');
    }

    await addColumn(client, 'institutions', 'saas_pending_tier', 'gym_saas_tier');
    await addColumn(client, 'instructors', 'saas_pending_plan', 'instructor_plan');

    // Existing free-tier rows stay not_required; paid current tiers stay inactive until authorized.
    await client.query(`
      UPDATE institutions i
      SET saas_billing_status = 'not_required'
      WHERE i.saas_tier = 'basic'
    `);

    await client.query(`
      UPDATE instructors
      SET saas_billing_status = 'not_required'
      WHERE plan = 'basic'
    `);

    await client.query('COMMIT');
    console.log('Platform SaaS billing migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
