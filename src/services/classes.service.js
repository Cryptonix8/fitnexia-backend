const { query } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const { isValidDiscipline } = require('../config/disciplines');
const { serializeClassRow, getBookingCount } = require('../utils/serializers');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { CLASS_SELECT, CLASS_JOINS } = require('./instructors.service');
const { getInstructorByUserId } = require('./instructors.service');
const {
  getInstitutionByUserId,
  assertInstructorLinked,
} = require('./institutions.service');

async function getClassRow(id) {
  const { rows } = await query(
    `SELECT ${CLASS_SELECT} ${CLASS_JOINS} WHERE c.id = $1 AND c.cancelled_at IS NULL`,
    [id],
  );
  if (!rows.length) throw notFound('Class not found');
  return rows[0];
}

async function getClassById(id) {
  const row = await getClassRow(id);
  return serializeClassRow(row);
}

async function assertCanManageClass(user, classRow) {
  if (user.role === 'instructor') {
    const instructor = await getInstructorByUserId(user.id);
    if (classRow.instructor_id === instructor.id) return;
  }
  if (user.role === 'institution') {
    const institution = await getInstitutionByUserId(user.id);
    if (classRow.institution_id === institution.id) return;
  }
  throw forbidden('You cannot manage this class');
}

async function createClass(user, body) {
  if (body.recurrence?.enabled) {
    const classSeriesService = require('./class-series.service');
    const result = await classSeriesService.createRecurringSeries(user, body);
    return result.firstInstance;
  }

  const {
    title,
    description,
    discipline,
    modality,
    classFormat = 'group',
    level,
    language,
    startAt,
    durationMinutes,
    price,
    capacity,
    cancellationPolicyHours = 24,
    location,
    institutionId,
    instructorId,
    recurrence,
  } = body;

  if (!title?.trim() || !discipline || !modality || !startAt || !durationMinutes || !price) {
    throw badRequest('title, discipline, modality, startAt, durationMinutes, and price are required');
  }
  if (!isValidDiscipline(discipline)) {
    throw badRequest('discipline is invalid');
  }

  let resolvedInstructorId = instructorId;
  let resolvedInstitutionId = institutionId || null;

  if (user.role === 'instructor') {
    const instructor = await getInstructorByUserId(user.id);
    resolvedInstructorId = instructor.id;
    if (resolvedInstitutionId) {
      await assertInstructorLinked(resolvedInstitutionId, resolvedInstructorId);
    }
  } else if (user.role === 'institution') {
    const institution = await getInstitutionByUserId(user.id);
    resolvedInstitutionId = institution.id;
    if (!resolvedInstructorId) {
      throw badRequest('instructorId is required when institution creates a class');
    }
    await assertInstructorLinked(resolvedInstitutionId, resolvedInstructorId);
  } else {
    throw forbidden('Only instructors and institutions can create classes');
  }

  const startDate = new Date(startAt);
  if (Number.isNaN(startDate.getTime())) {
    throw badRequest('startAt is invalid');
  }
  if (startDate.getTime() <= Date.now()) {
    throw badRequest('Class start time must be in the future');
  }

  const { rows } = await query(
    `INSERT INTO classes (
      title, description, discipline, modality, class_format, level, language,
      instructor_id, institution_id, start_at, duration_minutes,
      price_cents, price_currency, capacity, cancellation_policy_hours,
      location_label, location_lat, location_lng, recurrence
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING id`,
    [
      title.trim(),
      description || null,
      discipline,
      modality,
      classFormat,
      level || null,
      language || null,
      resolvedInstructorId,
      resolvedInstitutionId,
      startAt,
      durationMinutes,
      price.amount,
      price.currency || require('../config/env').defaultCurrency,
      capacity || null,
      cancellationPolicyHours,
      location?.label || null,
      location?.lat ?? null,
      location?.lng ?? null,
      recurrence ? JSON.stringify(recurrence) : null,
    ],
  );

  const created = await getClassById(rows[0].id);
  void require('./notifications.service')
    .notifyClassPosted(created.id)
    .catch((err) => console.warn('[notifications] class posted:', err.message));

  return created;
}

async function updateClassInternal(user, id, updates) {
  const classRow = await getClassRow(id);
  await assertCanManageClass(user, classRow);

  const fieldMap = {
    title: 'title',
    description: 'description',
    discipline: 'discipline',
    modality: 'modality',
    classFormat: 'class_format',
    level: 'level',
    language: 'language',
    startAt: 'start_at',
    durationMinutes: 'duration_minutes',
    capacity: 'capacity',
    cancellationPolicyHours: 'cancellation_policy_hours',
  };

  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, col] of Object.entries(fieldMap)) {
    if (updates[key] !== undefined) {
      if (key === 'discipline' && !isValidDiscipline(updates[key])) {
        throw badRequest('discipline is invalid');
      }
      sets.push(`${col} = $${i++}`);
      values.push(key === 'title' ? updates[key].trim() : updates[key]);
    }
  }

  if (updates.price) {
    sets.push(`price_cents = $${i++}`, `price_currency = $${i++}`);
    values.push(updates.price.amount, updates.price.currency || require('../config/env').defaultCurrency);
  }

  if (updates.location) {
    sets.push(`location_label = $${i++}`, `location_lat = $${i++}`, `location_lng = $${i++}`);
    values.push(
      updates.location.label || null,
      updates.location.lat ?? null,
      updates.location.lng ?? null,
    );
  }

  if (!sets.length) {
    return getClassById(id);
  }

  if (updates.startAt !== undefined) {
    const startDate = new Date(updates.startAt);
    if (Number.isNaN(startDate.getTime())) {
      throw badRequest('startAt is invalid');
    }
    if (startDate.getTime() <= Date.now()) {
      throw badRequest('Class start time must be in the future');
    }
  }

  sets.push('updated_at = now()');
  values.push(id);
  await query(`UPDATE classes SET ${sets.join(', ')} WHERE id = $${i}`, values);
  return getClassById(id);
}

async function updateClass(user, id, updates) {
  const { editScope, ...fields } = updates;
  if (editScope && (editScope === 'this' || editScope === 'following')) {
    const classSeriesService = require('./class-series.service');
    return classSeriesService.updateClassWithScope(user, id, fields, editScope);
  }
  return updateClassInternal(user, id, fields);
}

async function cancelClass(user, id) {
  const classRow = await getClassRow(id);
  await assertCanManageClass(user, classRow);

  const { rows: bookings } = await query(
    `SELECT id, status FROM bookings
     WHERE class_id = $1 AND status IN ('pending_payment', 'confirmed')`,
    [id],
  );

  for (const booking of bookings) {
    if (booking.status === 'confirmed') {
      await require('./payments.service').refundPaymentForBooking(booking.id);
    } else {
      await query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [booking.id],
      );
      await query(
        `UPDATE payments SET status = 'cancelled', updated_at = now()
         WHERE booking_id = $1 AND status = 'pending'`,
        [booking.id],
      );
    }
  }

  await query(`UPDATE classes SET cancelled_at = now(), updated_at = now() WHERE id = $1`, [id]);

  const { notifyClassInstanceCancelled } = require('./notifications.service');
  await notifyClassInstanceCancelled(id);
}

async function listMine(user) {
  let rows;
  if (user.role === 'instructor') {
    const instructor = await getInstructorByUserId(user.id);
    ({ rows } = await query(
      `SELECT ${CLASS_SELECT} ${CLASS_JOINS}
       WHERE c.instructor_id = $1 AND c.cancelled_at IS NULL
       ORDER BY c.start_at ASC`,
      [instructor.id],
    ));
  } else if (user.role === 'institution') {
    const institution = await getInstitutionByUserId(user.id);
    ({ rows } = await query(
      `SELECT ${CLASS_SELECT} ${CLASS_JOINS}
       WHERE c.institution_id = $1 AND c.cancelled_at IS NULL
       ORDER BY c.start_at ASC`,
      [institution.id],
    ));
  } else {
    throw forbidden('Only instructors and institutions can list their classes');
  }

  return Promise.all(rows.map((r) => serializeClassRow(r)));
}

async function searchClasses(queryParams) {
  const { page, limit, offset } = parsePagination(queryParams);
  const conditions = [
    `c.cancelled_at IS NULL`,
    `(c.start_at + (COALESCE(c.duration_minutes, 60) || ' minutes')::interval) > now()`,
  ];
  const values = [];
  let i = 1;

  if (queryParams.q) {
    conditions.push(
      `(c.title ILIKE $${i} OR i.display_name ILIKE $${i} OR inst.name ILIKE $${i})`,
    );
    values.push(`%${queryParams.q}%`);
    i++;
  }

  if (queryParams.discipline) {
    conditions.push(`c.discipline ILIKE $${i++}`);
    values.push(queryParams.discipline);
  }

  if (queryParams.modality) {
    conditions.push(`c.modality = $${i++}`);
    values.push(queryParams.modality);
  }

  if (queryParams.priceMin) {
    conditions.push(`c.price_cents >= $${i++}`);
    values.push(Number(queryParams.priceMin));
  }

  if (queryParams.priceMax) {
    conditions.push(`c.price_cents <= $${i++}`);
    values.push(Number(queryParams.priceMax));
  }

  if (queryParams.dateFrom) {
    conditions.push(`c.start_at >= $${i++}`);
    values.push(queryParams.dateFrom);
  }

  if (queryParams.dateTo) {
    conditions.push(`c.start_at <= $${i++}`);
    values.push(queryParams.dateTo);
  }

  if (queryParams.verifiedOnly === 'true' || queryParams.verifiedOnly === true) {
    conditions.push(`i.verified = TRUE`);
  }

  if (queryParams.level) {
    conditions.push(`c.level = $${i++}`);
    values.push(queryParams.level);
  }

  if (queryParams.language) {
    conditions.push(`c.language ILIKE $${i++}`);
    values.push(queryParams.language);
  }

  if (queryParams.instructorGender) {
    conditions.push(`i.gender = $${i++}`);
    values.push(queryParams.instructorGender);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortMap = {
    price_asc: 'c.price_cents ASC',
    date_asc: 'c.start_at ASC',
    rating_desc: 'i.average_rating DESC',
  };
  const orderBy = sortMap[queryParams.sort] || 'c.start_at ASC';

  const countResult = await query(
    `SELECT COUNT(*)::int AS total ${CLASS_JOINS} ${where}`,
    values,
  );
  const total = countResult.rows[0].total;

  values.push(limit, offset);
  const { rows } = await query(
    `SELECT ${CLASS_SELECT} ${CLASS_JOINS} ${where}
     ORDER BY ${orderBy}
     LIMIT $${i++} OFFSET $${i}`,
    values,
  );

  const data = await Promise.all(rows.map((r) => serializeClassRow(r)));
  return paginatedResponse(data, total, page, limit);
}

async function homeFeed() {
  const { rows } = await query(
    `SELECT ${CLASS_SELECT} ${CLASS_JOINS}
     WHERE c.cancelled_at IS NULL
       AND (c.start_at + (COALESCE(c.duration_minutes, 60) || ' minutes')::interval) > now()
     ORDER BY c.start_at ASC
     LIMIT 30`,
  );

  const all = await Promise.all(rows.map((r) => serializeClassRow(r)));
  return {
    recommended: all.slice(0, 3),
    nearby: all.slice(3, 6),
    popular: [...all].sort((a, b) => (b.averageRating || 0) - (a.averageRating || 0)).slice(0, 3),
  };
}

async function mapMarkers(queryParams) {
  const result = await searchClasses({ ...queryParams, limit: 200, page: 1 });
  return result.data
    .filter((c) => c.location?.lat != null)
    .map((c) => ({
      id: c.id,
      lat: c.location.lat,
      lng: c.location.lng,
      title: c.title,
      price: c.price,
      startAt: c.startAt,
    }));
}

module.exports = {
  getClassRow,
  getClassById,
  createClass,
  updateClass,
  updateClassInternal,
  cancelClass,
  assertCanManageClass,
  listMine,
  searchClasses,
  homeFeed,
  mapMarkers,
};
