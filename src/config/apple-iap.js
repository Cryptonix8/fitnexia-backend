/**
 * App Store product IDs for Fitnexia SaaS subscriptions (iOS IAP).
 * Create matching Auto-Renewable Subscriptions in App Store Connect.
 *
 * Override via env JSON if needed:
 *   APPLE_IAP_PRODUCT_MAP={"fitnexia.instructor.pro.monthly":{"kind":"instructor","plan":"pro"},...}
 */
const DEFAULT_PRODUCT_MAP = {
  'fitnexia.instructor.pro.monthly': { kind: 'instructor', plan: 'pro' },
  'fitnexia.gym.professional.monthly': { kind: 'gym', tier: 'professional' },
  'fitnexia.gym.premium.monthly': { kind: 'gym', tier: 'premium' },
  'fitnexia.gym.enterprise.monthly': { kind: 'gym', tier: 'enterprise' },
};

function loadProductMap() {
  const raw = process.env.APPLE_IAP_PRODUCT_MAP;
  if (!raw) return DEFAULT_PRODUCT_MAP;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : DEFAULT_PRODUCT_MAP;
  } catch {
    return DEFAULT_PRODUCT_MAP;
  }
}

const PRODUCT_MAP = loadProductMap();

function getAppleIapConfig() {
  return {
    bundleId: (process.env.APPLE_IAP_BUNDLE_ID || process.env.APPLE_CLIENT_ID || 'com.fitunion.mobile').trim(),
    /** When true (or NODE_ENV !== production and unset), accept client payload without Apple crypto verify. */
    allowUnverified:
      process.env.APPLE_IAP_ALLOW_UNVERIFIED === 'true' ||
      (process.env.APPLE_IAP_ALLOW_UNVERIFIED !== 'false' && process.env.NODE_ENV !== 'production'),
    productMap: PRODUCT_MAP,
  };
}

function resolveProduct(productId) {
  return PRODUCT_MAP[productId] || null;
}

function listProductIds({ kind } = {}) {
  return Object.entries(PRODUCT_MAP)
    .filter(([, meta]) => !kind || meta.kind === kind)
    .map(([id]) => id);
}

function productIdForInstructorPlan(planId) {
  const entry = Object.entries(PRODUCT_MAP).find(
    ([, meta]) => meta.kind === 'instructor' && meta.plan === planId,
  );
  return entry?.[0] || null;
}

function productIdForGymTier(tierId) {
  const entry = Object.entries(PRODUCT_MAP).find(
    ([, meta]) => meta.kind === 'gym' && meta.tier === tierId,
  );
  return entry?.[0] || null;
}

module.exports = {
  DEFAULT_PRODUCT_MAP,
  getAppleIapConfig,
  resolveProduct,
  listProductIds,
  productIdForInstructorPlan,
  productIdForGymTier,
};
