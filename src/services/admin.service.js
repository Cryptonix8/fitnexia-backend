const { query } = require('../db/pool');
const { notFound, badRequest, forbidden } = require('../utils/errors');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { serializeUser } = require('../utils/serializers');

const VALID_ROLES = ['athlete', 'instructor', 'institution', 'admin'];

const USER_LIST_FROM = `
  FROM users u
  LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
  LEFT JOIN instructors i ON i.user_id = u.id
  LEFT JOIN institutions inst ON inst.user_id = u.id
`;

function userDisplayNameSql() {
  return `COALESCE(
    NULLIF(TRIM(CONCAT(ap.first_name, ' ', ap.last_name)), ''),
    i.display_name,
    inst.name
  )`;
}

function serializeAdminUser(row) {
  return {
    ...serializeUser(row),
    createdAt: row.created_at.toISOString(),
    displayName: row.display_name || null,
    avatarUrl: row.avatar_url || null,
  };
}

function buildUserListFilters(queryParams) {
  const search = typeof queryParams.q === 'string' ? queryParams.q.trim() : '';
  const role =
    typeof queryParams.role === 'string' && VALID_ROLES.includes(queryParams.role)
      ? queryParams.role
      : null;

  const conditions = ['u.deleted_at IS NULL'];
  const values = [];

  if (role) {
    values.push(role);
    conditions.push(`u.role = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    const nameExpr = userDisplayNameSql();
    conditions.push(
      `(u.email ILIKE $${idx} OR ${nameExpr} ILIKE $${idx})`,
    );
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

async function listUsers(queryParams) {
  const { page, limit, offset } = parsePagination(queryParams);
  const { whereSql, values } = buildUserListFilters(queryParams);
  const nameExpr = userDisplayNameSql();

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total ${USER_LIST_FROM} ${whereSql}`,
    values,
  );
  const total = countRows[0].total;

  const listValues = [...values, limit, offset];
  const limitIdx = listValues.length - 1;
  const offsetIdx = listValues.length;

  const { rows } = await query(
    `SELECT u.id, u.email, u.role, u.created_at, ${nameExpr} AS display_name,
            COALESCE(ap.photo_url, i.photo_url, inst.logo_url) AS avatar_url
     ${USER_LIST_FROM}
     ${whereSql}
     ORDER BY u.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    listValues,
  );

  return paginatedResponse(rows.map(serializeAdminUser), total, page, limit);
}

async function getUser(id) {
  const nameExpr = userDisplayNameSql();
  const { rows } = await query(
    `SELECT u.id, u.email, u.role, u.created_at, ${nameExpr} AS display_name,
            COALESCE(ap.photo_url, i.photo_url, inst.logo_url) AS avatar_url
     ${USER_LIST_FROM}
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id],
  );
  if (!rows.length) throw notFound('User not found');
  return serializeAdminUser(rows[0]);
}

function parseDisplayName(displayName) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) {
    throw badRequest('Display name cannot be empty');
  }
  return name;
}

async function updateUserDisplayName(userId, role, displayName) {
  const name = parseDisplayName(displayName);

  if (role === 'athlete') {
    const parts = name.split(/\s+/);
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');
    const { rowCount } = await query(
      `UPDATE athlete_profiles
       SET first_name = $1, last_name = $2
       WHERE user_id = $3`,
      [firstName, lastName, userId],
    );
    if (!rowCount) throw badRequest('Athlete profile not found');
    return;
  }

  if (role === 'instructor') {
    const { rowCount } = await query(
      `UPDATE instructors
       SET display_name = $1, updated_at = now()
       WHERE user_id = $2`,
      [name, userId],
    );
    if (!rowCount) throw badRequest('Instructor profile not found');
    return;
  }

  if (role === 'institution') {
    const { rowCount } = await query(
      `UPDATE institutions
       SET name = $1, updated_at = now()
       WHERE user_id = $2`,
      [name, userId],
    );
    if (!rowCount) throw badRequest('Institution profile not found');
    return;
  }

  throw badRequest('Display name cannot be updated for admin accounts');
}

async function updateUser(id, body) {
  const { rows: existing } = await query(
    `SELECT id, email, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (!existing.length) throw notFound('User not found');

  const sets = [];
  const values = [];

  if (body?.role !== undefined) {
    const role = typeof body.role === 'string' ? body.role.trim() : '';
    if (!role || !VALID_ROLES.includes(role)) {
      throw badRequest(`role must be one of: ${VALID_ROLES.join(', ')}`);
    }
    if (existing[0].role === 'admin' && role !== 'admin') {
      const { rows: adminCount } = await query(
        `SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND deleted_at IS NULL`,
      );
      if (adminCount[0].c <= 1) {
        throw forbidden('Cannot change role of the last admin account');
      }
    }
    values.push(role);
    sets.push(`role = $${values.length}`);
  }

  if (body?.email !== undefined) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) {
      throw badRequest('A valid email is required');
    }
    const { rows: dup } = await query(
      `SELECT id FROM users WHERE email = $1 AND id <> $2 AND deleted_at IS NULL`,
      [email, id],
    );
    if (dup.length) {
      throw badRequest('Email is already in use');
    }
    values.push(email);
    sets.push(`email = $${values.length}`);
  }

  const hasDisplayNameUpdate = body?.displayName !== undefined;

  if (!sets.length && !hasDisplayNameUpdate) {
    throw badRequest('Nothing to update');
  }

  let updatedRole = existing[0].role;

  if (sets.length) {
    values.push(id);
    const idIdx = values.length;

    const { rows } = await query(
      `UPDATE users
       SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${idIdx} AND deleted_at IS NULL
       RETURNING id, email, role, created_at`,
      values,
    );

    updatedRole = rows[0].role;
  }

  if (hasDisplayNameUpdate) {
    await updateUserDisplayName(id, updatedRole, body.displayName);
  }

  return getUser(id);
}

async function deleteUser(adminId, id) {
  if (adminId === id) {
    throw forbidden('You cannot delete your own account');
  }

  const usersService = require('./users.service');
  return usersService.closeAccount(id);
}

async function listVerificationRequests() {
  const verificationService = require('./verification.service');
  return verificationService.listPendingForAdmin();
}

async function getVerificationRequest(id) {
  const verificationService = require('./verification.service');
  return verificationService.getRequestForAdmin(id);
}

async function approveVerification(adminId, id) {
  const verificationService = require('./verification.service');
  return verificationService.approveVerification(adminId, id);
}

async function rejectVerification(adminId, id, notes) {
  const verificationService = require('./verification.service');
  return verificationService.rejectVerification(adminId, id, notes);
}

async function metricsOverview() {
  const [users, classes, bookings, instructors, institutions] = await Promise.all([
    query(`SELECT COUNT(*)::int AS c FROM users WHERE deleted_at IS NULL`),
    query(`SELECT COUNT(*)::int AS c FROM classes WHERE cancelled_at IS NULL`),
    query(`SELECT COUNT(*)::int AS c FROM bookings WHERE status = 'confirmed'`),
    query(`SELECT COUNT(*)::int AS c FROM instructors`),
    query(`SELECT COUNT(*)::int AS c FROM institutions`),
  ]);

  return {
    users: users.rows[0].c,
    classes: classes.rows[0].c,
    confirmedBookings: bookings.rows[0].c,
    instructors: instructors.rows[0].c,
    institutions: institutions.rows[0].c,
  };
}

async function listReportedReviews() {
  const { rows } = await query(
    `SELECT r.id,
            r.instructor_id,
            r.athlete_user_id,
            r.rating,
            r.comment,
            r.created_at,
            COUNT(rr.id)::int AS report_count,
            MAX(rr.created_at) AS last_reported_at,
            ap.first_name,
            ap.last_name
     FROM review_reports rr
     JOIN reviews r ON r.id = rr.review_id
     JOIN users u ON u.id = r.athlete_user_id
     LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
     WHERE r.removed_at IS NULL
     GROUP BY r.id, r.instructor_id, r.athlete_user_id, r.rating, r.comment, r.created_at, ap.first_name, ap.last_name
     ORDER BY last_reported_at DESC`,
  );

  return rows.map((r) => ({
    id: r.id,
    instructorId: r.instructor_id,
    authorUserId: r.athlete_user_id,
    authorName: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
    rating: r.rating,
    comment: r.comment,
    createdAt: r.created_at.toISOString(),
    reportCount: r.report_count,
    lastReportedAt: r.last_reported_at ? r.last_reported_at.toISOString() : r.created_at.toISOString(),
  }));
}

async function removeReview(adminId, reviewId, body) {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';

  const { rows } = await query(
    `UPDATE reviews
     SET removed_at = now(), removed_by = $1, removed_reason = $2
     WHERE id = $3 AND removed_at IS NULL
     RETURNING id`,
    [adminId, reason || null, reviewId],
  );

  if (!rows.length) throw notFound('Review not found');
  return { id: rows[0].id, status: 'removed' };
}

async function listInstitutions(queryParams = {}) {
  const { page, limit, offset } = parsePagination(queryParams);
  const search = typeof queryParams.q === 'string' ? queryParams.q.trim() : '';

  const conditions = [];
  const values = [];
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`i.name ILIKE $${values.length}`);
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM institutions i ${whereSql}`,
    values,
  );

  const listValues = [...values, limit, offset];
  const { rows } = await query(
    `SELECT i.id, i.name, i.saas_tier, i.verified, i.created_at, u.email AS owner_email,
            (SELECT COUNT(*)::int FROM club_members cm
             WHERE cm.institution_id = i.id AND cm.left_at IS NULL AND cm.status != 'inactive') AS member_count
     FROM institutions i
     JOIN users u ON u.id = i.user_id
     ${whereSql}
     ORDER BY i.created_at DESC
     LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
    listValues,
  );

  const data = rows.map((row) => ({
    id: row.id,
    name: row.name,
    saasTier: row.saas_tier,
    verified: row.verified,
    memberCount: row.member_count,
    ownerEmail: row.owner_email,
    createdAt: row.created_at.toISOString(),
  }));

  return paginatedResponse(data, countRows[0].total, page, limit);
}

async function updateInstitutionTier(institutionId, saasTier) {
  const gymSubscriptionService = require('./gym-subscription.service');
  return gymSubscriptionService.updateTierByInstitutionId(institutionId, saasTier);
}

module.exports = {
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  listVerificationRequests,
  getVerificationRequest,
  approveVerification,
  rejectVerification,
  metricsOverview,
  listReportedReviews,
  removeReview,
  listInstitutions,
  updateInstitutionTier,
};
