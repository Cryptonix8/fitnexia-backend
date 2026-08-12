const { getGymCommissionPercent } = require('./gym-tiers');

/**
 * Instructor plans (client model):
 * - Freemium (basic): free app use, 8% commission on completed class payments
 * - Pro: $29/mo, 0% commission on class payments
 * Institutional kept for legacy / gym-linked plan field; not shown on instructor plan UI.
 */
const PLANS = [
  { id: 'basic', name: 'Freemium', monthlyFeeCents: 0, commissionPercent: 8 },
  { id: 'pro', name: 'Pro', monthlyFeeCents: 2900, commissionPercent: 0 },
  { id: 'institutional', name: 'Institucional', monthlyFeeCents: 9900, commissionPercent: 5 },
];

function getBasicCommissionPercent() {
  const fromEnv = Number(process.env.BASIC_COMMISSION_PERCENT);
  if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 100) {
    return fromEnv;
  }
  return 8;
}

function getPlans() {
  return PLANS.map((plan) =>
    plan.id === 'basic' ? { ...plan, commissionPercent: getBasicCommissionPercent() } : plan,
  );
}

function getCommissionPercent(plan) {
  const match = getPlans().find((p) => p.id === plan);
  return match?.commissionPercent ?? getBasicCommissionPercent();
}

/**
 * Gyms pay Fitnexia monthly SaaS (when tier fee > 0) plus a transaction commission
 * based on their saas_tier. Legacy institutions without saas_tier fall back to plan %.
 */
function getInstitutionCommissionPercent(institutionRow) {
  if (institutionRow?.saas_tier) {
    return getGymCommissionPercent(institutionRow.saas_tier);
  }
  return getCommissionPercent(institutionRow?.plan || 'institutional');
}

module.exports = {
  PLANS,
  getPlans,
  getCommissionPercent,
  getInstitutionCommissionPercent,
};
