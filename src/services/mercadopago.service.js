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

/** Checkout Pro: sandbox_init_point when present (TEST token). */
function resolveCheckoutInitPoint(initPoint, sandboxInitPoint) {
  if (isTestMercadoPagoToken()) {
    return sandboxInitPoint || initPoint;
  }
  return initPoint || sandboxInitPoint;
}

/**
 * Subscriptions preapproval: always use init_point from the API.
 * With TEST credentials, mercadopago.com.uy runs in test mode — do NOT rewrite to
 * sandbox.mercadopago.com.uy (subscriptions/checkout 404s on that host).
 */
function resolvePreapprovalInitPoint(initPoint, sandboxInitPoint) {
  return initPoint || sandboxInitPoint;
}

async function mercadoPagoRequest(path, options = {}) {
  const token = options.accessToken || mercadopagoAccessToken;
  const { accessToken: _ignored, ...fetchOptions } = options;
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {}),
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

function requireHttpsApiPublicUrl(purpose) {
  const base = apiPublicUrl.replace(/\/$/, '');
  if (!base.startsWith('https://')) {
    const err = new Error(
      `API_PUBLIC_URL must be a public HTTPS URL for Mercado Pago ${purpose}`,
    );
    err.code = 'MP_BACK_URL_CONFIG';
    throw err;
  }
  return base;
}

/** Mercado Pago preapproval requires an HTTPS back_url (not app deep links). */
function buildMembershipAuthorizeBackUrl(memberId, status = 'success') {
  const base = requireHttpsApiPublicUrl('preapproval');
  const params = new URLSearchParams({
    memberId: String(memberId),
    status,
  });
  return `${base}/v1/memberships/authorize-return?${params.toString()}`;
}

/** Checkout Pro debt payment — HTTPS return URL that redirects to the app. */
function buildMembershipCheckoutBackUrl(memberId, status = 'success') {
  const base = requireHttpsApiPublicUrl('checkout');
  const params = new URLSearchParams({
    memberId: String(memberId),
    status,
  });
  return `${base}/v1/memberships/checkout-return?${params.toString()}`;
}

function buildCourtDeepLink(reservationId, status) {
  return `${appDeepLinkScheme}://court/complete?reservationId=${reservationId}&status=${status}`;
}

function buildCourtCheckoutBackUrl(reservationId, status = 'success') {
  const base = requireHttpsApiPublicUrl('court checkout');
  const params = new URLSearchParams({
    reservationId: String(reservationId),
    status,
  });
  return `${base}/v1/payments/court-return?${params.toString()}`;
}

/** Checkout Pro class/pass booking — HTTPS return URL that redirects to the app. */
function buildBookingCheckoutBackUrl(bookingId, status = 'success') {
  const base = requireHttpsApiPublicUrl('booking checkout');
  const params = new URLSearchParams({
    bookingId: String(bookingId),
    status,
  });
  return `${base}/v1/payments/booking-return?${params.toString()}`;
}

/** Platform SaaS (gym tier / instructor plan) — HTTPS return → app deep link. */
function buildPlatformBillingBackUrl(kind, ownerId, status = 'success') {
  const base = requireHttpsApiPublicUrl('platform billing');
  const params = new URLSearchParams({
    kind: String(kind),
    ownerId: String(ownerId),
    status,
  });
  return `${base}/v1/platform-billing/return?${params.toString()}`;
}

function buildPlatformBillingDeepLink(kind, ownerId, status) {
  return `${appDeepLinkScheme}://profile/billing-complete?kind=${kind}&ownerId=${ownerId}&status=${status}`;
}

function frequencyToMercadoPago(frequency) {
  if (frequency === 'monthly') return { frequency: 1, frequency_type: 'months' };
  if (frequency === 'quarterly') return { frequency: 3, frequency_type: 'months' };
  // MP preapproval only accepts frequency_type: days | months (not years).
  if (frequency === 'annual') return { frequency: 12, frequency_type: 'months' };
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
  accessToken,
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
    accessToken,
  });

  return {
    preapprovalId: preapproval.id,
    authorizationUrl: resolvePreapprovalInitPoint(
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
  returnCourtReservationId,
  membershipMemberId,
  platformBillingKind,
  platformBillingOwnerId,
  collectorId,
  marketplaceFee,
}) {
  const unitPrice = amountCents / 100;
  const notificationUrl = `${apiPublicUrl}/v1/webhooks/mercadopago`;
  const deepLinkBookingId = returnBookingId || externalReference;

  const backUrls = membershipMemberId
    ? {
        success: buildMembershipCheckoutBackUrl(membershipMemberId, 'success'),
        failure: buildMembershipCheckoutBackUrl(membershipMemberId, 'failure'),
        pending: buildMembershipCheckoutBackUrl(membershipMemberId, 'pending'),
      }
    : platformBillingKind && platformBillingOwnerId
      ? {
          success: buildPlatformBillingBackUrl(platformBillingKind, platformBillingOwnerId, 'success'),
          failure: buildPlatformBillingBackUrl(platformBillingKind, platformBillingOwnerId, 'failure'),
          pending: buildPlatformBillingBackUrl(platformBillingKind, platformBillingOwnerId, 'pending'),
        }
    : returnCourtReservationId
      ? {
          success: buildCourtCheckoutBackUrl(returnCourtReservationId, 'success'),
          failure: buildCourtCheckoutBackUrl(returnCourtReservationId, 'failure'),
          pending: buildCourtCheckoutBackUrl(returnCourtReservationId, 'pending'),
        }
      : {
          success: buildBookingCheckoutBackUrl(deepLinkBookingId, 'success'),
          failure: buildBookingCheckoutBackUrl(deepLinkBookingId, 'failure'),
          pending: buildBookingCheckoutBackUrl(deepLinkBookingId, 'pending'),
        };

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
    back_urls: backUrls,
    auto_return: 'approved',
  };

  // Always attach collector when marketplace split is requested (fee may be 0).
  if (collectorId) {
    body.collector_id = Number(collectorId);
    if (marketplaceFee != null && marketplaceFee >= 0) {
      body.marketplace_fee = marketplaceFee;
    }
  }

  const preference = await mercadoPagoRequest('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return {
    preferenceId: preference.id,
    checkoutUrl: resolveCheckoutInitPoint(preference.init_point, preference.sandbox_init_point),
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
  buildCourtDeepLink,
  buildCourtCheckoutBackUrl,
  buildMembershipDeepLink,
  buildMembershipAuthorizeBackUrl,
  buildMembershipCheckoutBackUrl,
  buildBookingCheckoutBackUrl,
  buildPlatformBillingBackUrl,
  buildPlatformBillingDeepLink,
  resolveMercadoPagoCurrency,
  resolveCheckoutInitPoint,
  resolvePreapprovalInitPoint,
};
