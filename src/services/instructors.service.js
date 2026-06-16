const { query } = require('../db/pool');
const { notFound, forbidden, badRequest } = require('../utils/errors');
const { validateInstructorProfile } = require('../utils/validation');
const { loadInstructorExtras } = require('./auth.service');
const { serializeInstructorFull } = require('../utils/serializers');

const CLASS_SELECT = `
  c.*,
  i.display_name AS instructor_display_name,
  i.photo_url AS instructor_photo_url,
  i.average_rating,
  inst.name AS institution_name,
  inst.logo_url AS institution_logo_url
`;

const CLASS_JOINS = `
  FROM classes c
  JOIN instructors i ON i.id = c.instructor_id
  LEFT JOIN institutions inst ON inst.id = c.institution_id
`;

async function getInstructorByUserId(userId) {
  const { rows } = await query(`SELECT * FROM instructors WHERE user_id = $1`, [userId]);
  if (!rows.length) throw notFound('Instructor profile not found');
  return rows[0];
}

async function getInstructorById(id) {
  const { rows } = await query(`SELECT * FROM instructors WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Instructor not found');
  const extras = await loadInstructorExtras(id);
  return serializeInstructorFull(rows[0], extras.certifications, extras.schedule);
}

async function updateInstructorMe(userId, updates) {
  const validated = validateInstructorProfile(updates);
  const instructor = await getInstructorByUserId(userId);

  const fieldMap = {
    displayName: 'display_name',
    bio: 'bio',
    photoUrl: 'photo_url',
    disciplines: 'disciplines',
    hourlyRate: null,
    plan: 'plan',
  };

  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, col] of Object.entries(fieldMap)) {
    if (validated[key] === undefined) continue;
    if (key === 'hourlyRate') {
      if (validated.hourlyRate) {
        sets.push(`hourly_rate_cents = $${i++}`, `hourly_rate_currency = $${i++}`);
        values.push(validated.hourlyRate.amount, validated.hourlyRate.currency || 'UYU');
      } else {
        sets.push(`hourly_rate_cents = NULL`, `hourly_rate_currency = NULL`);
      }
      continue;
    }
    sets.push(`${col} = $${i++}`);
    values.push(validated[key]);
  }

  if (validated.certifications) {
    await query(`DELETE FROM instructor_certifications WHERE instructor_id = $1`, [instructor.id]);
    for (const cert of validated.certifications) {
      await query(
        `INSERT INTO instructor_certifications (instructor_id, name, issuer, year)
         VALUES ($1, $2, $3, $4)`,
        [instructor.id, cert.name, cert.issuer, cert.year],
      );
    }
  }

  if (validated.weeklySchedule) {
    for (const day of validated.weeklySchedule) {
      await query(
        `INSERT INTO instructor_schedule (instructor_id, weekday, enabled, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (instructor_id, weekday)
         DO UPDATE SET enabled = EXCLUDED.enabled, start_time = EXCLUDED.start_time,
                       end_time = EXCLUDED.end_time`,
        [instructor.id, day.weekday, day.enabled, day.startTime, day.endTime],
      );
    }
  }

  if (sets.length) {
    sets.push('updated_at = now()');
    values.push(instructor.id);
    await query(
      `UPDATE instructors SET ${sets.join(', ')} WHERE id = $${i}`,
      values,
    );
  }

  return getInstructorById(instructor.id);
}

async function listMyInvites(userId) {
  const { rows: users } = await query(`SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL`, [
    userId,
  ]);
  if (!users.length) throw notFound('User not found');

  const { rows } = await query(
    `SELECT inv.id, inv.message, inv.status, inv.sent_at,
            inst.id AS institution_id, inst.name AS institution_name
     FROM institution_instructor_invites inv
     JOIN institutions inst ON inst.id = inv.institution_id
     WHERE inv.email = $1 AND inv.status = 'pending'
     ORDER BY inv.sent_at DESC`,
    [users[0].email],
  );

  return rows.map((r) => ({
    id: r.id,
    institutionId: r.institution_id,
    institutionName: r.institution_name,
    message: r.message,
    status: r.status,
    sentAt: r.sent_at.toISOString(),
  }));
}

async function acceptInvite(userId, inviteId) {
  const { rows: users } = await query(`SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL`, [
    userId,
  ]);
  if (!users.length) throw notFound('User not found');

  const instructor = await getInstructorByUserId(userId);

  const { rows: invites } = await query(
    `SELECT inv.id, inv.institution_id, inst.name AS institution_name
     FROM institution_instructor_invites inv
     JOIN institutions inst ON inst.id = inv.institution_id
     WHERE inv.id = $1 AND inv.email = $2 AND inv.status = 'pending'`,
    [inviteId, users[0].email],
  );
  if (!invites.length) throw notFound('Invite not found');

  const invite = invites[0];

  await query(
    `INSERT INTO institution_instructors (institution_id, instructor_id, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (institution_id, instructor_id)
     DO UPDATE SET status = 'active', linked_at = now()`,
    [invite.institution_id, instructor.id],
  );

  await query(
    `UPDATE institution_instructor_invites
     SET status = 'accepted', accepted_at = now()
     WHERE id = $1`,
    [inviteId],
  );

  return {
    institutionId: invite.institution_id,
    institutionName: invite.institution_name,
  };
}

async function setAvailableNow(userId, availableNow) {
  const instructor = await getInstructorByUserId(userId);
  await query(`UPDATE instructors SET available_now = $1, updated_at = now() WHERE id = $2`, [
    availableNow,
    instructor.id,
  ]);
  return { availableNow };
}

async function getInstructorMe(userId) {
  const instructor = await getInstructorByUserId(userId);
  return getInstructorById(instructor.id);
}

async function listInstructors() {
  const { rows } = await require('../db/pool').query(
    `SELECT id, display_name, disciplines, verified, average_rating, review_count
     FROM instructors ORDER BY display_name ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    disciplines: r.disciplines,
    verified: r.verified,
    averageRating: Number(r.average_rating),
    reviewCount: r.review_count,
  }));
}

module.exports = {
  getInstructorById,
  getInstructorMe,
  updateInstructorMe,
  listMyInvites,
  acceptInvite,
  setAvailableNow,
  getInstructorByUserId,
  listInstructors,
  CLASS_SELECT,
  CLASS_JOINS,
};
