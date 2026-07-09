const { query, pool } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const { getInstitutionByUserId } = require('./institutions.service');
const notificationsService = require('./notifications.service');
const emailService = require('./email.service');
const paymentsService = require('./payments.service');
const marketplaceService = require('./marketplace.service');

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function serializeCourt(row) {
  return {
    id: row.id,
    institutionId: row.institution_id,
    name: row.name,
    sportType: row.sport_type,
    surface: row.surface,
    locationType: row.location_type,
    hasLighting: row.has_lighting,
    operatingHours: row.operating_hours || {},
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

function serializePricingRule(row) {
  return {
    id: row.id,
    institutionId: row.institution_id,
    courtId: row.court_id || undefined,
    label: row.label,
    daysOfWeek: row.days_of_week,
    startTime: row.start_time?.slice(0, 5),
    endTime: row.end_time?.slice(0, 5),
    isPeak: row.is_peak,
    isWeekend: row.is_weekend,
    memberPrice: { amount: row.member_price_cents, currency: row.price_currency },
    nonMemberPrice: { amount: row.non_member_price_cents, currency: row.price_currency },
    priority: row.priority,
    active: row.active,
  };
}

function serializeReservation(row, extras = {}) {
  return {
    id: row.id,
    courtId: row.court_id,
    institutionId: row.institution_id,
    courtName: row.court_name,
    institutionName: row.institution_name,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    durationMinutes: row.duration_minutes,
    status: row.status,
    price: { amount: row.price_cents, currency: row.price_currency },
    isMemberRate: row.is_member_rate,
    createdAt: row.created_at.toISOString(),
    cancellationPolicyHours: extras.cancellationPolicyHours,
    canCancel: extras.canCancel,
    refundEligible: extras.refundEligible,
  };
}

async function getInstitutionCourtSettings(institutionId) {
  const { rows } = await query(
    `SELECT cancellation_policy_hours, default_slot_minutes FROM institution_court_settings WHERE institution_id = $1`,
    [institutionId],
  );
  return {
    cancellationPolicyHours: rows[0]?.cancellation_policy_hours ?? 24,
    defaultSlotMinutes: rows[0]?.default_slot_minutes ?? 60,
  };
}

async function getCourtSettings(userId) {
  const institution = await getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT * FROM institution_court_settings WHERE institution_id = $1`,
    [institution.id],
  );
  if (!rows.length) {
    return {
      cancellationPolicyHours: 24,
      defaultSlotMinutes: 60,
    };
  }
  const s = rows[0];
  return {
    cancellationPolicyHours: s.cancellation_policy_hours,
    defaultSlotMinutes: s.default_slot_minutes,
  };
}

async function updateCourtSettings(userId, body) {
  const institution = await getInstitutionByUserId(userId);
  const hours = body.cancellationPolicyHours ?? 24;
  const slotMinutes = body.defaultSlotMinutes ?? 60;

  await query(
    `INSERT INTO institution_court_settings (institution_id, cancellation_policy_hours, default_slot_minutes)
     VALUES ($1, $2, $3)
     ON CONFLICT (institution_id) DO UPDATE SET
       cancellation_policy_hours = EXCLUDED.cancellation_policy_hours,
       default_slot_minutes = EXCLUDED.default_slot_minutes,
       updated_at = now()`,
    [institution.id, hours, slotMinutes],
  );

  return getCourtSettings(userId);
}

async function listCourts(userId) {
  const institution = await getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT * FROM courts WHERE institution_id = $1 ORDER BY name ASC`,
    [institution.id],
  );
  return rows.map(serializeCourt);
}

async function listCourtsPublic(institutionId) {
  const { rows } = await query(
    `SELECT * FROM courts WHERE institution_id = $1 AND active = TRUE ORDER BY name ASC`,
    [institutionId],
  );
  return rows.map(serializeCourt);
}

async function createCourt(userId, body) {
  const institution = await getInstitutionByUserId(userId);
  if (!body.name?.trim()) throw badRequest('name is required');

  const { rows } = await query(
    `INSERT INTO courts (
      institution_id, name, sport_type, surface, location_type, has_lighting, operating_hours
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *`,
    [
      institution.id,
      body.name.trim(),
      body.sportType || 'other',
      body.surface || 'synthetic',
      body.locationType || 'outdoor',
      body.hasLighting === true,
      JSON.stringify(body.operatingHours || {}),
    ],
  );
  return serializeCourt(rows[0]);
}

async function updateCourt(userId, courtId, body) {
  const institution = await getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT * FROM courts WHERE id = $1 AND institution_id = $2`,
    [courtId, institution.id],
  );
  if (!rows.length) throw notFound('Court not found');

  const { rows: updated } = await query(
    `UPDATE courts SET
      name = COALESCE($3, name),
      sport_type = COALESCE($4, sport_type),
      surface = COALESCE($5, surface),
      location_type = COALESCE($6, location_type),
      has_lighting = COALESCE($7, has_lighting),
      operating_hours = COALESCE($8, operating_hours),
      active = COALESCE($9, active),
      updated_at = now()
     WHERE id = $1 AND institution_id = $2
     RETURNING *`,
    [
      courtId,
      institution.id,
      body.name?.trim(),
      body.sportType,
      body.surface,
      body.locationType,
      body.hasLighting,
      body.operatingHours ? JSON.stringify(body.operatingHours) : null,
      body.active,
    ],
  );
  return serializeCourt(updated[0]);
}

async function deleteCourt(userId, courtId) {
  const institution = await getInstitutionByUserId(userId);
  const { rowCount } = await query(
    `UPDATE courts SET active = FALSE, updated_at = now()
     WHERE id = $1 AND institution_id = $2`,
    [courtId, institution.id],
  );
  if (!rowCount) throw notFound('Court not found');
  return { ok: true };
}

async function listPricingRules(userId) {
  const institution = await getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT * FROM court_pricing_rules
     WHERE institution_id = $1 AND active = TRUE
     ORDER BY priority DESC, created_at ASC`,
    [institution.id],
  );
  return rows.map(serializePricingRule);
}

async function createPricingRule(userId, body) {
  const institution = await getInstitutionByUserId(userId);
  if (body.memberPrice?.amount == null || body.nonMemberPrice?.amount == null) {
    throw badRequest('memberPrice and nonMemberPrice are required');
  }

  const { rows } = await query(
    `INSERT INTO court_pricing_rules (
      institution_id, court_id, label, days_of_week, start_time, end_time,
      is_peak, is_weekend, member_price_cents, non_member_price_cents, price_currency, priority
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *`,
    [
      institution.id,
      body.courtId || null,
      body.label || '',
      body.daysOfWeek || [0, 1, 2, 3, 4, 5, 6],
      body.startTime || '08:00',
      body.endTime || '22:00',
      body.isPeak === true,
      body.isWeekend === true,
      body.memberPrice.amount,
      body.nonMemberPrice.amount,
      body.memberPrice.currency || 'UYU',
      body.priority || 0,
    ],
  );
  return serializePricingRule(rows[0]);
}

async function deletePricingRule(userId, ruleId) {
  const institution = await getInstitutionByUserId(userId);
  const { rowCount } = await query(
    `UPDATE court_pricing_rules SET active = FALSE, updated_at = now()
     WHERE id = $1 AND institution_id = $2`,
    [ruleId, institution.id],
  );
  if (!rowCount) throw notFound('Pricing rule not found');
  return { ok: true };
}

async function isActiveMember(userId, institutionId) {
  const { rows } = await query(
    `SELECT id FROM club_members
     WHERE user_id = $1 AND institution_id = $2 AND status = 'active' AND left_at IS NULL
     LIMIT 1`,
    [userId, institutionId],
  );
  return rows.length ? rows[0].id : null;
}

function resolvePrice(rules, { courtId, startAt, isMember }) {
  const date = new Date(startAt);
  const dayOfWeek = date.getDay();
  const timeStr = date.toTimeString().slice(0, 5);
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const matching = rules
    .filter((r) => {
      if (r.court_id && r.court_id !== courtId) return false;
      if (!r.days_of_week.includes(dayOfWeek)) return false;
      if (r.is_weekend && !isWeekend) return false;
      const start = r.start_time?.slice(0, 5);
      const end = r.end_time?.slice(0, 5);
      return timeStr >= start && timeStr < end;
    })
    .sort((a, b) => b.priority - a.priority);

  const rule = matching[0];
  if (!rule) return null;

  const cents = isMember ? rule.member_price_cents : rule.non_member_price_cents;
  return {
    amount: cents,
    currency: rule.price_currency,
    isMemberRate: isMember,
  };
}

async function getSchedule(institutionId, { courtId, date }) {
  if (!date) throw badRequest('date is required');
  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59`);

  let courts;
  if (courtId) {
    const { rows } = await query(
      `SELECT * FROM courts WHERE id = $1 AND institution_id = $2 AND active = TRUE`,
      [courtId, institutionId],
    );
    courts = rows;
  } else {
    const { rows } = await query(
      `SELECT * FROM courts WHERE institution_id = $1 AND active = TRUE ORDER BY name`,
      [institutionId],
    );
    courts = rows;
  }

  const { rows: settingsRows } = await query(
    `SELECT default_slot_minutes FROM institution_court_settings WHERE institution_id = $1`,
    [institutionId],
  );
  const slotMinutes = settingsRows[0]?.default_slot_minutes || 60;

  const weekday = dayStart.getDay();
  const weekdayKey = WEEKDAY_KEYS[weekday];

  const result = [];
  for (const court of courts) {
    const hours = court.operating_hours?.[weekdayKey];
    if (!hours || hours.closed) continue;

    const openTime = hours.open || '08:00';
    const closeTime = hours.close || '22:00';

    const { rows: reservations } = await query(
      `SELECT start_at, end_at FROM court_reservations
       WHERE court_id = $1 AND status IN ('pending_payment', 'confirmed')
         AND start_at >= $2 AND start_at <= $3`,
      [court.id, dayStart.toISOString(), dayEnd.toISOString()],
    );

    const slots = [];
    let cursor = new Date(`${date}T${openTime}:00`);
    const endLimit = new Date(`${date}T${closeTime}:00`);

    while (cursor < endLimit) {
      const slotEnd = new Date(cursor.getTime() + slotMinutes * 60 * 1000);
      if (slotEnd > endLimit) break;

      const occupied = reservations.some((r) => {
        const rs = new Date(r.start_at);
        const re = new Date(r.end_at);
        return cursor < re && slotEnd > rs;
      });

      slots.push({
        startAt: cursor.toISOString(),
        endAt: slotEnd.toISOString(),
        available: !occupied,
      });

      cursor = slotEnd;
    }

    result.push({
      court: serializeCourt(court),
      date,
      slotMinutes,
      slots,
    });
  }

  return result;
}

function reservationCancelMeta(reservation, policyHours) {
  const hoursUntil = (new Date(reservation.start_at).getTime() - Date.now()) / (1000 * 60 * 60);
  const cancellable = ['pending_payment', 'confirmed'].includes(reservation.status);
  const withinPolicy = hoursUntil >= policyHours;
  return {
    canCancel: cancellable && withinPolicy,
    refundEligible: reservation.status === 'confirmed' && withinPolicy,
    cancellationPolicyHours: policyHours,
  };
}

function quoteTotalPrice(ruleRows, { courtId, startAt, durationMinutes, isMember, slotMinutes }) {
  let totalCents = 0;
  let currency = 'UYU';
  let isMemberRate = isMember;
  let cursor = new Date(startAt);
  const end = new Date(cursor.getTime() + durationMinutes * 60 * 1000);

  while (cursor < end) {
    const segmentEnd = new Date(Math.min(cursor.getTime() + slotMinutes * 60 * 1000, end.getTime()));
    const segmentMinutes = Math.round((segmentEnd.getTime() - cursor.getTime()) / 60000);
    const price = resolvePrice(ruleRows, {
      courtId,
      startAt: cursor.toISOString(),
      isMember,
    });
    if (!price) return null;
    const fraction = segmentMinutes / slotMinutes;
    totalCents += Math.round(price.amount * fraction);
    currency = price.currency;
    isMemberRate = price.isMemberRate;
    cursor = segmentEnd;
  }

  return { amount: totalCents, currency, isMemberRate };
}

async function createReservation(user, body) {
  if (user.role !== 'athlete') {
    throw forbidden('Only athletes can book courts');
  }

  const { courtId, startAt, durationMinutes, recurringShiftId } = body;
  if (!courtId || !startAt || !durationMinutes) {
    throw badRequest('courtId, startAt, and durationMinutes are required');
  }

  const { rows: courtRows } = await query(
    `SELECT c.*, i.name AS institution_name, i.user_id AS institution_user_id
     FROM courts c
     JOIN institutions i ON i.id = c.institution_id
     WHERE c.id = $1 AND c.active = TRUE`,
    [courtId],
  );
  if (!courtRows.length) throw notFound('Court not found');
  const court = courtRows[0];

  const start = new Date(startAt);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  if (start <= new Date()) throw badRequest('Reservation must be in the future');

  const { rows: conflicts } = await query(
    `SELECT id FROM court_reservations
     WHERE court_id = $1 AND status IN ('pending_payment', 'confirmed')
       AND start_at < $3 AND end_at > $2`,
    [courtId, start.toISOString(), end.toISOString()],
  );
  if (conflicts.length) {
    throw conflict('SLOT_UNAVAILABLE', 'This time slot is not available');
  }

  const memberId = await isActiveMember(user.id, court.institution_id);
  const isMember = Boolean(memberId);

  const { rows: ruleRows } = await query(
    `SELECT * FROM court_pricing_rules
     WHERE institution_id = $1 AND active = TRUE`,
    [court.institution_id],
  );

  const { rows: settingsRows } = await query(
    `SELECT default_slot_minutes FROM institution_court_settings WHERE institution_id = $1`,
    [court.institution_id],
  );
  const slotMinutes = settingsRows[0]?.default_slot_minutes || 60;

  const price = quoteTotalPrice(ruleRows, {
    courtId,
    startAt: start.toISOString(),
    durationMinutes,
    isMember,
    slotMinutes,
  });
  if (!price) {
    throw badRequest('No pricing rule applies to this time slot');
  }

  const usePayments = paymentsService.isPaymentsActive();
  if (usePayments) {
    const { rows: institutionRows } = await query(`SELECT * FROM institutions WHERE id = $1`, [
      court.institution_id,
    ]);
    await marketplaceService.resolveInstitutionCheckoutSplit(institutionRows[0], price.amount);
  }

  const initialStatus = usePayments ? 'pending_payment' : 'confirmed';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO court_reservations (
        court_id, institution_id, athlete_user_id, club_member_id,
        start_at, end_at, duration_minutes, status, price_cents, price_currency, is_member_rate,
        recurring_shift_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        courtId,
        court.institution_id,
        user.id,
        memberId,
        start.toISOString(),
        end.toISOString(),
        durationMinutes,
        initialStatus,
        price.amount,
        price.currency,
        price.isMemberRate,
        recurringShiftId || null,
      ],
    );

    const reservation = rows[0];
    let checkoutUrl;

    if (usePayments) {
      const { rows: institutionRows } = await client.query(`SELECT * FROM institutions WHERE id = $1`, [
        court.institution_id,
      ]);
      const payment = await paymentsService.createPaymentForCourtReservation(
        client,
        reservation,
        court,
        institutionRows[0],
      );
      checkoutUrl = payment.checkout_url;
    } else {
      await sendReservationNotifications(user, court, reservation);
    }

    await client.query('COMMIT');

    const full = await getReservationById(reservation.id);
    return {
      reservation: full,
      checkoutUrl,
      paymentRequired: usePayments,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function sendReservationNotifications(user, court, reservation) {
  await notificationsService.dispatchPush({
    userId: user.id,
    type: 'court_reservation_confirmed',
    title: 'Reserva de cancha confirmada',
    body: `${court.name} — ${new Date(reservation.start_at).toLocaleString('es-UY')}`,
    data: { screen: '/(athlete)/courts/reservations', reservationId: reservation.id },
  });

  if (user.email) {
    try {
      await emailService.sendMail({
        to: user.email,
        subject: 'Reserva de cancha confirmada — Fitnexia',
        text: `Tu reserva en ${court.name} fue confirmada para ${new Date(reservation.start_at).toLocaleString('es-UY')}.`,
      });
    } catch {
      /* email optional */
    }
  }
}

async function notifyReservationConfirmed(reservationId) {
  const { rows } = await query(
    `SELECT r.*, c.name AS court_name, u.email
     FROM court_reservations r
     JOIN courts c ON c.id = r.court_id
     JOIN users u ON u.id = r.athlete_user_id
     WHERE r.id = $1`,
    [reservationId],
  );
  if (!rows.length) return;
  const row = rows[0];
  await sendReservationNotifications(
    { id: row.athlete_user_id, email: row.email },
    { name: row.court_name },
    row,
  );
}

async function getReservationById(id) {
  const { rows } = await query(
    `SELECT r.*, c.name AS court_name, i.name AS institution_name
     FROM court_reservations r
     JOIN courts c ON c.id = r.court_id
     JOIN institutions i ON i.id = r.institution_id
     WHERE r.id = $1`,
    [id],
  );
  if (!rows.length) throw notFound('Reservation not found');
  const settings = await getInstitutionCourtSettings(rows[0].institution_id);
  const meta = reservationCancelMeta(rows[0], settings.cancellationPolicyHours);
  return serializeReservation(rows[0], meta);
}

async function listMyReservations(user) {
  const { rows } = await query(
    `SELECT r.*, c.name AS court_name, i.name AS institution_name
     FROM court_reservations r
     JOIN courts c ON c.id = r.court_id
     JOIN institutions i ON i.id = r.institution_id
     WHERE r.athlete_user_id = $1
     ORDER BY r.start_at DESC`,
    [user.id],
  );
  return Promise.all(
    rows.map(async (row) => {
      const settings = await getInstitutionCourtSettings(row.institution_id);
      const meta = reservationCancelMeta(row, settings.cancellationPolicyHours);
      return serializeReservation(row, meta);
    }),
  );
}

async function listInstitutionReservations(userId, { date, courtId } = {}) {
  const institution = await getInstitutionByUserId(userId);
  const conditions = ['r.institution_id = $1'];
  const values = [institution.id];
  let i = 2;

  if (date) {
    conditions.push(`r.start_at >= $${i++}::date`);
    conditions.push(`r.start_at < ($${i - 1}::date + interval '1 day')`);
    values.push(date);
  }
  if (courtId) {
    conditions.push(`r.court_id = $${i++}`);
    values.push(courtId);
  }

  const { rows } = await query(
    `SELECT r.*, c.name AS court_name
     FROM court_reservations r
     JOIN courts c ON c.id = r.court_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.start_at ASC`,
    values,
  );
  return Promise.all(
    rows.map(async (row) => {
      const settings = await getInstitutionCourtSettings(row.institution_id);
      const meta = reservationCancelMeta(row, settings.cancellationPolicyHours);
      return serializeReservation(row, meta);
    }),
  );
}

async function cancelReservation(user, reservationId) {
  const { rows } = await query(`SELECT * FROM court_reservations WHERE id = $1`, [reservationId]);
  if (!rows.length) throw notFound('Reservation not found');
  const reservation = rows[0];

  if (user.role === 'athlete' && reservation.athlete_user_id !== user.id) {
    throw forbidden('Not your reservation');
  }
  if (user.role === 'institution') {
    const institution = await getInstitutionByUserId(user.id);
    if (reservation.institution_id !== institution.id) {
      throw forbidden('Not your institution reservation');
    }
  }

  if (!['pending_payment', 'confirmed'].includes(reservation.status)) {
    throw badRequest('Reservation cannot be cancelled');
  }

  const settings = await getInstitutionCourtSettings(reservation.institution_id);
  const policyHours = settings.cancellationPolicyHours;
  const meta = reservationCancelMeta(reservation, policyHours);

  if (user.role === 'athlete' && !meta.canCancel) {
    throw badRequest(
      `Cancellation is only allowed at least ${policyHours} hours before the reservation`,
    );
  }

  if (meta.refundEligible) {
    await paymentsService.refundPaymentForCourtReservation(reservationId);
  } else if (reservation.status === 'pending_payment') {
    await query(
      `UPDATE court_reservations SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE id = $1`,
      [reservationId],
    );
    await query(
      `UPDATE payments SET status = 'cancelled', updated_at = now()
       WHERE court_reservation_id = $1 AND status = 'pending'`,
      [reservationId],
    );
  } else {
    await query(
      `UPDATE court_reservations SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE id = $1`,
      [reservationId],
    );
  }

  return getReservationById(reservationId);
}

async function quotePrice(user, { courtId, startAt, durationMinutes }) {
  const { rows: courtRows } = await query(
    `SELECT * FROM courts WHERE id = $1 AND active = TRUE`,
    [courtId],
  );
  if (!courtRows.length) throw notFound('Court not found');
  const court = courtRows[0];

  const memberId = user?.id ? await isActiveMember(user.id, court.institution_id) : null;
  const isMember = Boolean(memberId);
  const settings = await getInstitutionCourtSettings(court.institution_id);
  const slotMinutes = settings.defaultSlotMinutes;
  const duration = durationMinutes || slotMinutes;

  const { rows: ruleRows } = await query(
    `SELECT * FROM court_pricing_rules WHERE institution_id = $1 AND active = TRUE`,
    [court.institution_id],
  );

  const applied = quoteTotalPrice(ruleRows, {
    courtId,
    startAt,
    durationMinutes: duration,
    isMember,
    slotMinutes,
  });
  if (!applied) throw badRequest('No pricing rule applies to this time slot');

  const sampleRule = ruleRows.find((r) => !r.court_id || r.court_id === courtId);

  return {
    memberPrice: {
      amount: sampleRule?.member_price_cents ?? applied.amount,
      currency: applied.currency,
    },
    nonMemberPrice: {
      amount: sampleRule?.non_member_price_cents ?? applied.amount,
      currency: applied.currency,
    },
    appliedPrice: { amount: applied.amount, currency: applied.currency },
    isMemberRate: applied.isMemberRate,
    durationMinutes: duration,
    slotMinutes,
    cancellationPolicyHours: settings.cancellationPolicyHours,
  };
}

module.exports = {
  getCourtSettings,
  getInstitutionCourtSettings,
  updateCourtSettings,
  listCourts,
  listCourtsPublic,
  createCourt,
  updateCourt,
  deleteCourt,
  listPricingRules,
  createPricingRule,
  deletePricingRule,
  getSchedule,
  createReservation,
  listMyReservations,
  listInstitutionReservations,
  cancelReservation,
  quotePrice,
  getReservationById,
  notifyReservationConfirmed,
};
