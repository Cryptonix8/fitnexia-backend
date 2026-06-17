const PLANS = [
  { id: 'basic', name: 'Básico', monthlyFeeCents: 0, commissionPercent: 15 },
  { id: 'pro', name: 'Pro', monthlyFeeCents: 2900, commissionPercent: 8 },
  { id: 'institutional', name: 'Institucional', monthlyFeeCents: 9900, commissionPercent: 5 },
];

function getPlans() {
  return PLANS;
}

function getCommissionPercent(plan) {
  const match = PLANS.find((p) => p.id === plan);
  return match?.commissionPercent ?? 15;
}

module.exports = { PLANS, getPlans, getCommissionPercent };
