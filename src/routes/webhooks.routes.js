const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { isMercadoPagoConfigured } = require('../services/mercadopago.service');
const paymentsService = require('../services/payments.service');

const router = Router();

async function handleMercadoPagoNotification(req, res) {
  if (!isMercadoPagoConfigured()) {
    res.json({ processed: false, reason: 'mercadopago_not_configured' });
    return;
  }

  const queryId = req.query.id || req.query['data.id'];
  const topic = req.query.topic || req.query.type;

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
