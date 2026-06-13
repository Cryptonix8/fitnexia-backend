const { query } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const { serializeBooking, serializeClassRow } = require('../utils/serializers');
const { CLASS_SELECT, CLASS_JOINS } = require('./instructors.service');
const { getClassRow } = require('./classes.service');
const paymentsService = require('./payments.service');
const passesService = require('./passes.service');
const marketplaceService = require('./marketplace.service');
const notificationsService = require('./notifications.service');

async function createBooking(user, body) {
  if (user.role !== 'athlete') {
    throw forbidden('Only athletes can create bookings');
  }

  const { classId, paymentModel = 'per_class', periodType } = body;
  if (!classId) throw badRequest('classId is required');

  if (paymentModel === 'per_period' && !periodType) {
    throw badRequest('periodType is required for per_period (week, month, quarter)');
  }

  await paymentsService.expireStalePendingBookings(classId);

  const classRow = await getClassRow(classId);

  const booked = await getBookingCount(classId);
  if (classRow.capacity != null && booked >= classRow.capacity) {
    throw conflict('CLASS_FULL', 'This class has no available spots.', {
      waitlistAvailable: false,
    });
  }

  const usePayments = paymentsService.isPaymentsActive();
  const isSubscriptionModel =
    paymentModel === 'monthly_unlimited' || paymentModel === 'per_period';

  let existingActivePass = null;
  if (isSubscriptionModel) {
    existingActivePass = await passesService.getActivePass(
      user.id,
      paymentModel,
      paymentModel === 'per_period' ? periodType : null,
    );
  }

  if (usePayments) {
    await marketplaceService.assertClassSellerCanReceivePayment(classRow, {
      isPassPurchase: isSubscriptionModel && !existingActivePass,
      usingActivePass: Boolean(existingActivePass),
    });
  }

  const client = await require('../db/pool').pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id FROM bookings
       WHERE class_id = $1 AND athlete_user_id = $2 AND status IN ('pending_payment', 'confirmed')`,
      [classId, user.id],
    );
    if (existing.rows.length) {
      throw conflict('BOOKING_EXISTS', 'You already have a booking for this class');
    }

    let initialStatus = 'confirmed';
    let athletePassId = null;
    let paymentResponse;

    if (isSubscriptionModel) {
      if (existingActivePass) {
        athletePassId = existingActivePass.id;
        initialStatus = 'confirmed';
      } else if (usePayments) {
        initialStatus = 'pending_payment';
      } else {
        throw badRequest('An active pass is required for this payment model');
      }
    } else if (usePayments) {
      initialStatus = 'pending_payment';
    }

    const { rows } = await client.query(
      `INSERT INTO bookings (
        class_id, athlete_user_id, status, payment_model, price_cents, price_currency, athlete_pass_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        classId,
        user.id,
        initialStatus,
        paymentModel,
        classRow.price_cents,
        classRow.price_currency,
        athletePassId,
      ],
    );

    const bookingRow = rows[0];

    if (isSubscriptionModel && athletePassId && initialStatus === 'confirmed') {
      const creditResult = await client.query(
        `UPDATE athlete_passes
         SET class_credits_used = class_credits_used + 1, updated_at = now()
         WHERE id = $1
           AND status = 'active'
           AND (class_credits_total IS NULL OR class_credits_used < class_credits_total)
         RETURNING id`,
        [athletePassId],
      );
      if (!creditResult.rows.length) {
        throw badRequest('Pass has no remaining class credits');
      }
      await marketplaceService.recordPassBookingLedger(bookingRow, classRow);
    } else if (isSubscriptionModel && initialStatus === 'pending_payment') {
      const { pass, product } = await passesService.createPendingPass(
        client,
        user.id,
        paymentModel,
        periodType,
      );
      await client.query(`UPDATE bookings SET athlete_pass_id = $1 WHERE id = $2`, [
        pass.id,
        bookingRow.id,
      ]);
      bookingRow.athlete_pass_id = pass.id;

      const paymentRow = await paymentsService.createPaymentForPass(
        client,
        pass,
        product,
        bookingRow.id,
        classRow,
      );
      paymentResponse = paymentsService.buildPaymentResponse(paymentRow, {
        passId: pass.id,
        paymentModel,
        periodType: pass.period_type || undefined,
      });
    } else if (!isSubscriptionModel && usePayments) {
      const paymentRow = await paymentsService.createPaymentForBooking(client, bookingRow, classRow);
      paymentResponse = paymentsService.buildPaymentResponse(paymentRow);
    }

    await client.query('COMMIT');

    const result = { booking: serializeBooking(bookingRow) };
    if (paymentResponse) {
      result.payment = paymentResponse;
    }

    if (bookingRow.status === 'confirmed') {
      notificationsService
        .notifyBookingConfirmed(bookingRow.id)
        .catch((err) => console.warn('[bookings] booking confirmed push failed:', err.message));
    }

    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const PAST_BOOKING_END_SQL =
  `c.start_at + (COALESCE(c.duration_minutes, 60) || ' minutes')::interval < now()`;

async function completePastBookings(athleteUserId) {
  await query(
    `UPDATE bookings b
     SET status = 'completed', completed_at = now()
     FROM classes c
     WHERE b.class_id = c.id
       AND b.athlete_user_id = $1
       AND b.status = 'confirmed'
       AND ${PAST_BOOKING_END_SQL}`,
    [athleteUserId],
  );
}

async function completePastBooking(bookingId) {
  const { rows } = await query(
    `UPDATE bookings b
     SET status = 'completed', completed_at = now()
     FROM classes c
     WHERE b.class_id = c.id
       AND b.id = $1
       AND b.status = 'confirmed'
       AND ${PAST_BOOKING_END_SQL}
     RETURNING b.*`,
    [bookingId],
  );
  return rows[0] || null;
}

async function loadBookingClass(classId) {
  const { rows } = await query(
    `SELECT ${CLASS_SELECT} ${CLASS_JOINS} WHERE c.id = $1`,
    [classId],
  );
  if (!rows.length) return undefined;
  return serializeClassRow(rows[0]);
}

async function enrichBooking(row) {
  const cls = await loadBookingClass(row.class_id);
  const result = serializeBooking(row, cls);
  if (row.status === 'pending_payment') {
    let payment = await paymentsService.getLatestPaymentForBooking(row.id);
    if (!payment?.checkout_url && row.athlete_pass_id) {
      payment = await paymentsService.getLatestPaymentForPass(row.athlete_pass_id);
    }
    if (payment?.checkout_url) {
      result.checkoutUrl = payment.checkout_url;
      result.paymentId = payment.id;
    }
  }
  return result;
}

async function listMyBookings(user) {
  await paymentsService.expireStalePendingBookings();
  if (user.role === 'athlete') {
    await completePastBookings(user.id);
  }
  const { rows } = await query(
    `SELECT b.* FROM bookings b
     WHERE b.athlete_user_id = $1
     ORDER BY b.created_at DESC`,
    [user.id],
  );

  return Promise.all(rows.map(enrichBooking));
}

async function getBooking(user, id) {
  await paymentsService.expireStalePendingBookings();
  const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Booking not found');
  let booking = rows[0];

  if (user.role === 'athlete' && booking.athlete_user_id !== user.id) {
    throw forbidden('Not your booking');
  }

  if (user.role === 'athlete' && booking.status === 'confirmed') {
    const completed = await completePastBooking(id);
    if (completed) booking = completed;
  }

  return enrichBooking(booking);
}

async function cancelBooking(user, id) {
  const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Booking not found');
  const booking = rows[0];

  if (user.role !== 'athlete' || booking.athlete_user_id !== user.id) {
    throw forbidden('Not your booking');
  }

  if (!['pending_payment', 'confirmed'].includes(booking.status)) {
    throw badRequest('Booking cannot be cancelled');
  }

  if (booking.status === 'pending_payment') {
    await query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE payments SET status = 'cancelled', updated_at = now()
       WHERE booking_id = $1 AND status = 'pending'`,
      [id],
    );
    return serializeBooking({ ...booking, status: 'cancelled' });
  }

  const classRow = await getClassRow(booking.class_id);
  const hoursUntilClass =
    (new Date(classRow.start_at).getTime() - Date.now()) / (1000 * 60 * 60);
  const refundEligible = hoursUntilClass >= (classRow.cancellation_policy_hours ?? 24);

  if (refundEligible) {
    await paymentsService.refundPaymentForBooking(id);
    return serializeBooking({ ...booking, status: 'refunded' });
  }

  await query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
    [id],
  );
  return serializeBooking({ ...booking, status: 'cancelled' });
}

async function markCompleted(bookingId) {
  await query(
    `UPDATE bookings SET status = 'completed', completed_at = now() WHERE id = $1`,
    [bookingId],
  );
}

async function reviewEligibility(user, bookingId) {
  const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
  if (!rows.length) throw notFound('Booking not found');
  let booking = rows[0];

  if (booking.athlete_user_id !== user.id) {
    throw forbidden('Not your booking');
  }

  if (booking.status === 'confirmed') {
    const completed = await completePastBooking(bookingId);
    if (completed) booking = completed;
  }

  const { rows: reviews } = await query(`SELECT id FROM reviews WHERE booking_id = $1`, [
    bookingId,
  ]);

  return {
    eligible: booking.status === 'completed' && !reviews.length,
    bookingId,
    status: booking.status,
    alreadyReviewed: reviews.length > 0,
  };
}

async function syncBookingPayment(user, id) {
  const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Booking not found');
  const booking = rows[0];

  if (user.role !== 'athlete' || booking.athlete_user_id !== user.id) {
    throw forbidden('Not your booking');
  }

  await paymentsService.syncBookingPaymentFromMercadoPago(id);
  return getBooking(user, id);
}

module.exports = {
  createBooking,
  listMyBookings,
  getBooking,
  cancelBooking,
  syncBookingPayment,
  reviewEligibility,
  markCompleted,
  completePastBooking,
};
