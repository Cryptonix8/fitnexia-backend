const { query } = require('../db/pool');
const {
  notifyClassReminder,
  notifyReviewInvite,
} = require('./notifications.service');

const REMINDER_WINDOWS = [
  { hoursBefore: 24, startOffsetMin: 23 * 60 + 55, endOffsetMin: 24 * 60 + 5 },
  { hoursBefore: 1, startOffsetMin: 55, endOffsetMin: 65 },
];

async function processClassReminders() {
  for (const window of REMINDER_WINDOWS) {
    const { rows } = await query(
      `SELECT b.id AS booking_id, b.athlete_user_id, c.id AS class_id, c.title AS class_title, c.start_at
       FROM bookings b
       JOIN classes c ON c.id = b.class_id
       WHERE b.status = 'confirmed'
         AND c.cancelled_at IS NULL
         AND c.start_at BETWEEN now() + ($1 || ' minutes')::interval
                            AND now() + ($2 || ' minutes')::interval`,
      [String(window.startOffsetMin), String(window.endOffsetMin)],
    );

    for (const row of rows) {
      await notifyClassReminder({
        bookingId: row.booking_id,
        athleteUserId: row.athlete_user_id,
        classId: row.class_id,
        classTitle: row.class_title,
        startAt: row.start_at,
        hoursBefore: window.hoursBefore,
      });
    }
  }
}

async function processCompletedBookingsAndReviewInvites() {
  const { rows } = await query(
    `UPDATE bookings b
     SET status = 'completed', completed_at = now()
     FROM classes c
     WHERE b.class_id = c.id
       AND b.status = 'confirmed'
       AND c.start_at + (COALESCE(c.duration_minutes, 60) || ' minutes')::interval < now()
     RETURNING b.id AS booking_id, b.athlete_user_id, b.class_id`,
  );

  for (const row of rows) {
    const { rows: reviews } = await query(`SELECT id FROM reviews WHERE booking_id = $1 LIMIT 1`, [
      row.booking_id,
    ]);
    if (reviews.length) continue;

    const { rows: classes } = await query(`SELECT title FROM classes WHERE id = $1`, [row.class_id]);
    const classTitle = classes[0]?.title || 'tu clase';

    await notifyReviewInvite({
      bookingId: row.booking_id,
      athleteUserId: row.athlete_user_id,
      classId: row.class_id,
      classTitle,
    });
  }
}

async function runScheduledNotifications() {
  await processClassReminders();
  await processCompletedBookingsAndReviewInvites();
  const membershipsService = require('./memberships.service');
  await membershipsService.runMembershipScheduler();
}

function startNotificationScheduler() {
  const cron = require('node-cron');
  cron.schedule('*/5 * * * *', () => {
    runScheduledNotifications().catch((err) => {
      console.warn('[notifications] scheduler error:', err.message);
    });
  });
  console.log('Notification scheduler started (every 5 minutes)');
}

module.exports = {
  runScheduledNotifications,
  startNotificationScheduler,
  processClassReminders,
  processCompletedBookingsAndReviewInvites,
};
