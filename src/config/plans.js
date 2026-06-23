const PLANS = [
  { id: 'basic', name: 'Básico', monthlyFeeCents: 0, commissionPercent: 10 },
  { id: 'pro', name: 'Pro', monthlyFeeCents: 2900, commissionPercent: 8 },
  { id: 'institutional', name: 'Institucional', monthlyFeeCents: 9900, commissionPercent: 5 },
];

function getBasicCommissionPercent() {
  const fromEnv = Number(process.env.BASIC_COMMISSION_PERCENT);
  if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 100) {
    return fromEnv;
  }
  return 10;
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

/** Gyms on SaaS tiers pay no transaction commission to Fitnexia. */
function getInstitutionCommissionPercent(institutionRow) {
  if (institutionRow?.saas_tier) return 0;
  return getCommissionPercent(institutionRow?.plan || 'institutional');
}

module.exports = {
  PLANS,
  getPlans,
  getCommissionPercent,
  getInstitutionCommissionPercent,
};
