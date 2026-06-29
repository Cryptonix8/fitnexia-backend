/**
 * Aligns FK constraints so user/instructor/institution removal cascades safely.
 * Run once on existing databases: npm run db:migrate-user-purge
 */
const { pool } = require('../src/db/pool');

const STEPS = [
  {
    name: 'classes.instructor_id → CASCADE',
    sql: `ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_instructor_id_fkey;
          ALTER TABLE classes
            ADD CONSTRAINT classes_instructor_id_fkey
            FOREIGN KEY (instructor_id) REFERENCES instructors(id) ON DELETE CASCADE`,
  },
  {
    name: 'classes.institution_id → CASCADE',
    sql: `ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_institution_id_fkey;
          ALTER TABLE classes
            ADD CONSTRAINT classes_institution_id_fkey
            FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE`,
  },
  {
    name: 'bookings.class_id → CASCADE',
    sql: `ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_class_id_fkey;
          ALTER TABLE bookings
            ADD CONSTRAINT bookings_class_id_fkey
            FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE`,
  },
  {
    name: 'reviews.booking_id → CASCADE',
    sql: `ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_booking_id_fkey;
          ALTER TABLE reviews
            ADD CONSTRAINT reviews_booking_id_fkey
            FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE`,
  },
  {
    name: 'payout_ledger.instructor_id → CASCADE',
    sql: `ALTER TABLE payout_ledger DROP CONSTRAINT IF EXISTS payout_ledger_instructor_id_fkey;
          ALTER TABLE payout_ledger
            ADD CONSTRAINT payout_ledger_instructor_id_fkey
            FOREIGN KEY (instructor_id) REFERENCES instructors(id) ON DELETE CASCADE`,
  },
  {
    name: 'reviews.instructor_id → CASCADE',
    sql: `ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_instructor_id_fkey;
          ALTER TABLE reviews
            ADD CONSTRAINT reviews_instructor_id_fkey
            FOREIGN KEY (instructor_id) REFERENCES instructors(id) ON DELETE CASCADE`,
  },
  {
    name: 'reviews.athlete_user_id → CASCADE',
    sql: `ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_athlete_user_id_fkey;
          ALTER TABLE reviews
            ADD CONSTRAINT reviews_athlete_user_id_fkey
            FOREIGN KEY (athlete_user_id) REFERENCES users(id) ON DELETE CASCADE`,
  },
  {
    name: 'staff_reviews → CASCADE',
    sql: `ALTER TABLE staff_reviews DROP CONSTRAINT IF EXISTS staff_reviews_institution_id_fkey;
          ALTER TABLE staff_reviews DROP CONSTRAINT IF EXISTS staff_reviews_instructor_id_fkey;
          ALTER TABLE staff_reviews DROP CONSTRAINT IF EXISTS staff_reviews_author_user_id_fkey;
          ALTER TABLE staff_reviews
            ADD CONSTRAINT staff_reviews_institution_id_fkey
            FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE;
          ALTER TABLE staff_reviews
            ADD CONSTRAINT staff_reviews_instructor_id_fkey
            FOREIGN KEY (instructor_id) REFERENCES instructors(id) ON DELETE CASCADE;
          ALTER TABLE staff_reviews
            ADD CONSTRAINT staff_reviews_author_user_id_fkey
            FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE`,
  },
  {
    name: 'bookings.athlete_user_id → CASCADE',
    sql: `ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_athlete_user_id_fkey;
          ALTER TABLE bookings
            ADD CONSTRAINT bookings_athlete_user_id_fkey
            FOREIGN KEY (athlete_user_id) REFERENCES users(id) ON DELETE CASCADE`,
  },
  {
    name: 'membership_invites.accepted_by_user_id → SET NULL',
    sql: `ALTER TABLE membership_invites DROP CONSTRAINT IF EXISTS membership_invites_accepted_by_user_id_fkey;
          ALTER TABLE membership_invites
            ADD CONSTRAINT membership_invites_accepted_by_user_id_fkey
            FOREIGN KEY (accepted_by_user_id) REFERENCES users(id) ON DELETE SET NULL`,
  },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const step of STEPS) {
      console.log(`Applying: ${step.name}`);
      await client.query(step.sql);
    }
    await client.query('COMMIT');
    console.log('User-purge FK migration completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
