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

function isTestMercadoPagoToken() {
  return mercadopagoAccessToken.startsWith('TEST-');
}

/** Checkout preferences expose sandbox_init_point; preapproval often only returns production init_point. */
function toMercadoPagoSandboxUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (/sandbox\.mercadopago/i.test(url)) return url;

  return url.replace(
    /https?:\/\/(?:www\.)?mercadopago(\.[a-z0-9.-]+)/gi,
    (_match, domainSuffix) => `https://sandbox.mercadopago${domainSuffix}`,
  );
}

function resolveMercadoPagoInitPoint(initPoint, sandboxInitPoint) {
  if (isTestMercadoPagoToken()) {
    return sandboxInitPoint || toMercadoPagoSandboxUrl(initPoint) || initPoint;
  }
  return initPoint || sandboxInitPoint;
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

function buildMembershipDeepLink(memberId, status) {
  return `${appDeepLinkScheme}://membership/complete?memberId=${memberId}&status=${status}`;
}

/** Mercado Pago preapproval requires an HTTPS back_url (not app deep links). */
function buildMembershipAuthorizeBackUrl(memberId, status = 'success') {
  const base = apiPublicUrl.replace(/\/$/, '');
  if (!base.startsWith('https://')) {
    const err = new Error(
      'API_PUBLIC_URL must be a public HTTPS URL (e.g. ngrok) for Mercado Pago preapproval',
    );
    err.code = 'MP_BACK_URL_CONFIG';
    throw err;
  }
  const params = new URLSearchParams({
    memberId: String(memberId),
    status,
  });
  return `${base}/v1/memberships/authorize-return?${params.toString()}`;
}

function frequencyToMercadoPago(frequency) {
  if (frequency === 'monthly') return { frequency: 1, frequency_type: 'months' };
  if (frequency === 'quarterly') return { frequency: 3, frequency_type: 'months' };
  if (frequency === 'annual') return { frequency: 1, frequency_type: 'years' };
  return { frequency: 1, frequency_type: 'months' };
}

async function createPreapproval({
  externalReference,
  reason,
  amountCents,
  currency,
  payerEmail,
  billingFrequency,
  returnMemberId,
  backUrl,
}) {
  const unitPrice = amountCents / 100;
  const notificationUrl = `${apiPublicUrl}/v1/webhooks/mercadopago`;
  const freq = frequencyToMercadoPago(billingFrequency);

  const body = {
    reason: reason.slice(0, 256),
    external_reference: externalReference,
    payer_email: payerEmail,
    auto_recurring: {
      frequency: freq.frequency,
      frequency_type: freq.frequency_type,
      transaction_amount: unitPrice,
      currency_id: resolveMercadoPagoCurrency(currency),
    },
    back_url: backUrl || buildMembershipAuthorizeBackUrl(returnMemberId, 'success'),
    status: 'pending',
  };

  const preapproval = await mercadoPagoRequest('/preapproval', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return {
    preapprovalId: preapproval.id,
    authorizationUrl: resolveMercadoPagoInitPoint(
      preapproval.init_point,
      preapproval.sandbox_init_point,
    ),
  };
}

async function fetchMercadoPagoPreapproval(preapprovalId) {
  return mercadoPagoRequest(`/preapproval/${preapprovalId}`);
}

function buildMockMembershipAuthorizeUrl(subscriptionId) {
  return `${apiPublicUrl}/v1/memberships/mock-authorize/${subscriptionId}`;
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
    checkoutUrl: resolveMercadoPagoInitPoint(preference.init_point, preference.sandbox_init_point),
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
  createPreapproval,
  fetchMercadoPagoPayment,
  fetchMercadoPagoPreapproval,
  searchMercadoPagoPaymentsByReference,
  refundMercadoPagoPayment,
  buildMockCheckoutUrl,
  buildMockMembershipAuthorizeUrl,
  buildDeepLink,
  buildMembershipDeepLink,
  buildMembershipAuthorizeBackUrl,
  resolveMercadoPagoCurrency,
  resolveMercadoPagoInitPoint,
  toMercadoPagoSandboxUrl,
};
