const { query } = require('../db/pool');
const { badRequest, notFound, conflict } = require('../utils/errors');
const {
  getGymTier,
  getGymTiers,
  getMemberLimitForTier,
  getEntitlements,
  isValidGymTier,
  getGymCommissionPercent,
} = require('../config/gym-tiers');
const institutionsService = require('./institutions.service');
const platformBillingService = require('./platform-billing.service');

async function countBillableMembers(institutionId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
     FROM club_members
     WHERE institution_id = $1
       AND left_at IS NULL
       AND status != 'inactive'`,
    [institutionId],
  );
  return rows[0].total;
}

function serializeSubscription(institution, memberCount) {
  const tier = getGymTier(institution.saas_tier || 'basic');
  const limit = tier.memberLimit;
  const billing = platformBillingService.serializeBillingFields(institution, 'gym');
  return {
    tier: tier.id,
    tierName: tier.name,
    monthlyFeeCents: tier.monthlyFeeCents,
    commissionPercent: getGymCommissionPercent(tier.id),
    memberCount,
    memberLimit: limit,
    membersRemaining: limit != null ? Math.max(0, limit - memberCount) : null,
    atLimit: limit != null && memberCount >= limit,
    entitlements: getEntitlements(tier.id),
    billingStatus: billing.billingStatus,
    authorizationUrl: billing.authorizationUrl,
    pendingTier: institution.saas_pending_tier || undefined,
    lastBilledAt: billing.lastBilledAt,
    nextBillingAt: billing.nextBillingAt,
  };
}

async function getSubscriptionForUser(userId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const memberCount = await countBillableMembers(institution.id);
  return serializeSubscription(institution, memberCount);
}

async function getSubscriptionForInstitution(institutionId) {
  const { rows } = await query(`SELECT * FROM institutions WHERE id = $1`, [institutionId]);
  if (!rows.length) throw notFound('Institution not found');
  const memberCount = await countBillableMembers(institutionId);
  return serializeSubscription(rows[0], memberCount);
}

async function assertCanAddMembers(institutionId, additional = 1) {
  const { rows } = await query(`SELECT saas_tier FROM institutions WHERE id = $1`, [institutionId]);
  if (!rows.length) throw notFound('Institution not found');

  const limit = getMemberLimitForTier(rows[0].saas_tier);
  if (limit == null) return;

  const current = await countBillableMembers(institutionId);
  if (current + additional > limit) {
    throw conflict(
      'MEMBER_LIMIT_REACHED',
      `Your plan allows up to ${limit} members. Upgrade to add more.`,
      { memberCount: current, memberLimit: limit },
    );
  }
}

async function updateTierForUser(userId, tierId) {
  if (!isValidGymTier(tierId)) {
    throw badRequest('Invalid gym tier');
  }
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const nextTier = tierId.toLowerCase();
  const limit = getMemberLimitForTier(nextTier);
  if (limit != null) {
    const current = await countBillableMembers(institution.id);
    if (current > limit) {
      throw badRequest(
        `Cannot switch to this plan: you have ${current} members but the limit is ${limit}.`,
      );
    }
  }

  const next = getGymTier(nextTier);
  if (next.monthlyFeeCents > 0) {
    const billing = await platformBillingService.startGymTierBilling(userId, nextTier);
    const subscription = await getSubscriptionForInstitution(institution.id);
    return {
      ...subscription,
      checkoutUrl: billing.checkoutUrl || billing.authorizationUrl,
      pendingTier: billing.pendingTier,
    };
  }

  await query(
    `UPDATE institutions
     SET saas_tier = $2::gym_saas_tier,
         saas_billing_status = 'not_required',
         saas_pending_tier = NULL,
         saas_mp_preapproval_id = NULL,
         saas_authorization_url = NULL,
         updated_at = now()
     WHERE id = $1`,
    [institution.id, nextTier],
  );

  return getSubscriptionForInstitution(institution.id);
}

async function updateTierByInstitutionId(institutionId, tierId) {
  if (!isValidGymTier(tierId)) {
    throw badRequest('Invalid gym tier');
  }
  const nextTier = tierId.toLowerCase();
  const limit = getMemberLimitForTier(nextTier);
  if (limit != null) {
    const current = await countBillableMembers(institutionId);
    if (current > limit) {
      throw badRequest(
        `Cannot assign this plan: institution has ${current} members but the limit is ${limit}.`,
      );
    }
  }

  const next = getGymTier(nextTier);
  const { rowCount } = await query(
    `UPDATE institutions
     SET saas_tier = $2::gym_saas_tier,
         saas_billing_status = $3::saas_billing_status,
         saas_pending_tier = NULL,
         updated_at = now()
     WHERE id = $1`,
    [institutionId, nextTier, next.monthlyFeeCents > 0 ? 'inactive' : 'not_required'],
  );
  if (!rowCount) throw notFound('Institution not found');
  return getSubscriptionForInstitution(institutionId);
}

function listTierCatalog() {
  return getGymTiers().map((tier) => ({
    id: tier.id,
    name: tier.name,
    monthlyFeeCents: tier.monthlyFeeCents,
    commissionPercent: tier.commissionPercent,
    memberLimit: tier.memberLimit,
    entitlements: tier.entitlements,
  }));
}

module.exports = {
  countBillableMembers,
  getSubscriptionForUser,
  getSubscriptionForInstitution,
  assertCanAddMembers,
  updateTierForUser,
  updateTierByInstitutionId,
  listTierCatalog,
};
