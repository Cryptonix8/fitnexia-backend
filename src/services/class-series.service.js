const { query } = require('../db/pool');
const { badRequest, forbidden, notFound } = require('../utils/errors');
const { isValidDiscipline } = require('../config/disciplines');
const { getClassById, getClassRow, assertCanManageClass } = require('./classes.service');
const { getInstructorByUserId } = require('./instructors.service');
const {
  getInstitutionByUserId,
  assertInstructorLinked,
} = require('./institutions.service');

const HORIZON_WEEKS = 8;

function normalizeWeekdays(weekdays) {
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw badRequest('recurrence.weekdays must include at least one day (0=Sun … 6=Sat)');
  }
  const normalized = [...new Set(weekdays.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6))];
  if (!normalized.length) {
    throw badRequest('recurrence.weekdays must include valid day numbers 0–6');
  }
  return normalized.sort((a, b) => a - b);
}

function extractTimeParts(date) {
  return { hours: date.getHours(), minutes: date.getMinutes() };
}

function buildStartAt(baseDate, hours, minutes) {
  const d = new Date(baseDate);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function horizonDate(from = new Date()) {
  return addDays(from, HORIZON_WEEKS * 7);
}

function enumerateOccurrences({ anchorStartAt, weekdays, timeParts, fromDate, untilDate }) {
  const results = [];
  const from = new Date(fromDate);
  from.setHours(0, 0, 0, 0);
  const until = new Date(untilDate);
  until.setHours(23, 59, 59, 999);
  const anchor = new Date(anchorStartAt);

  for (let cursor = new Date(from); cursor <= until; cursor = addDays(cursor, 1)) {
    if (!weekdays.includes(cursor.getDay())) continue;
    const startAt = buildStartAt(cursor, timeParts.hours, timeParts.minutes);
    if (startAt.getTime() < anchor.getTime()) continue;
    if (startAt.getTime() <= Date.now()) continue;
    results.push(startAt);
  }

  return results;
}

async function getSeriesRow(seriesId) {
  const { rows } = await query(`SELECT * FROM class_series WHERE id = $1`, [seriesId]);
  if (!rows.length) throw notFound('Class series not found');
  return rows[0];
}

async function assertCanManageSeries(user, seriesRow) {
  if (user.role === 'instructor') {
    const instructor = await getInstructorByUserId(user.id);
    if (seriesRow.instructor_id === instructor.id) return;
  }
  if (user.role === 'institution') {
    const institution = await getInstitutionByUserId(user.id);
    if (seriesRow.institution_id === institution.id) return;
  }
  throw forbidden('You cannot manage this class series');
}

async function insertClassInstance(seriesRow, startAt) {
  const { rows: existing } = await query(
    `SELECT id FROM classes
     WHERE series_id = $1 AND start_at = $2 AND cancelled_at IS NULL LIMIT 1`,
    [seriesRow.id, startAt.toISOString()],
  );
  if (existing.length) return existing[0].id;

  const { rows } = await query(
    `INSERT INTO classes (
      title, description, discipline, modality, class_format, level, language,
      instructor_id, institution_id, start_at, duration_minutes,
      price_cents, price_currency, capacity, cancellation_policy_hours,
      location_label, location_lat, location_lng, series_id, recurrence
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING id`,
    [
      seriesRow.title,
      seriesRow.description,
      seriesRow.discipline,
      seriesRow.modality,
      seriesRow.class_format,
      seriesRow.level,
      seriesRow.language,
      seriesRow.instructor_id,
      seriesRow.institution_id,
      startAt.toISOString(),
      seriesRow.duration_minutes,
      seriesRow.price_cents,
      seriesRow.price_currency,
      seriesRow.capacity,
      seriesRow.cancellation_policy_hours,
      seriesRow.location_label,
      seriesRow.location_lat,
      seriesRow.location_lng,
      seriesRow.id,
      JSON.stringify({
        enabled: true,
        frequency: 'weekly',
        weekdays: seriesRow.weekdays,
        seriesId: seriesRow.id,
      }),
    ],
  );
  return rows[0]?.id || null;
}

async function generateInstancesForSeries(seriesId, { fromDate, untilDate } = {}) {
  const seriesRow = await getSeriesRow(seriesId);
  if (seriesRow.status !== 'active') return { created: 0, instanceIds: [] };

  const anchor = new Date(seriesRow.anchor_start_at);
  const timeParts = extractTimeParts(anchor);
  const from = fromDate ? new Date(fromDate) : new Date();
  const until = untilDate ? new Date(untilDate) : horizonDate(from);

  const occurrences = enumerateOccurrences({
    anchorStartAt: anchor,
    weekdays: seriesRow.weekdays,
    timeParts,
    fromDate: from,
    untilDate: until,
  });

  const instanceIds = [];
  for (const startAt of occurrences) {
    const id = await insertClassInstance(seriesRow, startAt);
    if (id) instanceIds.push(id);
  }

  return { created: instanceIds.length, instanceIds };
}

async function resolveCreateContext(user, body) {
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

  const anchorStartAt = new Date(startAt);
  if (Number.isNaN(anchorStartAt.getTime())) {
    throw badRequest('startAt is invalid');
  }
  if (anchorStartAt.getTime() <= Date.now()) {
    throw badRequest('Class start time must be in the future');
  }

  return {
    title: title.trim(),
    description: description || null,
    discipline,
    modality,
    classFormat,
    level: level || null,
    language: language || null,
    instructorId: resolvedInstructorId,
    institutionId: resolvedInstitutionId,
    anchorStartAt,
    durationMinutes,
    price,
    capacity: capacity || null,
    cancellationPolicyHours,
    location,
  };
}

function serializeSeriesRow(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || undefined,
    discipline: row.discipline,
    modality: row.modality,
    classFormat: row.class_format,
    status: row.status,
    weekdays: row.weekdays,
    timeOfDay: row.time_of_day,
    anchorStartAt: row.anchor_start_at.toISOString(),
    durationMinutes: row.duration_minutes,
    price: { amount: row.price_cents, currency: row.price_currency },
    capacity: row.capacity ?? undefined,
    instructorId: row.instructor_id,
    institutionId: row.institution_id || undefined,
    pausedAt: row.paused_at?.toISOString(),
    deletedAt: row.deleted_at?.toISOString(),
  };
}

async function createRecurringSeries(user, body) {
  const recurrence = body.recurrence;
  if (!recurrence?.enabled) {
    throw badRequest('recurrence.enabled must be true');
  }

  const ctx = await resolveCreateContext(user, body);
  const weekdays = normalizeWeekdays(recurrence.weekdays);

  if (!weekdays.includes(ctx.anchorStartAt.getDay())) {
    throw badRequest('startAt must fall on one of the selected recurrence weekdays');
  }

  const { rows } = await query(
    `INSERT INTO class_series (
      title, description, discipline, modality, class_format, level, language,
      instructor_id, institution_id, duration_minutes,
      price_cents, price_currency, capacity, cancellation_policy_hours,
      location_label, location_lat, location_lng,
      weekdays, time_of_day, anchor_start_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING *`,
    [
      ctx.title,
      ctx.description,
      ctx.discipline,
      ctx.modality,
      ctx.classFormat,
      ctx.level,
      ctx.language,
      ctx.instructorId,
      ctx.institutionId,
      ctx.durationMinutes,
      ctx.price.amount,
      ctx.price.currency || require('../config/env').defaultCurrency,
      ctx.capacity,
      ctx.cancellationPolicyHours,
      ctx.location?.label || null,
      ctx.location?.lat ?? null,
      ctx.location?.lng ?? null,
      weekdays,
      ctx.anchorStartAt.toISOString().slice(11, 19),
      ctx.anchorStartAt.toISOString(),
    ],
  );

  const seriesRow = rows[0];
  const { created, instanceIds } = await generateInstancesForSeries(seriesRow.id, {
    fromDate: new Date(),
    untilDate: horizonDate(ctx.anchorStartAt),
  });

  return {
    series: serializeSeriesRow(seriesRow),
    instancesCreated: created,
    firstInstance: instanceIds[0] ? await getClassById(instanceIds[0]) : null,
  };
}

async function getSeriesForUser(user, seriesId) {
  const seriesRow = await getSeriesRow(seriesId);
  await assertCanManageSeries(user, seriesRow);
  return serializeSeriesRow(seriesRow);
}

async function listSeriesInstances(user, seriesId) {
  const seriesRow = await getSeriesRow(seriesId);
  await assertCanManageSeries(user, seriesRow);
  const { rows } = await query(
    `SELECT id, start_at FROM classes
     WHERE series_id = $1 AND cancelled_at IS NULL
     ORDER BY start_at ASC`,
    [seriesId],
  );
  return rows.map((r) => ({ id: r.id, startAt: r.start_at.toISOString() }));
}

async function updateClassWithScope(user, classId, updates, editScope = 'this') {
  const classRow = await getClassRow(classId);
  await assertCanManageClass(user, classRow);

  if (!classRow.series_id || editScope === 'this') {
    if (classRow.series_id) {
      await query(`UPDATE classes SET is_series_exception = TRUE, updated_at = now() WHERE id = $1`, [
        classId,
      ]);
    }
    const classesService = require('./classes.service');
    const updated = await classesService.updateClassInternal(user, classId, updates);
    if (classRow.series_id) {
      const { notifyClassInstanceUpdated } = require('./notifications.service');
      await notifyClassInstanceUpdated(classId);
    }
    return updated;
  }

  if (editScope !== 'following') {
    throw badRequest('editScope must be "this" or "following"');
  }

  const seriesRow = await getSeriesRow(classRow.series_id);
  await assertCanManageSeries(user, seriesRow);

  const instanceStart = new Date(classRow.start_at);
  if (instanceStart.getTime() <= Date.now()) {
    throw badRequest('Cannot apply "following" changes starting from a past class');
  }

  await applySeriesTemplateUpdates(seriesRow.id, updates);

  const { rows: affected } = await query(
    `SELECT id FROM classes
     WHERE series_id = $1 AND start_at >= $2 AND cancelled_at IS NULL`,
    [seriesRow.id, instanceStart.toISOString()],
  );

  await applyUpdatesToClassRows(affected.map((r) => r.id), updates);

  await generateInstancesForSeries(seriesRow.id, {
    fromDate: instanceStart,
    untilDate: horizonDate(new Date()),
  });

  const { notifyClassInstanceUpdated } = require('./notifications.service');
  for (const row of affected) {
    await notifyClassInstanceUpdated(row.id);
  }

  return getClassById(classId);
}

async function applySeriesTemplateUpdates(seriesId, updates) {
  const fieldMap = {
    title: 'title',
    description: 'description',
    discipline: 'discipline',
    modality: 'modality',
    classFormat: 'class_format',
    level: 'level',
    language: 'language',
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
    values.push(
      updates.price.amount,
      updates.price.currency || require('../config/env').defaultCurrency,
    );
  }

  if (updates.location) {
    sets.push(`location_label = $${i++}`, `location_lat = $${i++}`, `location_lng = $${i++}`);
    values.push(
      updates.location.label || null,
      updates.location.lat ?? null,
      updates.location.lng ?? null,
    );
  }

  if (!sets.length) return;

  sets.push('updated_at = now()');
  values.push(seriesId);
  await query(`UPDATE class_series SET ${sets.join(', ')} WHERE id = $${i}`, values);
}

async function applyUpdatesToClassRows(classIds, updates) {
  if (!classIds.length) return;

  const fieldMap = {
    title: 'title',
    description: 'description',
    discipline: 'discipline',
    modality: 'modality',
    classFormat: 'class_format',
    level: 'level',
    language: 'language',
    durationMinutes: 'duration_minutes',
    capacity: 'capacity',
    cancellationPolicyHours: 'cancellation_policy_hours',
  };

  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, col] of Object.entries(fieldMap)) {
    if (updates[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(key === 'title' ? updates[key].trim() : updates[key]);
    }
  }

  if (updates.price) {
    sets.push(`price_cents = $${i++}`, `price_currency = $${i++}`);
    values.push(
      updates.price.amount,
      updates.price.currency || require('../config/env').defaultCurrency,
    );
  }

  if (updates.location) {
    sets.push(`location_label = $${i++}`, `location_lat = $${i++}`, `location_lng = $${i++}`);
    values.push(
      updates.location.label || null,
      updates.location.lat ?? null,
      updates.location.lng ?? null,
    );
  }

  if (!sets.length) return;

  sets.push('updated_at = now()');
  values.push(classIds);
  await query(
    `UPDATE classes SET ${sets.join(', ')} WHERE id = ANY($${i}::uuid[])`,
    values,
  );
}

async function pauseSeries(user, seriesId) {
  const seriesRow = await getSeriesRow(seriesId);
  await assertCanManageSeries(user, seriesRow);
  if (seriesRow.status !== 'active') {
    throw badRequest('Series is not active');
  }

  await query(
    `UPDATE class_series SET status = 'paused', paused_at = now(), updated_at = now() WHERE id = $1`,
    [seriesId],
  );

  const { notifySeriesPaused } = require('./notifications.service');
  await notifySeriesPaused(seriesId);

  return getSeriesForUser(user, seriesId);
}

async function resumeSeries(user, seriesId) {
  const seriesRow = await getSeriesRow(seriesId);
  await assertCanManageSeries(user, seriesRow);
  if (seriesRow.status !== 'paused') {
    throw badRequest('Series is not paused');
  }

  await query(
    `UPDATE class_series SET status = 'active', paused_at = NULL, updated_at = now() WHERE id = $1`,
    [seriesId],
  );

  await generateInstancesForSeries(seriesId, {
    fromDate: new Date(),
    untilDate: horizonDate(new Date()),
  });

  return getSeriesForUser(user, seriesId);
}

async function deleteSeries(user, seriesId) {
  const seriesRow = await getSeriesRow(seriesId);
  await assertCanManageSeries(user, seriesRow);
  if (seriesRow.status === 'deleted') {
    throw badRequest('Series is already deleted');
  }

  const { rows: futureClasses } = await query(
    `SELECT c.id,
            (SELECT COUNT(*)::int FROM bookings b
             WHERE b.class_id = c.id AND b.status IN ('pending_payment', 'confirmed')) AS booked
     FROM classes c
     WHERE c.series_id = $1 AND c.start_at > now() AND c.cancelled_at IS NULL`,
    [seriesId],
  );

  for (const cls of futureClasses) {
    if (cls.booked === 0) {
      await query(`UPDATE classes SET cancelled_at = now(), updated_at = now() WHERE id = $1`, [
        cls.id,
      ]);
    }
  }

  await query(
    `UPDATE class_series SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1`,
    [seriesId],
  );

  const { notifySeriesDeleted } = require('./notifications.service');
  await notifySeriesDeleted(seriesId);

  return getSeriesForUser(user, seriesId);
}

async function extendActiveSeriesHorizon() {
  const { rows } = await query(`SELECT id FROM class_series WHERE status = 'active'`);
  let totalCreated = 0;
  for (const row of rows) {
    const { rows: maxRows } = await query(
      `SELECT MAX(start_at) AS max_start FROM classes
       WHERE series_id = $1 AND cancelled_at IS NULL AND start_at > now()`,
      [row.id],
    );
    const fromDate = maxRows[0]?.max_start ? addDays(new Date(maxRows[0].max_start), 1) : new Date();
    const { created } = await generateInstancesForSeries(row.id, {
      fromDate,
      untilDate: horizonDate(new Date()),
    });
    totalCreated += created;
  }
  return totalCreated;
}

module.exports = {
  HORIZON_WEEKS,
  createRecurringSeries,
  generateInstancesForSeries,
  extendActiveSeriesHorizon,
  getSeriesForUser,
  listSeriesInstances,
  updateClassWithScope,
  pauseSeries,
  resumeSeries,
  deleteSeries,
  serializeSeriesRow,
  getSeriesRow,
};
