const { query } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const { normalizeDisciplineList } = require('../config/disciplines');
const institutionsService = require('./institutions.service');
const { getInstructorByUserId } = require('./instructors.service');
const { validateJobPosting, validateJobApplication } = require('../utils/validation');

function serializeJob(row, institution = null) {
  return {
    id: row.id,
    institutionId: row.institution_id,
    institutionName: institution?.name ?? row.institution_name,
    institutionLogoUrl: institution?.logo_url ?? row.institution_logo_url ?? undefined,
    title: row.title,
    roleType: row.role_type,
    description: row.description || '',
    disciplines: normalizeDisciplineList(row.disciplines || []),
    status: row.status,
    expiresAt: row.expires_at?.toISOString() ?? undefined,
    applicationCount: row.application_count != null ? Number(row.application_count) : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function serializeApplication(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    instructorId: row.instructor_id,
    instructorName: row.instructor_name,
    instructorPhotoUrl: row.instructor_photo_url || undefined,
    message: row.message || '',
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

async function listJobsForInstitution(userId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT jp.*, i.name AS institution_name, i.logo_url AS institution_logo_url,
            (SELECT COUNT(*)::int FROM job_applications ja WHERE ja.job_id = jp.id) AS application_count
     FROM job_postings jp
     JOIN institutions i ON i.id = jp.institution_id
     WHERE jp.institution_id = $1
     ORDER BY jp.created_at DESC`,
    [institution.id],
  );
  return rows.map((row) => serializeJob(row));
}

async function createJob(userId, body) {
  const validated = validateJobPosting(body);
  const institution = await institutionsService.getInstitutionByUserId(userId);

  const { rows } = await query(
    `INSERT INTO job_postings (
      institution_id, title, role_type, description, disciplines, status, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      institution.id,
      validated.title,
      validated.roleType,
      validated.description,
      validated.disciplines,
      validated.status,
      validated.expiresAt ?? null,
    ],
  );

  return serializeJob(rows[0], institution);
}

async function getJobForInstitution(userId, jobId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT jp.*, i.name AS institution_name, i.logo_url AS institution_logo_url,
            (SELECT COUNT(*)::int FROM job_applications ja WHERE ja.job_id = jp.id) AS application_count
     FROM job_postings jp
     JOIN institutions i ON i.id = jp.institution_id
     WHERE jp.id = $1 AND jp.institution_id = $2`,
    [jobId, institution.id],
  );
  if (!rows.length) throw notFound('Job posting not found');
  return serializeJob(rows[0]);
}

async function updateJob(userId, jobId, body) {
  const validated = validateJobPosting(body, { partial: true });
  const institution = await institutionsService.getInstitutionByUserId(userId);
  await getJobForInstitution(userId, jobId);

  const fieldMap = {
    title: 'title',
    roleType: 'role_type',
    description: 'description',
    disciplines: 'disciplines',
    status: 'status',
    expiresAt: 'expires_at',
  };

  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(fieldMap)) {
    if (validated[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(validated[key]);
    }
  }
  if (!sets.length) throw badRequest('No valid fields to update');

  sets.push('updated_at = now()');
  values.push(jobId, institution.id);

  const { rows } = await query(
    `UPDATE job_postings SET ${sets.join(', ')}
     WHERE id = $${i++} AND institution_id = $${i}
     RETURNING *`,
    values,
  );

  return serializeJob(rows[0], institution);
}

async function deleteJob(userId, jobId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rowCount } = await query(
    `DELETE FROM job_postings WHERE id = $1 AND institution_id = $2`,
    [jobId, institution.id],
  );
  if (!rowCount) throw notFound('Job posting not found');
}

async function listApplicationsForJob(userId, jobId) {
  await getJobForInstitution(userId, jobId);
  const { rows } = await query(
    `SELECT ja.*, i.display_name AS instructor_name, i.photo_url AS instructor_photo_url
     FROM job_applications ja
     JOIN instructors i ON i.id = ja.instructor_id
     WHERE ja.job_id = $1
     ORDER BY ja.created_at DESC`,
    [jobId],
  );
  return rows.map(serializeApplication);
}

async function listOpenJobs(queryParams = {}) {
  const q = typeof queryParams.q === 'string' ? queryParams.q.trim() : '';
  const values = [];
  let searchSql = '';
  if (q) {
    values.push(`%${q}%`);
    searchSql = `AND (jp.title ILIKE $${values.length} OR jp.description ILIKE $${values.length})`;
  }

  const { rows } = await query(
    `SELECT jp.*, i.name AS institution_name, i.logo_url AS institution_logo_url
     FROM job_postings jp
     JOIN institutions i ON i.id = jp.institution_id
     WHERE jp.status = 'open'
       AND (jp.expires_at IS NULL OR jp.expires_at > now())
       ${searchSql}
     ORDER BY jp.created_at DESC
     LIMIT 100`,
    values,
  );
  return rows.map((row) => serializeJob(row));
}

async function getOpenJob(jobId) {
  const { rows } = await query(
    `SELECT jp.*, i.name AS institution_name, i.logo_url AS institution_logo_url
     FROM job_postings jp
     JOIN institutions i ON i.id = jp.institution_id
     WHERE jp.id = $1 AND jp.status = 'open'
       AND (jp.expires_at IS NULL OR jp.expires_at > now())`,
    [jobId],
  );
  if (!rows.length) throw notFound('Job posting not found');
  return serializeJob(rows[0]);
}

async function applyToJob(user, jobId, body) {
  if (user.role !== 'instructor') {
    throw forbidden('Only instructors can apply to jobs');
  }
  const validated = validateJobApplication(body);
  const instructor = await getInstructorByUserId(user.id);
  await getOpenJob(jobId);

  const { rows: existing } = await query(
    `SELECT id FROM job_applications WHERE job_id = $1 AND instructor_id = $2`,
    [jobId, instructor.id],
  );
  if (existing.length) {
    throw conflict('ALREADY_APPLIED', 'You already applied to this job');
  }

  const { rows } = await query(
    `INSERT INTO job_applications (job_id, instructor_id, message)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [jobId, instructor.id, validated.message],
  );

  const { rows: enriched } = await query(
    `SELECT ja.*, i.display_name AS instructor_name, i.photo_url AS instructor_photo_url
     FROM job_applications ja
     JOIN instructors i ON i.id = ja.instructor_id
     WHERE ja.id = $1`,
    [rows[0].id],
  );

  return serializeApplication(enriched[0]);
}

async function listMyApplications(userId) {
  const instructor = await getInstructorByUserId(userId);
  const { rows } = await query(
    `SELECT ja.*, i.display_name AS instructor_name, i.photo_url AS instructor_photo_url,
            jp.title AS job_title, jp.status AS job_status, inst.name AS institution_name
     FROM job_applications ja
     JOIN job_postings jp ON jp.id = ja.job_id
     JOIN institutions inst ON inst.id = jp.institution_id
     JOIN instructors i ON i.id = ja.instructor_id
     WHERE ja.instructor_id = $1
     ORDER BY ja.created_at DESC`,
    [instructor.id],
  );

  return rows.map((row) => ({
    ...serializeApplication(row),
    jobTitle: row.job_title,
    jobStatus: row.job_status,
    institutionName: row.institution_name,
  }));
}

module.exports = {
  listJobsForInstitution,
  createJob,
  getJobForInstitution,
  updateJob,
  deleteJob,
  listApplicationsForJob,
  listOpenJobs,
  getOpenJob,
  applyToJob,
  listMyApplications,
};
