const crypto = require('crypto');
const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { isMercadoPagoConfigured } = require('../services/mercadopago.service');
const { mercadopagoWebhookSecret } = require('../config/env');
const paymentsService = require('../services/payments.service');

const router = Router();

/**
 * Validates Mercado Pago webhook x-signature when MERCADOPAGO_WEBHOOK_SECRET is set.
 * Format: ts=...,v1=...
 * See https://www.mercadopago.com.uy/developers/en/docs/your-integrations/notifications/webhooks
 */
function verifyMercadoPagoSignature(req) {
  if (!mercadopagoWebhookSecret) return true;

  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  if (!xSignature || !xRequestId) return false;

  const parts = Object.fromEntries(
    String(xSignature)
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((pair) => pair.length === 2),
  );
  const ts = parts.ts;
  const hash = parts.v1;
  if (!ts || !hash) return false;

  const dataId = req.query['data.id'] || req.query.id || req.body?.data?.id || '';
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const expected = crypto
    .createHmac('sha256', mercadopagoWebhookSecret)
    .update(manifest)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(hash)));
  } catch {
    return false;
  }
}

async function handleMercadoPagoNotification(req, res) {
  if (!isMercadoPagoConfigured()) {
    res.json({ processed: false, reason: 'mercadopago_not_configured' });
    return;
  }

  if (!verifyMercadoPagoSignature(req)) {
    res.status(401).json({ processed: false, reason: 'invalid_signature' });
    return;
  }

  const queryId = req.query.id || req.query['data.id'];
  const topic = req.query.topic || req.query.type;

  if (
    queryId &&
    (topic === 'preapproval' || topic === 'subscription_preapproval' || topic === 'authorized_payment')
  ) {
    if (topic === 'authorized_payment') {
      const result = await paymentsService.processMercadoPagoPaymentId(queryId);
      res.json(result);
      return;
    }
    const result = await paymentsService.processMercadoPagoPreapprovalId(queryId);
    res.json(result);
    return;
  }

  if (queryId && (!topic || topic === 'payment')) {
    const result = await paymentsService.processMercadoPagoPaymentId(queryId);
    res.json(result);
    return;
  }

  const result = await paymentsService.processMercadoPagoWebhook(req.body || {});
  res.json(result);
}

router.post('/mercadopago', asyncHandler(handleMercadoPagoNotification));

router.get('/mercadopago', asyncHandler(handleMercadoPagoNotification));

module.exports = router;
