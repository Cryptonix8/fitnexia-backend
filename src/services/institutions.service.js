const { query } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const { validateInstitutionProfile } = require('../utils/validation');
const { loadInstitutionExtras } = require('./auth.service');
const { sendInstructorInviteEmail } = require('./email.service');
const { serializeInstitutionFull } = require('../utils/serializers');

async function getInstitutionByUserId(userId) {
  const { rows } = await query(`SELECT * FROM institutions WHERE user_id = $1`, [userId]);
  if (!rows.length) throw notFound('Institution profile not found');
  return rows[0];
}

async function getInstitutionById(id) {
  const { rows } = await query(`SELECT * FROM institutions WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Institution not found');
  const extras = await loadInstitutionExtras(id);
  return serializeInstitutionFull(rows[0], extras.gallery, extras.instructors);
}

async function getInstitutionMe(userId) {
  const institution = await getInstitutionByUserId(userId);
  return getInstitutionById(institution.id);
}

async function updateInstitutionMe(userId, updates) {
  const validated = validateInstitutionProfile(updates);
  const institution = await getInstitutionByUserId(userId);

  const fieldMap = {
    name: 'name',
    description: 'description',
    logoUrl: 'logo_url',
    address: 'address',
    city: 'city',
    country: 'country',
    lat: 'lat',
    lng: 'lng',
    contactPhone: 'contact_phone',
    contactEmail: 'contact_email',
    website: 'website',
    openingHours: 'opening_hours',
  };

  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, col] of Object.entries(fieldMap)) {
    if (validated[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(
        key === 'openingHours' ? JSON.stringify(validated[key]) : validated[key],
      );
    }
  }

  if (validated.location) {
    const loc = validated.location;
    if (loc.address !== undefined) {
      sets.push(`address = $${i++}`);
      values.push(loc.address);
    }
    if (loc.city !== undefined) {
      sets.push(`city = $${i++}`);
      values.push(loc.city);
    }
    if (loc.country !== undefined) {
      sets.push(`country = $${i++}`);
      values.push(loc.country);
    }
    if (loc.lat !== undefined) {
      sets.push(`lat = $${i++}`);
      values.push(loc.lat);
    }
    if (loc.lng !== undefined) {
      sets.push(`lng = $${i++}`);
      values.push(loc.lng);
    }
  }

  if (validated.gallery) {
    await query(`DELETE FROM institution_gallery WHERE institution_id = $1`, [institution.id]);
    for (let idx = 0; idx < validated.gallery.length; idx++) {
      await query(
        `INSERT INTO institution_gallery (institution_id, url, sort_order) VALUES ($1, $2, $3)`,
        [institution.id, validated.gallery[idx], idx],
      );
    }
  }

  if (sets.length) {
    sets.push('updated_at = now()');
    values.push(institution.id);
    await query(`UPDATE institutions SET ${sets.join(', ')} WHERE id = $${i}`, values);
  }

  return getInstitutionById(institution.id);
}

async function listLinkedInstructors(userId) {
  const institution = await getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT i.id, i.display_name, i.disciplines, i.verified, i.average_rating, i.review_count
     FROM institution_instructors ii
     JOIN instructors i ON i.id = ii.instructor_id
     WHERE ii.institution_id = $1 AND ii.status = 'active'
     ORDER BY i.display_name`,
    [institution.id],
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

async function linkInstructor(userId, instructorId) {
  const institution = await getInstitutionByUserId(userId);

  const { rows: instructors } = await query(`SELECT id FROM instructors WHERE id = $1`, [
    instructorId,
  ]);
  if (!instructors.length) throw notFound('Instructor not found');

  await query(
    `INSERT INTO institution_instructors (institution_id, instructor_id, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (institution_id, instructor_id)
     DO UPDATE SET status = 'active', linked_at = now()`,
    [institution.id, instructorId],
  );

  return listLinkedInstructors(userId);
}

async function unlinkInstructor(userId, instructorId) {
  const institution = await getInstitutionByUserId(userId);
  await query(
    `UPDATE institution_instructors SET status = 'removed'
     WHERE institution_id = $1 AND instructor_id = $2`,
    [institution.id, instructorId],
  );
}

async function resolveInviteEmail({ email, instructorId }) {
  if (instructorId) {
    const { rows } = await query(
      `SELECT u.email
       FROM instructors i
       JOIN users u ON u.id = i.user_id AND u.deleted_at IS NULL
       WHERE i.id = $1`,
      [instructorId],
    );
    if (!rows.length) throw notFound('Instructor not found');
    return { email: rows[0].email, instructorId };
  }

  const { validateEmailField } = require('../utils/validation');
  const emailError = validateEmailField(email);
  if (emailError) throw badRequest(emailError.message, { errors: [emailError] });
  return { email: email.trim().toLowerCase(), instructorId: null };
}

async function inviteInstructor(userId, input) {
  const institution = await getInstitutionByUserId(userId);
  const { email: resolvedEmail, instructorId } = await resolveInviteEmail(input ?? {});
  const normalizedEmail = resolvedEmail.toLowerCase();
  const message = input?.message;

  if (instructorId) {
    const { rows: linked } = await query(
      `SELECT 1 FROM institution_instructors
       WHERE institution_id = $1 AND instructor_id = $2 AND status = 'active'`,
      [institution.id, instructorId],
    );
    if (linked.length) {
      throw conflict('ALREADY_LINKED', 'This instructor is already on your staff');
    }
  }

  const { rows: pending } = await query(
    `SELECT id FROM institution_instructor_invites
     WHERE institution_id = $1 AND email = $2 AND status = 'pending'`,
    [institution.id, normalizedEmail],
  );
  if (pending.length) {
    throw conflict('INVITE_EXISTS', 'An invite is already pending for this email');
  }

  const { rows } = await query(
    `INSERT INTO institution_instructor_invites (institution_id, email, message)
     VALUES ($1, $2, $3)
     RETURNING id, email, message, status, sent_at`,
    [institution.id, normalizedEmail, message || null],
  );

  const invite = rows[0];
  const emailResult = await sendInstructorInviteEmail({
    to: invite.email,
    institutionName: institution.name,
    personalMessage: invite.message,
  });

  const notificationsService = require('./notifications.service');
  notificationsService
    .notifyInstructorInvite({
      inviteId: invite.id,
      email: invite.email,
      institutionName: institution.name,
    })
    .catch((err) => console.warn('[institutions] invite push failed:', err.message));

  return {
    id: invite.id,
    email: invite.email,
    message: invite.message,
    status: invite.status,
    sentAt: invite.sent_at.toISOString(),
    emailSent: emailResult.sent,
    emailError: emailResult.sent ? undefined : emailResult.reason,
  };
}

async function listInvites(userId) {
  const institution = await getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT id, email, message, status, sent_at
     FROM institution_instructor_invites
     WHERE institution_id = $1 AND status = 'pending'
     ORDER BY sent_at DESC`,
    [institution.id],
  );

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    message: r.message,
    status: r.status,
    sentAt: r.sent_at.toISOString(),
  }));
}

async function getStaffRoster(userId) {
  const institution = await getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT i.id,
            i.display_name,
            i.photo_url,
            i.disciplines,
            i.verified,
            i.average_rating,
            i.review_count,
            ii.status AS link_status,
            inv.id AS invite_id,
            sr.id AS staff_review_id,
            sr.rating AS staff_review_rating,
            EXISTS (
              SELECT 1 FROM classes c
              WHERE c.institution_id = $1
                AND c.instructor_id = i.id
                AND c.cancelled_at IS NULL
                AND c.start_at + (c.duration_minutes * interval '1 minute') < now()
            ) AS has_completed_class
     FROM instructors i
     JOIN users u ON u.id = i.user_id AND u.deleted_at IS NULL
     LEFT JOIN institution_instructors ii
       ON ii.instructor_id = i.id
      AND ii.institution_id = $1
      AND ii.status = 'active'
     LEFT JOIN institution_instructor_invites inv
       ON inv.email = u.email
      AND inv.institution_id = $1
      AND inv.status = 'pending'
     LEFT JOIN staff_reviews sr
       ON sr.institution_id = $1
      AND sr.instructor_id = i.id
     ORDER BY i.display_name ASC`,
    [institution.id],
  );

  return rows.map((r) => {
    let staffStatus = 'none';
    let inviteId;
    if (r.link_status === 'active') {
      staffStatus = 'linked';
    } else if (r.invite_id) {
      staffStatus = 'pending';
      inviteId = r.invite_id;
    }

    const hasCompletedClass = Boolean(r.has_completed_class);
    const staffReview = r.staff_review_id
      ? { id: r.staff_review_id, rating: r.staff_review_rating }
      : null;

    return {
      id: r.id,
      displayName: r.display_name,
      photoUrl: r.photo_url || undefined,
      disciplines: r.disciplines,
      verified: r.verified,
      averageRating: Number(r.average_rating),
      reviewCount: r.review_count,
      staffStatus,
      inviteId,
      hasCompletedClass,
      staffReview,
      canLeaveStaffReview:
        staffStatus === 'linked' && hasCompletedClass && !staffReview,
    };
  });
}

async function cancelInvite(userId, inviteId) {
  const institution = await getInstitutionByUserId(userId);
  const { rows } = await query(
    `UPDATE institution_instructor_invites
     SET status = 'cancelled'
     WHERE id = $1 AND institution_id = $2 AND status = 'pending'
     RETURNING id`,
    [inviteId, institution.id],
  );
  if (!rows.length) throw notFound('Invite not found');
}

async function assertInstructorLinked(institutionId, instructorId) {
  const { rows } = await query(
    `SELECT 1 FROM institution_instructors
     WHERE institution_id = $1 AND instructor_id = $2 AND status = 'active'`,
    [institutionId, instructorId],
  );
  if (!rows.length) {
    throw forbidden('Instructor is not linked to this institution');
  }
}

async function hasCompletedClassWithInstructor(institutionId, instructorId) {
  const { rows } = await query(
    `SELECT 1 FROM classes c
     WHERE c.institution_id = $1
       AND c.instructor_id = $2
       AND c.cancelled_at IS NULL
       AND c.start_at + (c.duration_minutes * interval '1 minute') < now()
     LIMIT 1`,
    [institutionId, instructorId],
  );
  return rows.length > 0;
}

async function assertCompletedClassWithInstructor(institutionId, instructorId) {
  const ok = await hasCompletedClassWithInstructor(institutionId, instructorId);
  if (!ok) {
    throw badRequest(
      'You can only review an instructor after they have taught a completed class at your gym',
    );
  }
}

async function getStaffReviewEligibility(userId, instructorId) {
  const institution = await getInstitutionByUserId(userId);

  const { rows: links } = await query(
    `SELECT 1 FROM institution_instructors
     WHERE institution_id = $1 AND instructor_id = $2 AND status = 'active'`,
    [institution.id, instructorId],
  );
  const linked = links.length > 0;

  const hasCompletedClass = linked
    ? await hasCompletedClassWithInstructor(institution.id, instructorId)
    : false;

  const { rows: reviews } = await query(
    `SELECT id, rating, comment, created_at
     FROM staff_reviews
     WHERE institution_id = $1 AND instructor_id = $2`,
    [institution.id, instructorId],
  );

  const existingReview = reviews.length
    ? {
        id: reviews[0].id,
        rating: reviews[0].rating,
        comment: reviews[0].comment || undefined,
        createdAt: reviews[0].created_at.toISOString(),
      }
    : null;

  return {
    linked,
    hasCompletedClass,
    canLeaveReview: linked && hasCompletedClass && !existingReview,
    existingReview,
  };
}

module.exports = {
  getInstitutionById,
  getInstitutionMe,
  getInstitutionByUserId,
  updateInstitutionMe,
  listLinkedInstructors,
  linkInstructor,
  unlinkInstructor,
  inviteInstructor,
  listInvites,
  getStaffRoster,
  getStaffReviewEligibility,
  cancelInvite,
  assertInstructorLinked,
  assertCompletedClassWithInstructor,
};
