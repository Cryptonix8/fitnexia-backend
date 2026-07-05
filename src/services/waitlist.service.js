const { query } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const { getBookingCount } = require('../utils/serializers');
const { getClassRow } = require('./classes.service');
const notificationsService = require('./notifications.service');

const OFFER_HOURS = 2;

async function joinWaitlist(user, classId) {
  if (user.role !== 'athlete') {
    throw forbidden('Only athletes can join a waitlist');
  }

  const classRow = await getClassRow(classId);
  const booked = await getBookingCount(classId);
  if (classRow.capacity == null || booked < classRow.capacity) {
    throw badRequest('Class still has available spots');
  }

  const { rows: existingBooking } = await query(
    `SELECT id FROM bookings
     WHERE class_id = $1 AND athlete_user_id = $2 AND status IN ('pending_payment', 'confirmed')`,
    [classId, user.id],
  );
  if (existingBooking.length) {
    throw conflict('BOOKING_EXISTS', 'You already have a booking for this class');
  }

  const { rows: existing } = await query(
    `SELECT id, status FROM waitlist_entries
     WHERE class_id = $1 AND athlete_user_id = $2 AND status IN ('waiting', 'spot_offered')`,
    [classId, user.id],
  );
  if (existing.length) {
    throw conflict('WAITLIST_EXISTS', 'You are already on the waitlist for this class');
  }

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS cnt FROM waitlist_entries
     WHERE class_id = $1 AND status IN ('waiting', 'spot_offered')`,
    [classId],
  );
  const position = countRows[0].cnt + 1;

  const { rows } = await query(
    `INSERT INTO waitlist_entries (class_id, athlete_user_id, position)
     VALUES ($1, $2, $3)
     RETURNING id, position, status, created_at`,
    [classId, user.id, position],
  );

  const entry = rows[0];
  return {
    id: entry.id,
    classId,
    position: entry.position,
    status: entry.status,
    createdAt: entry.created_at.toISOString(),
  };
}

async function listMyWaitlist(user) {
  const { rows } = await query(
    `SELECT w.*, c.title AS class_title, c.start_at
     FROM waitlist_entries w
     JOIN classes c ON c.id = w.class_id
     WHERE w.athlete_user_id = $1 AND w.status IN ('waiting', 'spot_offered')
     ORDER BY c.start_at ASC`,
    [user.id],
  );

  return rows.map((r) => ({
    id: r.id,
    classId: r.class_id,
    classTitle: r.class_title,
    classStartAt: r.start_at.toISOString(),
    position: r.position,
    status: r.status,
    offerExpiresAt: r.offer_expires_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  }));
}

async function confirmWaitlistSpot(user, waitlistId) {
  const { rows } = await query(`SELECT * FROM waitlist_entries WHERE id = $1`, [waitlistId]);
  if (!rows.length) throw notFound('Waitlist entry not found');
  const entry = rows[0];

  if (entry.athlete_user_id !== user.id) {
    throw forbidden('Not your waitlist entry');
  }
  if (entry.status !== 'spot_offered') {
    throw badRequest('No spot offer to confirm');
  }
  if (entry.offer_expires_at && new Date(entry.offer_expires_at) < new Date()) {
    await query(
      `UPDATE waitlist_entries SET status = 'expired', updated_at = now() WHERE id = $1`,
      [waitlistId],
    );
    throw badRequest('Spot offer has expired');
  }

  const booked = await getBookingCount(entry.class_id);
  const classRow = await getClassRow(entry.class_id);
  if (classRow.capacity != null && booked >= classRow.capacity) {
    throw conflict('CLASS_FULL', 'Spot is no longer available');
  }

  const bookingsService = require('./bookings.service');
  const booking = await bookingsService.createBooking(user, {
    classId: entry.class_id,
    paymentModel: 'per_class',
  });

  await query(
    `UPDATE waitlist_entries SET status = 'confirmed', updated_at = now() WHERE id = $1`,
    [waitlistId],
  );

  return booking;
}

async function cancelWaitlistEntry(user, waitlistId) {
  const { rows } = await query(`SELECT * FROM waitlist_entries WHERE id = $1`, [waitlistId]);
  if (!rows.length) throw notFound('Waitlist entry not found');
  const entry = rows[0];

  if (entry.athlete_user_id !== user.id) {
    throw forbidden('Not your waitlist entry');
  }
  if (!['waiting', 'spot_offered'].includes(entry.status)) {
    throw badRequest('Waitlist entry cannot be cancelled');
  }

  await query(
    `UPDATE waitlist_entries SET status = 'cancelled', updated_at = now() WHERE id = $1`,
    [waitlistId],
  );

  await reorderWaitlist(entry.class_id);
  return { ok: true };
}

async function reorderWaitlist(classId) {
  const { rows } = await query(
    `SELECT id FROM waitlist_entries
     WHERE class_id = $1 AND status = 'waiting'
     ORDER BY position ASC, created_at ASC`,
    [classId],
  );
  for (let i = 0; i < rows.length; i++) {
    await query(`UPDATE waitlist_entries SET position = $1, updated_at = now() WHERE id = $2`, [
      i + 1,
      rows[i].id,
    ]);
  }
}

async function promoteNextOnCancellation(classId) {
  const { rows } = await query(
    `SELECT * FROM waitlist_entries
     WHERE class_id = $1 AND status = 'waiting'
     ORDER BY position ASC, created_at ASC
     LIMIT 1`,
    [classId],
  );
  if (!rows.length) return null;

  const entry = rows[0];
  const offerExpiresAt = new Date(Date.now() + OFFER_HOURS * 60 * 60 * 1000);

  await query(
    `UPDATE waitlist_entries
     SET status = 'spot_offered', offered_at = now(), offer_expires_at = $2, updated_at = now()
     WHERE id = $1`,
    [entry.id, offerExpiresAt],
  );

  const classRow = await getClassRow(classId);
  await notificationsService.dispatchPush({
    userId: entry.athlete_user_id,
    type: 'waitlist_spot',
    title: '¡Hay un lugar disponible!',
    body: `Se liberó un cupo en "${classRow.title}". Confirmá en las próximas ${OFFER_HOURS} horas.`,
    data: { screen: `/class/${classId}`, waitlistId: entry.id },
    bookingId: null,
  });

  return entry.id;
}

module.exports = {
  joinWaitlist,
  listMyWaitlist,
  confirmWaitlistSpot,
  cancelWaitlistEntry,
  promoteNextOnCancellation,
  OFFER_HOURS,
};
