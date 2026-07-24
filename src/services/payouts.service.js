const { query } = require('../db/pool');
const { forbidden } = require('../utils/errors');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { getCommissionPercent, getInstitutionCommissionPercent } = require('../config/plans');
const { getInstructorByUserId } = require('./instructors.service');
const { getInstitutionByUserId } = require('./institutions.service');
const { isMarketplaceEnabled } = require('../config/marketplace.config');

const BOOKING_STATUSES = ['confirmed', 'completed'];

function periodBounds(period = 'month') {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  let start;
  if (period === 'day') {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
  } else if (period === 'week') {
    start = new Date(now);
    start.setDate(now.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
  }

  return { start, end };
}

async function resolveOwner(user) {
  if (user.role === 'instructor') {
    const instructor = await getInstructorByUserId(user.id);
    return {
      role: 'instructor',
      plan: instructor.plan,
      commissionRate: getCommissionPercent(instructor.plan) / 100,
      whereSql: 'c.instructor_id = $1',
      params: [instructor.id],
    };
  }

  if (user.role === 'institution') {
    const institution = await getInstitutionByUserId(user.id);
    return {
      role: 'institution',
      plan: institution.saas_tier || institution.plan,
      commissionRate: getInstitutionCommissionPercent(institution) / 100,
      whereSql: 'c.institution_id = $1',
      params: [institution.id],
    };
  }

  throw forbidden('Only instructors and institutions can view payouts');
}

function bookingFilterSql(owner, startIndex) {
  return `
    FROM bookings b
    JOIN classes c ON c.id = b.class_id
    WHERE ${owner.whereSql}
      AND b.status = ANY($${startIndex})
      AND c.cancelled_at IS NULL
  `;
}

async function listPayouts(user, queryParams = {}) {
  const owner = await resolveOwner(user);
  const { page, limit, offset } = parsePagination(queryParams);
  const { start, end } = periodBounds('month');
  const from = queryParams.from ? new Date(queryParams.from) : start;
  const to = queryParams.to ? new Date(`${queryParams.to}T23:59:59.999`) : end;
  const commissionRate = owner.commissionRate;

  const statusIdx = owner.params.length + 1;
  const fromIdx = statusIdx + 1;
  const toIdx = fromIdx + 1;
  const baseFilter = bookingFilterSql(owner, statusIdx);
  const values = [...owner.params, BOOKING_STATUSES, from, to];

  const countResult = await query(
    `SELECT COUNT(*)::int AS total ${baseFilter} AND b.created_at >= $${fromIdx} AND b.created_at <= $${toIdx}`,
    values,
  );
  const total = countResult.rows[0].total;

  values.push(limit, offset);
  const limitIdx = toIdx + 1;
  const offsetIdx = limitIdx + 1;

  const { rows } = await query(
    `SELECT b.id, b.status, b.price_cents, b.price_currency, b.created_at, c.title AS class_title
     ${baseFilter}
       AND b.created_at >= $${fromIdx}
       AND b.created_at <= $${toIdx}
     ORDER BY b.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values,
  );

  const data = rows.map((row) => {
    const gross = row.price_cents;
    const net = Math.round(gross * (1 - commissionRate));
    return {
      id: row.id,
      classTitle: row.class_title,
      amount: { amount: net, currency: row.price_currency || 'UYU' },
      gross: { amount: gross, currency: row.price_currency || 'UYU' },
      status: row.status,
      createdAt: row.created_at.toISOString(),
    };
  });

  return paginatedResponse(data, total, page, limit);
}

async function getSummary(user, period = 'month') {
  const owner = await resolveOwner(user);
  const { start, end } = periodBounds(period);
  const commissionRate = owner.commissionRate;

  const statusIdx = owner.params.length + 1;
  const fromIdx = statusIdx + 1;
  const toIdx = fromIdx + 1;
  const baseFilter = bookingFilterSql(owner, statusIdx);
  const values = [...owner.params, BOOKING_STATUSES, start, end];

  const { rows } = await query(
    `SELECT
       COALESCE(SUM(b.price_cents), 0)::int AS gross,
       COALESCE(MAX(b.price_currency), 'UYU') AS currency
     ${baseFilter}
       AND b.created_at >= $${fromIdx}
       AND b.created_at <= $${toIdx}`,
    values,
  );

  const gross = rows[0].gross;
  const platformFee = Math.round(gross * commissionRate);
  const net = gross - platformFee;

  return {
    gross,
    platformFee,
    net,
    currency: rows[0].currency,
    commissionRate,
    plan: owner.plan,
    automaticPayouts: isMarketplaceEnabled(),
  };
}

async function exportCsv(user, queryParams = {}) {
  const owner = await resolveOwner(user);
  const { start, end } = periodBounds('month');
  const from = queryParams.from ? new Date(queryParams.from) : start;
  const to = queryParams.to ? new Date(`${queryParams.to}T23:59:59.999`) : end;
  const commissionRate = owner.commissionRate;

  const statusIdx = owner.params.length + 1;
  const fromIdx = statusIdx + 1;
  const toIdx = fromIdx + 1;
  const baseFilter = bookingFilterSql(owner, statusIdx);
  const values = [...owner.params, BOOKING_STATUSES, from, to];

  const { rows } = await query(
    `SELECT b.id, b.status, b.price_cents, b.price_currency, b.created_at, c.title AS class_title
     ${baseFilter}
       AND b.created_at >= $${fromIdx}
       AND b.created_at <= $${toIdx}
     ORDER BY b.created_at DESC`,
    values,
  );

  const lines = ['date,class,status,gross_cents,net_cents,currency'];
  for (const row of rows) {
    const gross = row.price_cents;
    const net = Math.round(gross * (1 - commissionRate));
    const date = row.created_at.toISOString().slice(0, 10);
    const title = `"${String(row.class_title).replace(/"/g, '""')}"`;
    lines.push(`${date},${title},${row.status},${gross},${net},${row.price_currency || 'UYU'}`);
  }

  return lines.join('\n');
}

module.exports = { listPayouts, getSummary, exportCsv };
