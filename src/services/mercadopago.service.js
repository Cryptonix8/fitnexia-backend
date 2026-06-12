const {
  mercadopagoAccessToken,
  apiPublicUrl,
  appDeepLinkScheme,
  isDev,
  defaultCurrency,
} = require('../config/env');

/** Mercado Pago Checkout Pro only accepts the account's local currency. */
function resolveMercadoPagoCurrency(currency) {
  const requested = (currency || defaultCurrency).trim().toUpperCase();
  if (requested === defaultCurrency) return requested;
  // Legacy classes stored as USD on a UY account — charge in UYU (same numeric amount for sandbox).
  if (defaultCurrency === 'UYU' && requested === 'USD') return 'UYU';
  return defaultCurrency;
}

function isMercadoPagoConfigured() {
  return Boolean(mercadopagoAccessToken);
}

function useMockPayments() {
  return !isMercadoPagoConfigured() && isDev;
}

async function mercadoPagoRequest(path, options = {}) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${mercadopagoAccessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.message || data.error || res.statusText || 'Mercado Pago request failed';
    const err = new Error(message);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

function buildDeepLink(bookingId, status) {
  return `${appDeepLinkScheme}://booking/complete?bookingId=${bookingId}&status=${status}`;
}

async function createCheckoutPreference({
  externalReference,
  title,
  amountCents,
  currency,
  returnBookingId,
  collectorId,
  marketplaceFee,
}) {
  const unitPrice = amountCents / 100;
  const notificationUrl = `${apiPublicUrl}/v1/webhooks/mercadopago`;
  const deepLinkBookingId = returnBookingId || externalReference;

  const body = {
    items: [
      {
        id: String(externalReference).slice(0, 256),
        title,
        quantity: 1,
        currency_id: resolveMercadoPagoCurrency(currency),
        unit_price: unitPrice,
      },
    ],
    external_reference: externalReference,
    notification_url: notificationUrl,
    back_urls: {
      success: buildDeepLink(deepLinkBookingId, 'success'),
      failure: buildDeepLink(deepLinkBookingId, 'failure'),
      pending: buildDeepLink(deepLinkBookingId, 'pending'),
    },
    auto_return: 'approved',
  };

  if (collectorId && marketplaceFee != null && marketplaceFee > 0) {
    body.collector_id = Number(collectorId);
    body.marketplace_fee = marketplaceFee;
  }

  const preference = await mercadoPagoRequest('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return {
    preferenceId: preference.id,
    checkoutUrl:
      (mercadopagoAccessToken.startsWith('TEST-')
        ? preference.sandbox_init_point
        : null) ||
      preference.init_point ||
      preference.sandbox_init_point,
  };
}

async function fetchMercadoPagoPayment(providerPaymentId) {
  return mercadoPagoRequest(`/v1/payments/${providerPaymentId}`);
}

async function searchMercadoPagoPaymentsByReference(externalReference) {
  const params = new URLSearchParams({
    external_reference: externalReference,
    sort: 'date_created',
    criteria: 'desc',
  });
  const result = await mercadoPagoRequest(`/v1/payments/search?${params.toString()}`);
  return result.results || [];
}

async function refundMercadoPagoPayment(providerPaymentId) {
  return mercadoPagoRequest(`/v1/payments/${providerPaymentId}/refunds`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

function buildMockCheckoutUrl(paymentId) {
  return `${apiPublicUrl}/v1/payments/mock-checkout/${paymentId}`;
}

module.exports = {
  isMercadoPagoConfigured,
  useMockPayments,
  createCheckoutPreference,
  fetchMercadoPagoPayment,
  searchMercadoPagoPaymentsByReference,
  refundMercadoPagoPayment,
  buildMockCheckoutUrl,
  buildDeepLink,
  resolveMercadoPagoCurrency,
};
