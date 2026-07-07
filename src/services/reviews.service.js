const { query } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const {
  getInstitutionByUserId,
  assertInstructorLinked,
  assertCompletedClassWithInstructor,
} = require('./institutions.service');
const { completePastBooking } = require('./bookings.service');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value, label = 'id') {
  if (!UUID_RE.test(String(value))) {
    throw badRequest(`Invalid ${label}`);
  }
}

async function createReview(user, body) {
  const { bookingId, rating, comment } = body;
  if (!bookingId || !rating) {
    throw badRequest('bookingId and rating are required');
  }
  if (rating < 1 || rating > 5) {
    throw badRequest('rating must be between 1 and 5');
  }

  const { rows: bookings } = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
  if (!bookings.length) throw notFound('Booking not found');
  let booking = bookings[0];

  if (booking.athlete_user_id !== user.id) {
    throw forbidden('Not your booking');
  }

  if (booking.status === 'confirmed') {
    const completed = await completePastBooking(bookingId);
    if (completed) booking = completed;
  }

  if (booking.status !== 'completed') {
    throw badRequest('You can only review completed bookings');
  }

  const { rows: existing } = await query(`SELECT id FROM reviews WHERE booking_id = $1`, [
    bookingId,
  ]);
  if (existing.length) {
    throw conflict('REVIEW_EXISTS', 'Review already submitted for this booking');
  }

  const { rows: classes } = await query(`SELECT instructor_id FROM classes WHERE id = $1`, [
    booking.class_id,
  ]);

  const { rows } = await query(
    `INSERT INTO reviews (booking_id, instructor_id, athlete_user_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, rating, comment, created_at`,
    [bookingId, classes[0].instructor_id, user.id, rating, comment || null],
  );

  const review = rows[0];
  return {
    id: review.id,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.created_at.toISOString(),
  };
}

async function listInstructorReviews(instructorId) {
  assertUuid(instructorId, 'instructor id');
  const { rows } = await query(
    `SELECT r.id, r.rating, r.comment, r.response, r.response_at, r.created_at,
            ap.first_name, ap.last_name
     FROM reviews r
     JOIN users u ON u.id = r.athlete_user_id
     LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
     WHERE r.instructor_id = $1 AND r.removed_at IS NULL
     ORDER BY r.created_at DESC`,
    [instructorId],
  );

  return rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    comment: r.comment || undefined,
    authorName: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Athlete',
    response: r.response || null,
    responseAt: r.response_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  }));
}

async function respondToReview(user, reviewId, body) {
  const comment = typeof body?.response === 'string' ? body.response.trim() : '';
  if (!comment) throw badRequest('response is required');

  const { rows } = await query(
    `SELECT r.*, i.user_id AS instructor_user_id
     FROM reviews r
     JOIN instructors i ON i.id = r.instructor_id
     WHERE r.id = $1 AND r.removed_at IS NULL`,
    [reviewId],
  );
  if (!rows.length) throw notFound('Review not found');
  const review = rows[0];

  if (user.role === 'instructor') {
    if (review.instructor_user_id !== user.id) {
      throw forbidden('Not your review');
    }
  } else if (user.role === 'institution') {
    const institution = await getInstitutionByUserId(user.id);
    const { rows: links } = await query(
      `SELECT 1 FROM institution_instructors
       WHERE institution_id = $1 AND instructor_id = $2 AND status = 'active'`,
      [institution.id, review.instructor_id],
    );
    if (!links.length) throw forbidden('Instructor is not linked to your institution');
  } else {
    throw forbidden('Only instructors or institutions can respond to reviews');
  }

  const { rows: updated } = await query(
    `UPDATE reviews SET response = $2, response_at = now()
     WHERE id = $1
     RETURNING id, rating, comment, response, response_at, created_at`,
    [reviewId, comment],
  );

  const r = updated[0];
  return {
    id: r.id,
    rating: r.rating,
    comment: r.comment || undefined,
    response: r.response,
    responseAt: r.response_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  };
}

async function reportReview(user, reviewId, body) {
  const id = String(reviewId ?? '').trim();
  if (!id) {
    throw badRequest('Review id is required');
  }

  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';

  const { rows } = await query(
    `SELECT id FROM reviews WHERE id = $1 AND removed_at IS NULL`,
    [id],
  );
  if (!rows.length) {
    throw notFound('Review not found');
  }

  await query(
    `INSERT INTO review_reports (review_id, reporter_user_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (review_id, reporter_user_id)
     DO UPDATE SET reason = EXCLUDED.reason, created_at = now()`,
    [id, user.id, reason || null],
  );

  return { ok: true };
}

async function createStaffReview(user, body) {
  const { instructorId, rating, comment } = body;
  if (!instructorId || !rating) {
    throw badRequest('instructorId and rating are required');
  }

  const institution = await getInstitutionByUserId(user.id);
  await assertInstructorLinked(institution.id, instructorId);
  await assertCompletedClassWithInstructor(institution.id, instructorId);

  const { rows: existing } = await query(
    `SELECT id FROM staff_reviews WHERE institution_id = $1 AND instructor_id = $2`,
    [institution.id, instructorId],
  );
  if (existing.length) {
    throw conflict('STAFF_REVIEW_EXISTS', 'Staff review already exists for this instructor');
  }

  const { rows } = await query(
    `INSERT INTO staff_reviews (institution_id, instructor_id, author_user_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [institution.id, instructorId, user.id, rating, comment || null],
  );

  const r = rows[0];
  return {
    id: r.id,
    instructorId: r.instructor_id,
    institutionId: r.institution_id,
    institutionName: institution.name,
    rating: r.rating,
    comment: r.comment || undefined,
    verified: r.verified,
    createdAt: r.created_at.toISOString(),
  };
}

async function listStaffReviewsForInstructor(instructorId) {
  const { rows } = await query(
    `SELECT sr.*, inst.name AS institution_name
     FROM staff_reviews sr
     JOIN institutions inst ON inst.id = sr.institution_id
     WHERE sr.instructor_id = $1
     ORDER BY sr.created_at DESC`,
    [instructorId],
  );

  return rows.map((r) => ({
    id: r.id,
    instructorId: r.instructor_id,
    institutionId: r.institution_id,
    institutionName: r.institution_name,
    rating: r.rating,
    comment: r.comment || undefined,
    verified: r.verified,
    createdAt: r.created_at.toISOString(),
  }));
}

module.exports = {
  createReview,
  listInstructorReviews,
  respondToReview,
  createStaffReview,
  listStaffReviewsForInstructor,
  reportReview,
};
