const { query, pool } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const courtsService = require('./courts.service');
const notificationsService = require('./notifications.service');

const WEEKDAY_LABELS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function serializeShift(row, extras = {}) {
  return {
    id: row.id,
    courtId: row.court_id,
    institutionId: row.institution_id,
    courtName: row.court_name || extras.courtName,
    institutionName: row.institution_name || extras.institutionName,
    weekday: row.weekday,
    weekdayLabel: WEEKDAY_LABELS[row.weekday],
    startTime: row.start_time?.slice(0, 5),
    durationMinutes: row.duration_minutes,
    label: row.label,
    groupLabel: row.group_label || undefined,
    active: row.active,
    nextOccurrenceAt: row.next_occurrence_at ? row.next_occurrence_at.toISOString() : null,
    lastGeneratedAt: row.last_generated_at ? row.last_generated_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function computeNextOccurrence(weekday, startTime, fromDate = new Date()) {
  const base = new Date(fromDate);
  base.setHours(0, 0, 0, 0);
  const currentWeekday = base.getDay();
  let daysAhead = weekday - currentWeekday;
  if (daysAhead < 0) daysAhead += 7;
  if (daysAhead === 0) {
    const [h, m] = startTime.split(':').map(Number);
    const candidate = new Date(base);
    candidate.setHours(h, m || 0, 0, 0);
    if (candidate <= fromDate) daysAhead = 7;
  }
  const next = new Date(base);
  next.setDate(base.getDate() + daysAhead);
  const [h, m, s] = startTime.split(':').map(Number);
  next.setHours(h, m || 0, s || 0, 0);
  return next;
}

async function createRecurringShift(user, body) {
  if (user.role !== 'athlete') throw forbidden('Only athletes can create fixed shifts');

  const { courtId, weekday, startTime, durationMinutes, label, groupLabel } = body;
  if (!courtId || weekday == null || !startTime || !durationMinutes) {
    throw badRequest('courtId, weekday, startTime, and durationMinutes are required');
  }
  if (weekday < 0 || weekday > 6) throw badRequest('weekday must be 0-6 (Sunday-Saturday)');

  const { rows: courtRows } = await query(
    `SELECT c.*, i.name AS institution_name
     FROM courts c
     JOIN institutions i ON i.id = c.institution_id
     WHERE c.id = $1 AND c.active = TRUE`,
    [courtId],
  );
  if (!courtRows.length) throw notFound('Court not found');
  const court = courtRows[0];

  const nextOccurrence = computeNextOccurrence(Number(weekday), startTime);

  const { rows } = await query(
    `INSERT INTO court_recurring_shifts (
      athlete_user_id, court_id, institution_id, weekday, start_time,
      duration_minutes, label, group_label, next_occurrence_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *`,
    [
      user.id,
      courtId,
      court.institution_id,
      Number(weekday),
      startTime,
      durationMinutes,
      label || `${WEEKDAY_LABELS[Number(weekday)]} ${startTime.slice(0, 5)}`,
      groupLabel || null,
      nextOccurrence.toISOString(),
    ],
  );

  const shift = serializeShift(
    { ...rows[0], court_name: court.name, institution_name: court.institution_name },
  );

  await notificationsService.notifyRecurringShiftCreated({
    userId: user.id,
    shiftId: shift.id,
    courtName: court.name,
    weekdayLabel: shift.weekdayLabel,
    startTime: shift.startTime,
  }).catch(() => {});

  return shift;
}

async function listMyShifts(user) {
  if (user.role !== 'athlete') throw forbidden('Only athletes can list fixed shifts');
  const { rows } = await query(
    `SELECT s.*, c.name AS court_name, i.name AS institution_name
     FROM court_recurring_shifts s
     JOIN courts c ON c.id = s.court_id
     JOIN institutions i ON i.id = s.institution_id
     WHERE s.athlete_user_id = $1
     ORDER BY s.active DESC, s.weekday ASC, s.start_time ASC`,
    [user.id],
  );
  return rows.map((row) => serializeShift(row));
}

async function cancelShift(user, shiftId) {
  if (user.role !== 'athlete') throw forbidden('Only athletes can cancel fixed shifts');
  const { rows } = await query(
    `UPDATE court_recurring_shifts
     SET active = FALSE, updated_at = now()
     WHERE id = $1 AND athlete_user_id = $2
     RETURNING *`,
    [shiftId, user.id],
  );
  if (!rows.length) throw notFound('Fixed shift not found');
  const { rows: courtRows } = await query(
    `SELECT c.name AS court_name, i.name AS institution_name
     FROM courts c JOIN institutions i ON i.id = c.institution_id WHERE c.id = $1`,
    [rows[0].court_id],
  );
  return serializeShift({ ...rows[0], ...courtRows[0] });
}

async function generateReservationForShift(shift, user) {
  const startAt = shift.next_occurrence_at;
  if (!startAt || new Date(startAt) <= new Date()) return null;

  const { rows: existing } = await query(
    `SELECT id FROM court_reservations
     WHERE recurring_shift_id = $1 AND start_at = $2
       AND status IN ('pending_payment', 'confirmed')`,
    [shift.id, startAt],
  );
  if (existing.length) return null;

  const athlete = { id: shift.athlete_user_id, role: 'athlete' };
  try {
    const result = await courtsService.createReservation(athlete, {
      courtId: shift.court_id,
      startAt: new Date(startAt).toISOString(),
      durationMinutes: shift.duration_minutes,
      recurringShiftId: shift.id,
    });
    return result;
  } catch (err) {
    if (err.code === 'SLOT_UNAVAILABLE') {
      await notificationsService.notifyRecurringShiftSkipped({
        userId: shift.athlete_user_id,
        shiftId: shift.id,
        reason: 'slot_unavailable',
      }).catch(() => {});
      return null;
    }
    throw err;
  }
}

async function processDueRecurringShifts() {
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 7);

  const { rows: shifts } = await query(
    `SELECT s.*, c.name AS court_name, i.name AS institution_name
     FROM court_recurring_shifts s
     JOIN courts c ON c.id = s.court_id
     JOIN institutions i ON i.id = s.institution_id
     WHERE s.active = TRUE
       AND s.next_occurrence_at IS NOT NULL
       AND s.next_occurrence_at <= $1`,
    [horizon.toISOString()],
  );

  let generated = 0;
  for (const shift of shifts) {
    const result = await generateReservationForShift(shift, { id: shift.athlete_user_id });
    if (result) {
      generated += 1;
      await notificationsService.notifyRecurringShiftReservation({
        userId: shift.athlete_user_id,
        shiftId: shift.id,
        reservationId: result.reservation?.id || result.id,
        startAt: shift.next_occurrence_at,
        courtName: shift.court_name,
      }).catch(() => {});
    }

    const nextOccurrence = computeNextOccurrence(
      shift.weekday,
      shift.start_time,
      new Date(new Date(shift.next_occurrence_at).getTime() + 24 * 60 * 60 * 1000),
    );

    await query(
      `UPDATE court_recurring_shifts
       SET next_occurrence_at = $2,
           last_generated_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [shift.id, nextOccurrence.toISOString()],
    );
  }

  return { processed: shifts.length, generated };
}

module.exports = {
  createRecurringShift,
  listMyShifts,
  cancelShift,
  processDueRecurringShifts,
  computeNextOccurrence,
};
