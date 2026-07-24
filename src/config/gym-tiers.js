const GYM_TIERS = [
  {
    id: 'basic',
    name: 'Basic',
    // Free entry tier — Fitnexia earns via transaction commission (see commissionPercent).
    monthlyFeeCents: 0,
    commissionPercent: 10,
    memberLimit: 100,
    entitlements: {
      manualPayments: true,
      clubProfile: true,
      jobPostings: true,
      recurringBilling: false,
      reportsBasic: false,
      prioritySupport: false,
      branding: false,
      reportsAdvanced: false,
      activities: false,
      integrations: false,
    },
  },
  {
    id: 'professional',
    name: 'Professional',
    monthlyFeeCents: 9900,
    commissionPercent: 8,
    memberLimit: 500,
    entitlements: {
      manualPayments: true,
      clubProfile: true,
      jobPostings: true,
      recurringBilling: true,
      reportsBasic: true,
      prioritySupport: true,
      branding: false,
      reportsAdvanced: false,
      activities: false,
      integrations: false,
    },
  },
  {
    id: 'premium',
    name: 'Premium',
    monthlyFeeCents: 14900,
    commissionPercent: 5,
    memberLimit: 1999,
    entitlements: {
      manualPayments: true,
      clubProfile: true,
      jobPostings: true,
      recurringBilling: true,
      reportsBasic: true,
      prioritySupport: true,
      branding: true,
      reportsAdvanced: true,
      activities: true,
      integrations: false,
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyFeeCents: 24900,
    commissionPercent: 3,
    memberLimit: null,
    entitlements: {
      manualPayments: true,
      clubProfile: true,
      jobPostings: true,
      recurringBilling: true,
      reportsBasic: true,
      prioritySupport: true,
      branding: true,
      reportsAdvanced: true,
      activities: true,
      integrations: true,
    },
  },
];

const VALID_TIER_IDS = GYM_TIERS.map((t) => t.id);

function getGymTiers() {
  return GYM_TIERS;
}

function getGymTier(tierId) {
  const id = (tierId || 'basic').toLowerCase();
  return GYM_TIERS.find((t) => t.id === id) ?? GYM_TIERS[0];
}

function getMemberLimitForTier(tierId) {
  return getGymTier(tierId).memberLimit;
}

function getEntitlements(tierId) {
  return { ...getGymTier(tierId).entitlements };
}

function hasEntitlement(tierId, key) {
  return Boolean(getGymTier(tierId).entitlements[key]);
}

function isValidGymTier(tierId) {
  return VALID_TIER_IDS.includes(String(tierId || '').toLowerCase());
}

function getGymCommissionPercent(tierId) {
  const tier = getGymTier(tierId);
  return Number.isFinite(tier.commissionPercent) ? tier.commissionPercent : 10;
}

module.exports = {
  GYM_TIERS,
  VALID_TIER_IDS,
  getGymTiers,
  getGymTier,
  getMemberLimitForTier,
  getEntitlements,
  hasEntitlement,
  isValidGymTier,
  getGymCommissionPercent,
};
