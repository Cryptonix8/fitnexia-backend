const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');
const { badRequest, forbidden, notFound } = require('../utils/errors');
const {
  mercadopagoAppId,
  mercadopagoClientSecret,
  mercadopagoAccessToken,
  apiPublicUrl,
  appDeepLinkScheme,
  jwtAccessSecret,
} = require('../config/env');
const { isMarketplaceConfigured, isMarketplaceEnabled } = require('../config/marketplace.config');

const MP_AUTH_URL = 'https://auth.mercadopago.com/authorization';
const MP_TOKEN_URL = 'https://api.mercadopago.com/oauth/token';

function getOAuthRedirectUri() {
  return `${apiPublicUrl}/v1/payouts/mp/callback`;
}

function assertMarketplaceReady() {
  if (!isMarketplaceConfigured()) {
    throw badRequest('Mercado Pago Marketplace is not configured yet');
  }
}

function signOAuthState(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, purpose: 'mp_oauth' },
    jwtAccessSecret,
    { expiresIn: '15m' },
  );
}

function verifyOAuthState(state) {
  const payload = jwt.verify(state, jwtAccessSecret);
  if (payload.purpose !== 'mp_oauth') {
    throw badRequest('Invalid OAuth state');
  }
  return payload;
}

function getConnectUrl(user) {
  assertMarketplaceReady();
  if (!['instructor', 'institution'].includes(user.role)) {
    throw forbidden('Only instructors and institutions can connect Mercado Pago');
  }

  const state = signOAuthState(user);
  const params = new URLSearchParams({
    client_id: mercadopagoAppId,
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: getOAuthRedirectUri(),
    state,
  });

  return {
    url: `${MP_AUTH_URL}?${params.toString()}`,
    state,
  };
}

async function exchangeAuthorizationCode(code) {
  const res = await fetch(MP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: mercadopagoAppId,
      client_secret: mercadopagoClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: getOAuthRedirectUri(),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.message || data.error || 'Mercado Pago OAuth token exchange failed';
    throw badRequest(message);
  }

  return data;
}

async function saveSellerTokens(userId, role, tokenData) {
  const collectorId = String(tokenData.user_id);
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
    : null;

  const values = [
    collectorId,
    collectorId,
    tokenData.access_token,
    tokenData.refresh_token || null,
    expiresAt,
  ];

  if (role === 'instructor') {
    const { rows } = await query(
      `UPDATE instructors
       SET mp_collector_id = $2,
           mp_user_id = $3,
           mp_access_token = $4,
           mp_refresh_token = $5,
           mp_token_expires_at = $6,
           mp_connection_status = 'connected',
           mp_connected_at = now(),
           updated_at = now()
       WHERE user_id = $1
       RETURNING *`,
      [userId, ...values],
    );
    if (!rows.length) throw notFound('Instructor profile not found');
    return rows[0];
  }

  if (role === 'institution') {
    const { rows } = await query(
      `UPDATE institutions
       SET mp_collector_id = $2,
           mp_user_id = $3,
           mp_access_token = $4,
           mp_refresh_token = $5,
           mp_token_expires_at = $6,
           mp_connection_status = 'connected',
           mp_connected_at = now(),
           updated_at = now()
       WHERE user_id = $1
       RETURNING *`,
      [userId, ...values],
    );
    if (!rows.length) throw notFound('Institution profile not found');
    return rows[0];
  }

  throw badRequest('Invalid seller role');
}

async function handleOAuthCallback(code, state) {
  const payload = verifyOAuthState(state);
  const tokenData = await exchangeAuthorizationCode(code);
  await saveSellerTokens(payload.sub, payload.role, tokenData);

  return {
    deepLink: `${appDeepLinkScheme}://profile/payout-connected?status=success`,
    role: payload.role,
  };
}

async function disconnectSeller(user) {
  if (!['instructor', 'institution'].includes(user.role)) {
    throw forbidden('Only instructors and institutions can disconnect Mercado Pago');
  }

  const table = user.role === 'instructor' ? 'instructors' : 'institutions';
  const { rows } = await query(
    `UPDATE ${table}
     SET mp_collector_id = NULL,
         mp_user_id = NULL,
         mp_access_token = NULL,
         mp_refresh_token = NULL,
         mp_token_expires_at = NULL,
         mp_connection_status = 'revoked',
         mp_connected_at = NULL,
         updated_at = now()
     WHERE user_id = $1
     RETURNING *`,
    [user.id],
  );

  if (!rows.length) throw notFound(`${user.role} profile not found`);
  return rows[0];
}

async function refreshSellerTokenIfNeeded(seller, tableName) {
  if (!seller.mp_refresh_token || !seller.mp_token_expires_at) return seller;

  const expiresSoon =
    new Date(seller.mp_token_expires_at).getTime() - Date.now() < 5 * 60 * 1000;
  if (!expiresSoon) return seller;

  const res = await fetch(MP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: mercadopagoAppId,
      client_secret: mercadopagoClientSecret,
      grant_type: 'refresh_token',
      refresh_token: seller.mp_refresh_token,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return seller;

  const expiresAt = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000)
    : null;

  const { rows } = await query(
    `UPDATE ${tableName}
     SET mp_access_token = $2,
         mp_refresh_token = COALESCE($3, mp_refresh_token),
         mp_token_expires_at = $4,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [seller.id, data.access_token, data.refresh_token || null, expiresAt],
  );

  return rows[0] || seller;
}

function getMarketplaceStatus() {
  return {
    enabled: isMarketplaceEnabled(),
    configured: isMarketplaceConfigured(),
    redirectUri: getOAuthRedirectUri(),
    platformTokenConfigured: Boolean(mercadopagoAccessToken),
  };
}

module.exports = {
  getConnectUrl,
  handleOAuthCallback,
  disconnectSeller,
  refreshSellerTokenIfNeeded,
  getMarketplaceStatus,
  getOAuthRedirectUri,
};
