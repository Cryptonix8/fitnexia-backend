/**
 * Adds Apple IAP tracking columns for gym / instructor SaaS billing.
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

    for (const table of ['institutions', 'instructors']) {
      await addColumn(client, table, 'apple_original_transaction_id', 'TEXT');
      await addColumn(client, table, 'apple_product_id', 'TEXT');
      await addColumn(client, table, 'apple_environment', 'TEXT');
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS institutions_apple_original_txn_uidx
      ON institutions (apple_original_transaction_id)
      WHERE apple_original_transaction_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS instructors_apple_original_txn_uidx
      ON instructors (apple_original_transaction_id)
      WHERE apple_original_transaction_id IS NOT NULL
    `);

    await client.query('COMMIT');
    console.log('Apple IAP migration complete');
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
