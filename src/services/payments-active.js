const { paymentsEnabled } = require('../config/env');
const { isMercadoPagoConfigured, useMockPayments } = require('./mercadopago.service');

function isPaymentsActive() {
  return paymentsEnabled && (isMercadoPagoConfigured() || useMockPayments());
}

module.exports = { isPaymentsActive };
