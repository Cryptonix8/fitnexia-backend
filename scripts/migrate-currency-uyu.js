const { pool } = require('../src/db/pool');

async function main() {
  const classes = await pool.query(
    "UPDATE classes SET price_currency = 'UYU' WHERE price_currency = 'USD'",
  );
  const bookings = await pool.query(
    "UPDATE bookings SET price_currency = 'UYU' WHERE price_currency = 'USD'",
  );
  console.log(`Updated classes: ${classes.rowCount}, bookings: ${bookings.rowCount}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
