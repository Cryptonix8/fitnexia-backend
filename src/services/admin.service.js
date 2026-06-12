const { query } = require('../db/pool');
const { notFound, forbidden } = require('../utils/errors');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { serializeUser } = require('../utils/serializers');

async function listUsers(queryParams) {
  const { page, limit, offset } = parsePagination(queryParams);
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM users WHERE deleted_at IS NULL`,
  );
  const total = countRows[0].total;

  const { rows } = await query(
    `SELECT id, email, role, created_at FROM users
     WHERE deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  return paginatedResponse(
    rows.map((r) => ({ ...serializeUser(r), createdAt: r.created_at.toISOString() })),
    total,
    page,
    limit,
  );
}

async function getUser(id) {
  const { rows } = await query(
    `SELECT id, email, role, created_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (!rows.length) throw notFound('User not found');
  return { ...serializeUser(rows[0]), createdAt: rows[0].created_at.toISOString() };
}

async function listVerificationRequests() {
  const { rows } = await query(
    `SELECT vr.*,
            i.display_name AS instructor_name,
            inst.name AS institution_name
     FROM verification_requests vr
     LEFT JOIN instructors i ON i.id = vr.instructor_id
     LEFT JOIN institutions inst ON inst.id = vr.institution_id
     WHERE vr.status = 'pending'
     ORDER BY vr.submitted_at ASC`,
  );

  return rows.map((r) => ({
    id: r.id,
    subjectType: r.subject_type,
    instructorId: r.instructor_id,
    institutionId: r.institution_id,
    subjectName: r.instructor_name || r.institution_name,
    status: r.status,
    submittedAt: r.submitted_at.toISOString(),
  }));
}

async function approveVerification(adminId, id) {
  const { rows } = await query(`SELECT * FROM verification_requests WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Verification request not found');
  const req = rows[0];

  await query(
    `UPDATE verification_requests
     SET status = 'approved', reviewed_at = now(), reviewed_by = $1
     WHERE id = $2`,
    [adminId, id],
  );

  if (req.instructor_id) {
    await query(`UPDATE instructors SET verified = TRUE WHERE id = $1`, [req.instructor_id]);
  }
  if (req.institution_id) {
    await query(`UPDATE institutions SET verified = TRUE WHERE id = $1`, [req.institution_id]);
  }

  return { id, status: 'approved' };
}

async function rejectVerification(adminId, id, notes) {
  const { rows } = await query(`SELECT id FROM verification_requests WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Verification request not found');

  await query(
    `UPDATE verification_requests
     SET status = 'rejected', reviewed_at = now(), reviewed_by = $1, notes = $2
     WHERE id = $3`,
    [adminId, notes || null, id],
  );

  return { id, status: 'rejected' };
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

module.exports = {
  listUsers,
  getUser,
  listVerificationRequests,
  approveVerification,
  rejectVerification,
  metricsOverview,
};
