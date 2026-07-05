const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { isDev } = require('../config/env');
const { buildDeepLink, isMercadoPagoConfigured } = require('../services/mercadopago.service');
const paymentsService = require('../services/payments.service');

const router = Router();

router.get(
  '/booking-return',
  asyncHandler(async (req, res) => {
    const bookingId = String(req.query.bookingId || '');
    const status =
      req.query.status === 'failure'
        ? 'failure'
        : req.query.status === 'pending'
          ? 'pending'
          : 'success';

    const paymentId = req.query.payment_id
      ? String(req.query.payment_id)
      : req.query.collection_id
        ? String(req.query.collection_id)
        : null;

    if (paymentId && isMercadoPagoConfigured()) {
      try {
        await paymentsService.processMercadoPagoPaymentId(paymentId);
      } catch {
        // Webhook may still confirm; continue to app redirect.
      }
    }

    if (!bookingId) {
      res.status(400).send('Missing bookingId');
      return;
    }

    res.redirect(buildDeepLink(bookingId, status));
  }),
);

router.get(
  '/mock-checkout/:id',
  asyncHandler(async (req, res) => {
    if (!isDev) {
      res.status(404).send('Not found');
      return;
    }

    const payment = await paymentsService.getPaymentById(req.params.id);
    const returnBookingId = await paymentsService.resolveReturnBookingId(payment);
    const amount = (payment.amount_cents / 100).toFixed(2);
    const approveUrl = `${req.protocol}://${req.get('host')}/v1/payments/mock-checkout/${payment.id}/approve`;
    const deepLink = buildDeepLink(returnBookingId, 'success');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Fitnexia — Test payment</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:24px;text-align:center}
  button{background:#2B59C3;color:#fff;border:none;padding:14px 28px;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;width:100%}
  p{color:#64748b;line-height:1.5}
</style></head>
<body>
  <h1>Test payment</h1>
  <p>Simulate Mercado Pago checkout (dev only).</p>
  <p><strong>$${amount} ${payment.currency}</strong></p>
  <form method="POST" action="${approveUrl}">
    <button type="submit">Pay &amp; confirm booking</button>
  </form>
  <p style="margin-top:24px;font-size:13px"><a href="${deepLink}">Return to app</a></p>
</body></html>`);
  }),
);

router.post(
  '/mock-checkout/:id/approve',
  asyncHandler(async (req, res) => {
    if (!isDev) {
      res.status(404).send('Not found');
      return;
    }

    const paymentRow = await paymentsService.getPaymentById(req.params.id);
    await paymentsService.approveMockPayment(req.params.id);
    const returnBookingId = await paymentsService.resolveReturnBookingId(paymentRow);
    const deepLink = buildDeepLink(returnBookingId, 'success');
    res.redirect(deepLink);
  }),
);

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const payment = await paymentsService.getPaymentForUser(req.user, req.params.id);
    res.json(payment);
  }),
);

module.exports = router;
