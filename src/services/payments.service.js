const { query, pool } = require('../db/pool');
const { notFound, forbidden, badRequest } = require('../utils/errors');
const { serializeMoney } = require('../utils/serializers');
const {
  paymentsEnabled,
  paymentPendingMinutes,
} = require('../config/env');
const {
  isMercadoPagoConfigured,
  useMockPayments,
  createCheckoutPreference,
  fetchMercadoPagoPayment,
  searchMercadoPagoPaymentsByReference,
  refundMercadoPagoPayment,
  buildMockCheckoutUrl,
} = require('./mercadopago.service');
const { sendPaymentReceiptEmails } = require('./email.service');
const notificationsService = require('./notifications.service');
const { getPlans } = require('./config.service');
const passesService = require('./passes.service');
const marketplaceService = require('./marketplace.service');

function isPaymentsActive() {
  return paymentsEnabled && (isMercadoPagoConfigured() || useMockPayments());
}

function serializePayment(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    provider: row.provider,
    providerPaymentId: row.provider_payment_id || undefined,
    preferenceId: row.preference_id || undefined,
    status: row.status,
    amount: serializeMoney(row.amount_cents, row.currency),
    checkoutUrl: row.checkout_url || undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function expireStalePendingBookings(classId = null) {
  const values = [paymentPendingMinutes];
  let classFilter = '';
  if (classId) {
    values.push(classId);
    classFilter = `AND b.class_id = $2`;
  }

  await query(
    `UPDATE bookings b
     SET status = 'cancelled', cancelled_at = now()
     WHERE b.status = 'pending_payment'
       AND b.created_at < now() - ($1 || ' minutes')::interval
       ${classFilter}`,
    values,
  );

  await query(
    `UPDATE payments p
     SET status = 'cancelled', updated_at = now()
     FROM bookings b
     WHERE p.booking_id = b.id
       AND p.status = 'pending'
       AND b.status = 'cancelled'
       AND b.created_at < now() - ($1 || ' minutes')::interval
       ${classId ? 'AND b.class_id = $2' : ''}`,
    values,
  );

  await query(
    `UPDATE athlete_passes
     SET status = 'cancelled', updated_at = now()
     WHERE status = 'pending_payment'
       AND created_at < now() - ($1 || ' minutes')::interval`,
    [paymentPendingMinutes],
  );

  await query(
    `UPDATE payments p
     SET status = 'cancelled', updated_at = now()
     FROM athlete_passes ap
     WHERE p.athlete_pass_id = ap.id
       AND p.status = 'pending'
       AND ap.status = 'cancelled'
       AND ap.created_at < now() - ($1 || ' minutes')::interval`,
    [paymentPendingMinutes],
  );
}

async function insertPaymentRow(
  client,
  {
    bookingId = null,
    athletePassId = null,
    preferenceId,
    amountCents,
    currency,
    checkoutUrl,
    split = { splitMode: 'single_collector' },
  },
) {
  const { rows } = await client.query(
    `INSERT INTO payments (
      booking_id, athlete_pass_id, provider, preference_id, status,
      amount_cents, currency, checkout_url,
      seller_collector_id, seller_type, platform_fee_cents, seller_net_cents, split_mode
    ) VALUES ($1, $2, 'mercado_pago', $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *`,
    [
      bookingId,
      athletePassId,
      preferenceId,
      amountCents,
      currency,
      checkoutUrl,
      split.sellerCollectorId || null,
      split.sellerType || null,
      split.platformFeeCents ?? null,
      split.sellerNetCents ?? null,
      split.splitMode || 'single_collector',
    ],
  );
  return rows[0];
}

async function createPaymentForBooking(client, bookingRow, classRow) {
  let preferenceId = null;
  let checkoutUrl = null;
  const split = await marketplaceService.resolveCheckoutSplit(classRow, bookingRow.price_cents);

  if (isMercadoPagoConfigured()) {
    const preference = await createCheckoutPreference({
      externalReference: bookingRow.id,
      title: classRow.title,
      amountCents: bookingRow.price_cents,
      currency: bookingRow.price_currency,
      returnBookingId: bookingRow.id,
      collectorId: split.collectorId,
      marketplaceFee: split.marketplaceFee,
    });
    preferenceId = preference.preferenceId;
    checkoutUrl = preference.checkoutUrl;
  } else if (useMockPayments()) {
    checkoutUrl = null;
  } else {
    throw badRequest('Payments are not configured');
  }

  const payment = await insertPaymentRow(client, {
    bookingId: bookingRow.id,
    preferenceId,
    amountCents: bookingRow.price_cents,
    currency: bookingRow.price_currency,
    checkoutUrl,
    split,
  });

  if (useMockPayments() && !checkoutUrl) {
    checkoutUrl = buildMockCheckoutUrl(payment.id);
    await client.query(`UPDATE payments SET checkout_url = $1, updated_at = now() WHERE id = $2`, [
      checkoutUrl,
      payment.id,
    ]);
    payment.checkout_url = checkoutUrl;
  }

  return payment;
}

async function createPaymentForPass(client, passRow, product, returnBookingId, classRow) {
  let preferenceId = null;
  let checkoutUrl = null;
  const externalReference = `pass:${passRow.id}`;
  const split = classRow
    ? await marketplaceService.resolveCheckoutSplit(classRow, passRow.price_cents, {
        isPassPurchase: true,
      })
    : { splitMode: 'single_collector' };

  if (isMercadoPagoConfigured()) {
    const preference = await createCheckoutPreference({
      externalReference,
      title: product.name,
      amountCents: passRow.price_cents,
      currency: passRow.price_currency,
      returnBookingId,
      collectorId: split.collectorId,
      marketplaceFee: split.marketplaceFee,
    });
    preferenceId = preference.preferenceId;
    checkoutUrl = preference.checkoutUrl;
  } else if (useMockPayments()) {
    checkoutUrl = null;
  } else {
    throw badRequest('Payments are not configured');
  }

  await client.query(
    `UPDATE athlete_passes
     SET preference_id = $2, checkout_url = $3, updated_at = now()
     WHERE id = $1`,
    [passRow.id, preferenceId, checkoutUrl],
  );

  const payment = await insertPaymentRow(client, {
    athletePassId: passRow.id,
    preferenceId,
    amountCents: passRow.price_cents,
    currency: passRow.price_currency,
    checkoutUrl,
    split,
  });
  if (useMockPayments() && !checkoutUrl) {
    checkoutUrl = buildMockCheckoutUrl(payment.id);
    await client.query(`UPDATE payments SET checkout_url = $1, updated_at = now() WHERE id = $2`, [
      checkoutUrl,
      payment.id,
    ]);
    await client.query(`UPDATE athlete_passes SET checkout_url = $1, updated_at = now() WHERE id = $2`, [
      checkoutUrl,
      passRow.id,
    ]);
    payment.checkout_url = checkoutUrl;
  }

  return payment;
}

async function confirmPassPayment(passId, providerPaymentId = null) {
  const pass = await passesService.activatePass(passId, providerPaymentId);

  await query(
    `UPDATE payments
     SET status = 'approved',
         provider_payment_id = COALESCE($2, provider_payment_id),
         updated_at = now()
     WHERE athlete_pass_id = $1 AND status = 'pending'`,
    [passId, providerPaymentId],
  );

  const { rows: pendingBookings } = await query(
    `SELECT id FROM bookings
     WHERE athlete_pass_id = $1 AND status = 'pending_payment'`,
    [passId],
  );

  for (const booking of pendingBookings) {
    await query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [booking.id]);
    const { rows: bookingRows } = await query(`SELECT * FROM bookings WHERE id = $1`, [booking.id]);
    if (bookingRows.length) {
      const classRow = await require('./classes.service').getClassRow(bookingRows[0].class_id);
      await marketplaceService.recordPassBookingLedger(bookingRows[0], classRow);
    }
    notifyAfterPaymentConfirmed(booking.id).catch((err) => {
      console.warn('[payments] receipt email failed:', err.message);
    });
    notificationsService
      .notifyPaymentConfirmed(booking.id)
      .catch((err) => console.warn('[payments] payment push failed:', err.message));
    notificationsService
      .notifyBookingConfirmed(booking.id, { skipAthlete: true })
      .catch((err) => console.warn('[payments] instructor booking push failed:', err.message));
  }

  return pass;
}

async function rejectPassPayment(passId) {
  await query(
    `UPDATE athlete_passes SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND status = 'pending_payment'`,
    [passId],
  );
  await query(
    `UPDATE payments SET status = 'rejected', updated_at = now()
     WHERE athlete_pass_id = $1 AND status = 'pending'`,
    [passId],
  );
  await query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
     WHERE athlete_pass_id = $1 AND status = 'pending_payment'`,
    [passId],
  );
}

async function notifyAfterPaymentConfirmed(bookingId) {
  const { rows } = await query(
    `SELECT b.price_cents, b.price_currency, c.title, c.start_at,
            ua.email AS athlete_email, iu.email AS instructor_email, i.plan
     FROM bookings b
     JOIN classes c ON c.id = b.class_id
     JOIN users ua ON ua.id = b.athlete_user_id
     JOIN instructors i ON i.id = c.instructor_id
     JOIN users iu ON iu.id = i.user_id
     WHERE b.id = $1`,
    [bookingId],
  );
  if (!rows.length) return;

  const row = rows[0];
  const plan = getPlans().find((p) => p.id === row.plan);
  await sendPaymentReceiptEmails({
    athleteEmail: row.athlete_email,
    instructorEmail: row.instructor_email,
    classTitle: row.title,
    classStartAt: row.start_at,
    grossCents: row.price_cents,
    currency: row.price_currency,
    commissionPercent: plan?.commissionPercent ?? 15,
    bookingId,
  });
}

async function confirmBookingPayment(bookingId, providerPaymentId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bookingResult = await client.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [
      bookingId,
    ]);
    if (!bookingResult.rows.length) {
      throw notFound('Booking not found');
    }
    const booking = bookingResult.rows[0];
    if (booking.status === 'confirmed') {
      await client.query('COMMIT');
      return booking;
    }
    if (booking.status !== 'pending_payment') {
      throw badRequest('Booking is not awaiting payment');
    }

    await client.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [bookingId]);

    await client.query(
      `UPDATE payments
       SET status = 'approved',
           provider_payment_id = COALESCE($2, provider_payment_id),
           updated_at = now()
       WHERE booking_id = $1 AND status = 'pending'`,
      [bookingId, providerPaymentId],
    );

    await client.query('COMMIT');
    notifyAfterPaymentConfirmed(bookingId).catch((err) => {
      console.warn('[payments] receipt email failed:', err.message);
    });
    notificationsService
      .notifyPaymentConfirmed(bookingId)
      .catch((err) => console.warn('[payments] payment push failed:', err.message));
    notificationsService
      .notifyBookingConfirmed(bookingId, { skipAthlete: true })
      .catch((err) => console.warn('[payments] instructor booking push failed:', err.message));
    return { ...booking, status: 'confirmed' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function rejectBookingPayment(bookingId, providerPaymentId = null) {
  await query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'pending_payment'`,
    [bookingId],
  );
  await query(
    `UPDATE payments
     SET status = 'rejected',
         provider_payment_id = COALESCE($2, provider_payment_id),
         updated_at = now()
     WHERE booking_id = $1 AND status = 'pending'`,
    [bookingId, providerPaymentId],
  );
}

async function getPaymentById(id) {
  const { rows } = await query(`SELECT * FROM payments WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('Payment not found');
  return rows[0];
}

async function getPaymentForUser(user, id) {
  const payment = await getPaymentById(id);
  let ownerUserId;

  if (payment.booking_id) {
    const { rows } = await query(`SELECT athlete_user_id FROM bookings WHERE id = $1`, [
      payment.booking_id,
    ]);
    if (!rows.length) throw notFound('Booking not found');
    ownerUserId = rows[0].athlete_user_id;
  } else if (payment.athlete_pass_id) {
    const pass = await passesService.getPassById(payment.athlete_pass_id);
    ownerUserId = pass.athlete_user_id;
  } else {
    throw notFound('Payment not linked');
  }

  if (user.role !== 'admin' && ownerUserId !== user.id) {
    throw forbidden('Not your payment');
  }
  return serializePayment(payment);
}

async function getLatestPaymentForBooking(bookingId) {
  const { rows } = await query(
    `SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [bookingId],
  );
  return rows[0] || null;
}

async function getLatestPaymentForPass(passId) {
  const { rows } = await query(
    `SELECT * FROM payments WHERE athlete_pass_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [passId],
  );
  return rows[0] || null;
}

async function resolveReturnBookingId(payment) {
  if (payment.booking_id) return payment.booking_id;
  if (!payment.athlete_pass_id) return null;

  const { rows } = await query(
    `SELECT id FROM bookings
     WHERE athlete_pass_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [payment.athlete_pass_id],
  );
  return rows[0]?.id || null;
}

async function approveMockPayment(paymentId) {
  const payment = await getPaymentById(paymentId);
  if (payment.status !== 'pending') {
    return serializePayment(payment);
  }
  if (payment.athlete_pass_id) {
    await confirmPassPayment(payment.athlete_pass_id, `mock_${paymentId}`);
  } else {
    await confirmBookingPayment(payment.booking_id, `mock_${paymentId}`);
  }
  const updated = await getPaymentById(paymentId);
  return serializePayment(updated);
}

async function processMercadoPagoPaymentId(providerPaymentId) {
  const mpPayment = await fetchMercadoPagoPayment(String(providerPaymentId));
  const externalReference = mpPayment.external_reference;
  if (!externalReference) {
    return { processed: false, reason: 'missing_external_reference' };
  }

  const status = mpPayment.status;
  const isPass = String(externalReference).startsWith('pass:');
  const passId = isPass ? String(externalReference).slice(5) : null;
  const bookingId = isPass ? null : externalReference;

  if (status === 'approved') {
    if (isPass) {
      await confirmPassPayment(passId, String(mpPayment.id));
      return { processed: true, passId, status: 'approved' };
    }
    await confirmBookingPayment(bookingId, String(mpPayment.id));
    return { processed: true, bookingId, status: 'approved' };
  }

  if (['rejected', 'cancelled'].includes(status)) {
    if (isPass) {
      await rejectPassPayment(passId);
      return { processed: true, passId, status: 'rejected' };
    }
    await rejectBookingPayment(bookingId, String(mpPayment.id));
    return { processed: true, bookingId, status: 'rejected' };
  }

  return { processed: true, externalReference, status: 'pending' };
}

async function processMercadoPagoWebhook(body) {
  const paymentId =
    body?.data?.id ||
    body?.id ||
    (typeof body?.resource === 'string' && body.resource.includes('/')
      ? body.resource.split('/').pop()
      : null);

  if (!paymentId) {
    return { processed: false, reason: 'missing_payment_id' };
  }

  return processMercadoPagoPaymentId(paymentId);
}

async function syncBookingPaymentFromMercadoPago(bookingId) {
  if (!isMercadoPagoConfigured()) {
    return { synced: false, reason: 'mercadopago_not_configured' };
  }

  const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
  if (!rows.length) throw notFound('Booking not found');
  const booking = rows[0];

  if (booking.status === 'confirmed') {
    return { synced: true, bookingId, status: 'confirmed' };
  }

  if (booking.status !== 'pending_payment') {
    return { synced: false, bookingId, status: booking.status, reason: 'not_pending_payment' };
  }

  if (booking.athlete_pass_id) {
    const passRef = `pass:${booking.athlete_pass_id}`;
    const mpPayments = await searchMercadoPagoPaymentsByReference(passRef);
    const approved = mpPayments.find((p) => p.status === 'approved');
    if (approved) {
      await confirmPassPayment(booking.athlete_pass_id, String(approved.id));
      return { synced: true, bookingId, status: 'approved' };
    }
    const rejected = mpPayments.find((p) => ['rejected', 'cancelled'].includes(p.status));
    if (rejected) {
      await rejectPassPayment(booking.athlete_pass_id);
      return { synced: true, bookingId, status: 'rejected' };
    }
    return { synced: false, bookingId, status: 'pending', reason: 'pass_payment_not_found' };
  }

  const mpPayments = await searchMercadoPagoPaymentsByReference(bookingId);
  const approved = mpPayments.find((p) => p.status === 'approved');
  if (approved) {
    await confirmBookingPayment(bookingId, String(approved.id));
    return { synced: true, bookingId, status: 'approved' };
  }

  const rejected = mpPayments.find((p) => ['rejected', 'cancelled'].includes(p.status));
  if (rejected) {
    await rejectBookingPayment(bookingId, String(rejected.id));
    return { synced: true, bookingId, status: 'rejected' };
  }

  return { synced: false, bookingId, status: 'pending', reason: 'payment_not_found' };
}

async function refundPaymentForBooking(bookingId) {
  const payment = await getLatestPaymentForBooking(bookingId);
  if (!payment || payment.status !== 'approved') return;

  if (payment.provider_payment_id && isMercadoPagoConfigured()) {
    await refundMercadoPagoPayment(payment.provider_payment_id);
  }

  await query(
    `UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`,
    [payment.id],
  );
  await query(
    `UPDATE bookings SET status = 'refunded', cancelled_at = now() WHERE id = $1`,
    [bookingId],
  );
}

function buildPaymentResponse(paymentRow, extras = {}) {
  return {
    provider: 'mercado_pago',
    preferenceId: paymentRow.preference_id || paymentRow.id,
    checkoutUrl: paymentRow.checkout_url,
    paymentId: paymentRow.id,
    ...extras,
  };
}

module.exports = {
  isPaymentsActive,
  serializePayment,
  expireStalePendingBookings,
  createPaymentForBooking,
  createPaymentForPass,
  confirmPassPayment,
  confirmBookingPayment,
  rejectBookingPayment,
  getPaymentForUser,
  getPaymentById,
  approveMockPayment,
  processMercadoPagoWebhook,
  processMercadoPagoPaymentId,
  syncBookingPaymentFromMercadoPago,
  refundPaymentForBooking,
  getLatestPaymentForBooking,
  getLatestPaymentForPass,
  resolveReturnBookingId,
  buildPaymentResponse,
};
