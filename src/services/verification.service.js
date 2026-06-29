const { query } = require('../db/pool');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const { saveDocument, readDocument } = require('./verification-storage.service');
const { getInstructorByUserId } = require('./instructors.service');
const { getInstitutionByUserId } = require('./institutions.service');
const {
  sendVerificationReceivedEmail,
  sendVerificationApprovedEmail,
  sendVerificationRejectedEmail,
  sendVerificationPendingReminderEmail,
} = require('./email.service');
const {
  notifyVerificationApproved,
  notifyVerificationRejected,
} = require('./notifications.service');

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const REQUIRED_DOCS = ['dni_front', 'dni_back', 'certification'];

function verificationBusinessDays() {
  const n = Number(process.env.VERIFICATION_REVIEW_BUSINESS_DAYS || 5);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function serializeDocument(row) {
  return {
    id: row.id,
    documentType: row.document_type,
    mimeType: row.mime_type,
    originalName: row.original_name || undefined,
    createdAt: row.created_at.toISOString(),
  };
}

function serializeRequest(row, documents = []) {
  return {
    id: row.id,
    subjectType: row.subject_type,
    instructorId: row.instructor_id || undefined,
    institutionId: row.institution_id || undefined,
    subjectName: row.instructor_name || row.institution_name || undefined,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : undefined,
    rejectionReason: row.rejection_reason || undefined,
    documents,
  };
}

async function resolveSubjectForUser(user) {
  if (user.role === 'instructor') {
    const instructor = await getInstructorByUserId(user.id);
    return {
      subjectType: 'instructor',
      subjectId: instructor.id,
      profileTable: 'instructors',
      userId: user.id,
      displayName: instructor.display_name,
      email: user.email,
      verificationStatus: instructor.verification_status || 'unverified',
    };
  }
  if (user.role === 'institution') {
    const institution = await getInstitutionByUserId(user.id);
    return {
      subjectType: 'institution',
      subjectId: institution.id,
      profileTable: 'institutions',
      userId: user.id,
      displayName: institution.name,
      email: user.email,
      verificationStatus: institution.verification_status || 'unverified',
    };
  }
  throw forbidden('Only instructors and institutions can request verification');
}

async function getLatestRequest(subjectType, subjectId) {
  const col = subjectType === 'instructor' ? 'instructor_id' : 'institution_id';
  const { rows } = await query(
    `SELECT vr.*,
            i.display_name AS instructor_name,
            inst.name AS institution_name
     FROM verification_requests vr
     LEFT JOIN instructors i ON i.id = vr.instructor_id
     LEFT JOIN institutions inst ON inst.id = vr.institution_id
     WHERE vr.${col} = $1
     ORDER BY vr.submitted_at DESC
     LIMIT 1`,
    [subjectId],
  );
  return rows[0] || null;
}

async function getVerificationStatusForUser(user) {
  const subject = await resolveSubjectForUser(user);
  const latest = await getLatestRequest(subject.subjectType, subject.subjectId);

  return {
    verificationStatus: subject.verificationStatus,
    verified: subject.verificationStatus === 'verified',
    latestRequest: latest
      ? {
          id: latest.id,
          status: latest.status,
          submittedAt: latest.submitted_at.toISOString(),
          reviewedAt: latest.reviewed_at ? latest.reviewed_at.toISOString() : undefined,
          rejectionReason: latest.rejection_reason || undefined,
        }
      : null,
  };
}

async function submitVerification(user, files) {
  const subject = await resolveSubjectForUser(user);

  if (subject.verificationStatus === 'verified') {
    throw conflict('ALREADY_VERIFIED', 'Your profile is already verified');
  }

  const pendingCol = subject.subjectType === 'instructor' ? 'instructor_id' : 'institution_id';
  const { rows: pending } = await query(
    `SELECT id FROM verification_requests
     WHERE status = 'pending' AND ${pendingCol} = $1`,
    [subject.subjectId],
  );
  if (pending.length) {
    throw conflict('VERIFICATION_PENDING', 'You already have a verification request under review');
  }

  for (const docType of REQUIRED_DOCS) {
    const file = files[docType];
    if (!file) {
      throw badRequest(`Missing required document: ${docType}`);
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      throw badRequest(`Unsupported file type for ${docType}`);
    }
  }

  const client = await require('../db/pool').pool.connect();
  try {
    await client.query('BEGIN');

    const insertCols =
      subject.subjectType === 'instructor'
        ? `(subject_type, instructor_id, status)`
        : `(subject_type, institution_id, status)`;
    const insertVals =
      subject.subjectType === 'instructor'
        ? `('instructor', $1, 'pending')`
        : `('institution', $1, 'pending')`;

    const reqResult = await client.query(
      `INSERT INTO verification_requests ${insertCols} VALUES ${insertVals} RETURNING *`,
      [subject.subjectId],
    );
    const request = reqResult.rows[0];

    for (const docType of REQUIRED_DOCS) {
      const file = files[docType];
      const storageKey = await saveDocument({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        documentType: docType,
        buffer: file.buffer,
        mimeType: file.mimetype,
      });

      await client.query(
        `INSERT INTO verification_documents
         (verification_request_id, document_type, storage_key, mime_type, original_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [request.id, docType, storageKey, file.mimetype, file.originalname || null],
      );
    }

    await client.query(
      `UPDATE ${subject.profileTable}
       SET verification_status = 'pending', updated_at = now()
       WHERE id = $1`,
      [subject.subjectId],
    );

    await client.query('COMMIT');

    await sendVerificationReceivedEmail({
      to: subject.email,
      displayName: subject.displayName,
      businessDays: verificationBusinessDays(),
    });

    return {
      id: request.id,
      status: 'pending',
      verificationStatus: 'pending',
      submittedAt: request.submitted_at.toISOString(),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listPendingForAdmin() {
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

  const results = [];
  for (const row of rows) {
    const { rows: docs } = await query(
      `SELECT id, document_type, mime_type, original_name, created_at
       FROM verification_documents WHERE verification_request_id = $1
       ORDER BY document_type`,
      [row.id],
    );
    results.push(serializeRequest(row, docs.map(serializeDocument)));
  }
  return results;
}

async function getRequestForAdmin(id) {
  const { rows } = await query(
    `SELECT vr.*,
            i.display_name AS instructor_name,
            inst.name AS institution_name
     FROM verification_requests vr
     LEFT JOIN instructors i ON i.id = vr.instructor_id
     LEFT JOIN institutions inst ON inst.id = vr.institution_id
     WHERE vr.id = $1`,
    [id],
  );
  if (!rows.length) throw notFound('Verification request not found');

  const { rows: docs } = await query(
    `SELECT id, document_type, mime_type, original_name, created_at
     FROM verification_documents WHERE verification_request_id = $1
     ORDER BY document_type`,
    [id],
  );
  return serializeRequest(rows[0], docs.map(serializeDocument));
}

async function getDocumentForAdmin(requestId, documentId) {
  const { rows } = await query(
    `SELECT vd.*, vr.id AS request_id
     FROM verification_documents vd
     JOIN verification_requests vr ON vr.id = vd.verification_request_id
     WHERE vd.id = $1 AND vr.id = $2`,
    [documentId, requestId],
  );
  if (!rows.length) throw notFound('Document not found');

  const stored = await readDocument(rows[0].storage_key);
  if (!stored) throw notFound('Document file not found');

  return {
    buffer: stored.buffer,
    mimeType: rows[0].mime_type || stored.mimeType || 'application/octet-stream',
    originalName: rows[0].original_name || rows[0].document_type,
  };
}

async function resolveSubjectUserId(request) {
  if (request.instructor_id) {
    const { rows } = await query(`SELECT user_id, display_name FROM instructors WHERE id = $1`, [
      request.instructor_id,
    ]);
    if (!rows.length) return null;
    const { rows: users } = await query(`SELECT email FROM users WHERE id = $1`, [rows[0].user_id]);
    return {
      userId: rows[0].user_id,
      email: users[0]?.email,
      displayName: rows[0].display_name,
      profileTable: 'instructors',
      subjectId: request.instructor_id,
    };
  }
  if (request.institution_id) {
    const { rows } = await query(`SELECT user_id, name FROM institutions WHERE id = $1`, [
      request.institution_id,
    ]);
    if (!rows.length) return null;
    const { rows: users } = await query(`SELECT email FROM users WHERE id = $1`, [rows[0].user_id]);
    return {
      userId: rows[0].user_id,
      email: users[0]?.email,
      displayName: rows[0].name,
      profileTable: 'institutions',
      subjectId: request.institution_id,
    };
  }
  return null;
}

async function approveVerification(adminId, id) {
  const { rows } = await query(`SELECT * FROM verification_requests WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Verification request not found');
  const req = rows[0];
  if (req.status !== 'pending') {
    throw badRequest('Only pending requests can be approved');
  }

  await query(
    `UPDATE verification_requests
     SET status = 'approved', reviewed_at = now(), reviewed_by = $1
     WHERE id = $2`,
    [adminId, id],
  );

  if (req.instructor_id) {
    await query(
      `UPDATE instructors SET verified = TRUE, verification_status = 'verified', updated_at = now()
       WHERE id = $1`,
      [req.instructor_id],
    );
  }
  if (req.institution_id) {
    await query(
      `UPDATE institutions SET verified = TRUE, verification_status = 'verified', updated_at = now()
       WHERE id = $1`,
      [req.institution_id],
    );
  }

  const subject = await resolveSubjectUserId(req);
  if (subject?.email) {
    await sendVerificationApprovedEmail({
      to: subject.email,
      displayName: subject.displayName,
    });
  }
  if (subject?.userId) {
    await notifyVerificationApproved({ userId: subject.userId, displayName: subject.displayName });
  }

  return { id, status: 'approved' };
}

async function rejectVerification(adminId, id, reason) {
  const rejectionReason = reason?.trim();
  if (!rejectionReason) {
    throw badRequest('Rejection reason is required');
  }

  const { rows } = await query(`SELECT * FROM verification_requests WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Verification request not found');
  const req = rows[0];
  if (req.status !== 'pending') {
    throw badRequest('Only pending requests can be rejected');
  }

  await query(
    `UPDATE verification_requests
     SET status = 'rejected',
         reviewed_at = now(),
         reviewed_by = $1,
         rejection_reason = $2,
         notes = $2
     WHERE id = $3`,
    [adminId, rejectionReason, id],
  );

  if (req.instructor_id) {
    await query(
      `UPDATE instructors SET verified = FALSE, verification_status = 'rejected', updated_at = now()
       WHERE id = $1`,
      [req.instructor_id],
    );
  }
  if (req.institution_id) {
    await query(
      `UPDATE institutions SET verified = FALSE, verification_status = 'rejected', updated_at = now()
       WHERE id = $1`,
      [req.institution_id],
    );
  }

  const subject = await resolveSubjectUserId(req);
  if (subject?.email) {
    await sendVerificationRejectedEmail({
      to: subject.email,
      displayName: subject.displayName,
      reason: rejectionReason,
    });
  }
  if (subject?.userId) {
    await notifyVerificationRejected({
      userId: subject.userId,
      displayName: subject.displayName,
      reason: rejectionReason,
    });
  }

  return { id, status: 'rejected' };
}

async function processPendingReminders() {
  const { rows } = await query(
    `SELECT vr.id, vr.instructor_id, vr.institution_id, vr.submitted_at
     FROM verification_requests vr
     WHERE vr.status = 'pending'
       AND vr.reminder_sent_at IS NULL
       AND vr.submitted_at <= now() - interval '7 days'`,
  );

  for (const row of rows) {
    const subject = await resolveSubjectUserId(row);
    if (!subject?.email) continue;

    const sent = await sendVerificationPendingReminderEmail({
      to: subject.email,
      displayName: subject.displayName,
    });
    if (sent.sent) {
      await query(`UPDATE verification_requests SET reminder_sent_at = now() WHERE id = $1`, [
        row.id,
      ]);
    }
  }
}

module.exports = {
  getVerificationStatusForUser,
  submitVerification,
  listPendingForAdmin,
  getRequestForAdmin,
  getDocumentForAdmin,
  approveVerification,
  rejectVerification,
  processPendingReminders,
  ALLOWED_MIMES,
  REQUIRED_DOCS,
};
