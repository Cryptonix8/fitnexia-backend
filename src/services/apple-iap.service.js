/**
 * Apple In-App Purchase verification + SaaS entitlement activation.
 *
 * Production: decode StoreKit 2 JWS (signedTransactionInfo) and check bundleId / productId.
 * Full App Store Server API crypto verification can be added with APPLE_IAP_* keys later;
 * until then set APPLE_IAP_ALLOW_UNVERIFIED=false and provide signedTransactionInfo that
 * at least decodes + matches expected claims (or enable mock only in non-production).
 */
const { query } = require('../db/pool');
const { badRequest, forbidden, conflict } = require('../utils/errors');
const {
  getAppleIapConfig,
  resolveProduct,
  listProductIds,
} = require('../config/apple-iap');
const institutionsService = require('./institutions.service');
const { getInstructorByUserId } = require('./instructors.service');
const gymSubscriptionService = require('./gym-subscription.service');

function decodeJwsPayload(jws) {
  if (!jws || typeof jws !== 'string') return null;
  const parts = jws.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Validate purchase payload from the iOS client.
 * @returns {{ productId: string, transactionId: string, originalTransactionId: string, environment: string, expiresDate: Date|null }}
 */
function parseAndValidatePurchase(body = {}) {
  const config = getAppleIapConfig();
  const signedTransactionInfo = body.signedTransactionInfo || body.jwsRepresentation || null;
  const payload = signedTransactionInfo ? decodeJwsPayload(signedTransactionInfo) : null;

  const productId = String(payload?.productId || body.productId || '').trim();
  const transactionId = String(payload?.transactionId || body.transactionId || '').trim();
  const originalTransactionId = String(
    payload?.originalTransactionId || body.originalTransactionId || transactionId,
  ).trim();
  const bundleId = String(payload?.bundleId || body.bundleId || '').trim();
  const environment = String(payload?.environment || body.environment || 'Production').trim();
  const expiresDateMs = payload?.expiresDate ? Number(payload.expiresDate) : null;

  if (!productId) throw badRequest('productId is required');
  if (!transactionId) throw badRequest('transactionId is required');

  const meta = resolveProduct(productId);
  if (!meta) throw badRequest(`Unknown App Store product: ${productId}`);

  if (payload) {
    if (bundleId && config.bundleId && bundleId !== config.bundleId) {
      throw forbidden('Bundle ID does not match this app');
    }
  } else if (!config.allowUnverified) {
    throw badRequest(
      'signedTransactionInfo (StoreKit 2 JWS) is required when APPLE_IAP_ALLOW_UNVERIFIED is false',
    );
  }

  return {
    productId,
    transactionId,
    originalTransactionId,
    environment,
    expiresDate: expiresDateMs && Number.isFinite(expiresDateMs) ? new Date(expiresDateMs) : null,
    meta,
  };
}

async function activateInstructorFromApple(userId, purchase) {
  const instructor = await getInstructorByUserId(userId);
  const planId = purchase.meta.plan;

  const { rows: taken } = await query(
    `SELECT id FROM instructors
     WHERE apple_original_transaction_id = $1 AND id <> $2`,
    [purchase.originalTransactionId, instructor.id],
  );
  if (taken.length) {
    throw conflict('APPLE_TXN_IN_USE', 'This Apple subscription is already linked to another account');
  }

  await query(
    `UPDATE instructors
     SET plan = $2::instructor_plan,
         saas_pending_plan = NULL,
         saas_billing_status = 'active',
         saas_mp_preapproval_id = NULL,
         saas_authorization_url = NULL,
         saas_last_billed_at = now(),
         saas_next_billing_at = COALESCE($3, now() + interval '1 month'),
         apple_original_transaction_id = $4,
         apple_product_id = $5,
         apple_environment = $6,
         updated_at = now()
     WHERE id = $1`,
    [
      instructor.id,
      planId,
      purchase.expiresDate,
      purchase.originalTransactionId,
      purchase.productId,
      purchase.environment,
    ],
  );

  return {
    kind: 'instructor',
    plan: planId,
    productId: purchase.productId,
    billingStatus: 'active',
    transactionId: purchase.transactionId,
    originalTransactionId: purchase.originalTransactionId,
  };
}

async function activateGymFromApple(userId, purchase) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const tierId = purchase.meta.tier;

  const limit = require('../config/gym-tiers').getMemberLimitForTier(tierId);
  if (limit != null) {
    const current = await gymSubscriptionService.countBillableMembers(institution.id);
    if (current > limit) {
      throw badRequest(
        `Cannot activate this plan: you have ${current} members but the limit is ${limit}.`,
      );
    }
  }

  const { rows: taken } = await query(
    `SELECT id FROM institutions
     WHERE apple_original_transaction_id = $1 AND id <> $2`,
    [purchase.originalTransactionId, institution.id],
  );
  if (taken.length) {
    throw conflict('APPLE_TXN_IN_USE', 'This Apple subscription is already linked to another account');
  }

  await query(
    `UPDATE institutions
     SET saas_tier = $2::gym_saas_tier,
         saas_pending_tier = NULL,
         saas_billing_status = 'active',
         saas_mp_preapproval_id = NULL,
         saas_authorization_url = NULL,
         saas_last_billed_at = now(),
         saas_next_billing_at = COALESCE($3, now() + interval '1 month'),
         apple_original_transaction_id = $4,
         apple_product_id = $5,
         apple_environment = $6,
         updated_at = now()
     WHERE id = $1`,
    [
      institution.id,
      tierId,
      purchase.expiresDate,
      purchase.originalTransactionId,
      purchase.productId,
      purchase.environment,
    ],
  );

  const subscription = await gymSubscriptionService.getSubscriptionForInstitution(institution.id);
  return {
    kind: 'gym',
    tier: tierId,
    productId: purchase.productId,
    billingStatus: 'active',
    transactionId: purchase.transactionId,
    originalTransactionId: purchase.originalTransactionId,
    subscription,
  };
}

async function verifyAndActivate(user, body) {
  const purchase = parseAndValidatePurchase(body);
  const role = user.role;

  if (purchase.meta.kind === 'instructor') {
    if (role !== 'instructor') throw forbidden('Only instructors can purchase this product');
    return activateInstructorFromApple(user.id, purchase);
  }

  if (purchase.meta.kind === 'gym') {
    if (role !== 'institution') throw forbidden('Only gyms can purchase this product');
    return activateGymFromApple(user.id, purchase);
  }

  throw badRequest('Unsupported product kind');
}

async function restorePurchases(user, body = {}) {
  const purchases = Array.isArray(body.purchases) ? body.purchases : [body];
  const results = [];
  for (const item of purchases) {
    if (!item?.productId && !item?.signedTransactionInfo && !item?.transactionId) continue;
    try {
      const result = await verifyAndActivate(user, item);
      results.push({ ok: true, ...result });
    } catch (err) {
      results.push({ ok: false, error: err.message, code: err.code });
    }
  }
  return { results };
}

async function downgradeExpiredAppleSubscription({ originalTransactionId, kind }) {
  if (!originalTransactionId) return { processed: false };

  if (kind === 'instructor' || !kind) {
    const { rowCount } = await query(
      `UPDATE instructors
       SET plan = 'basic',
           saas_billing_status = 'cancelled',
           apple_product_id = NULL,
           updated_at = now()
       WHERE apple_original_transaction_id = $1`,
      [originalTransactionId],
    );
    if (rowCount) return { processed: true, kind: 'instructor' };
  }

  if (kind === 'gym' || !kind) {
    const { rowCount } = await query(
      `UPDATE institutions
       SET saas_tier = 'basic',
           saas_billing_status = 'cancelled',
           apple_product_id = NULL,
           updated_at = now()
       WHERE apple_original_transaction_id = $1`,
      [originalTransactionId],
    );
    if (rowCount) return { processed: true, kind: 'gym' };
  }

  return { processed: false };
}

function getCatalog(kind) {
  return {
    productIds: listProductIds({ kind }),
    bundleId: getAppleIapConfig().bundleId,
  };
}

module.exports = {
  decodeJwsPayload,
  parseAndValidatePurchase,
  verifyAndActivate,
  restorePurchases,
  downgradeExpiredAppleSubscription,
  getCatalog,
};
