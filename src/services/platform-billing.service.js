/**
 * @fileoverview Fitnexia platform SaaS billing (gym tiers + instructor plans).
 * Money goes to Fitnexia's Mercado Pago account via Checkout Pro / Preapproval.
 * Athlete class fees use marketplace splits separately.
 */
const { query } = require('../db/pool');
const { badRequest, notFound } = require('../utils/errors');
const { getGymTier, isValidGymTier } = require('../config/gym-tiers');
const { getPlans } = require('../config/plans');
const { defaultCurrency } = require('../config/env');
const {
  isMercadoPagoConfigured,
  useMockPayments,
  createPreapproval,
  createCheckoutPreference,
  buildPlatformBillingBackUrl,
} = require('./mercadopago.service');
const institutionsService = require('./institutions.service');
const { getInstructorByUserId } = require('./instructors.service');

const SAAS_REF_GYM = 'gymsaas:';
const SAAS_REF_INSTRUCTOR = 'instrplan:';

function isPaymentsActive() {
  const { paymentsEnabled } = require('../config/env');
  return paymentsEnabled && (isMercadoPagoConfigured() || useMockPayments());
}

function serializeBillingFields(row, kind) {
  const feeCents =
    kind === 'gym'
      ? getGymTier(row.saas_tier || 'basic').monthlyFeeCents
      : getPlans().find((p) => p.id === row.plan)?.monthlyFeeCents ?? 0;

  const status = row.saas_billing_status || (feeCents === 0 ? 'not_required' : 'inactive');
  return {
    billingStatus: status,
    monthlyFeeCents: feeCents,
    authorizationUrl: row.saas_authorization_url || undefined,
    preapprovalId: row.saas_mp_preapproval_id || undefined,
    lastBilledAt: row.saas_last_billed_at?.toISOString?.() || undefined,
    nextBillingAt: row.saas_next_billing_at?.toISOString?.() || undefined,
  };
}

async function startGymTierBilling(userId, tierId) {
  if (!isValidGymTier(tierId)) throw badRequest('Invalid gym tier');
  if (!isPaymentsActive()) throw badRequest('Payments are not configured');

  const institution = await institutionsService.getInstitutionByUserId(userId);
  const tier = getGymTier(tierId.toLowerCase());

  if (tier.monthlyFeeCents === 0) {
    await query(
      `UPDATE institutions
       SET saas_tier = $2::gym_saas_tier,
           saas_billing_status = 'not_required',
           saas_mp_preapproval_id = NULL,
           saas_authorization_url = NULL,
           saas_pending_tier = NULL,
           updated_at = now()
       WHERE id = $1`,
      [institution.id, tier.id],
    );
    return {
      tier: tier.id,
      ...serializeBillingFields(
        { ...institution, saas_tier: tier.id, saas_billing_status: 'not_required' },
        'gym',
      ),
      checkoutUrl: null,
    };
  }

  const externalReference = `${SAAS_REF_GYM}${institution.id}:${tier.id}`;
  let authorizationUrl = null;
  let preapprovalId = null;
  let checkoutUrl = null;

  if (isMercadoPagoConfigured()) {
    const userRows = await query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const payerEmail = userRows[0]?.email;
    const preapproval = await createPreapproval({
      externalReference,
      reason: `Fitnexia — Plan ${tier.name}`,
      amountCents: tier.monthlyFeeCents,
      currency: defaultCurrency,
      payerEmail,
      billingFrequency: 'monthly',
      backUrl: buildPlatformBillingBackUrl('gym', institution.id, 'success'),
    });
    preapprovalId = preapproval.preapprovalId;
    authorizationUrl = preapproval.authorizationUrl;
    checkoutUrl = authorizationUrl;
  } else if (useMockPayments()) {
    checkoutUrl = `${require('../config/env').apiPublicUrl}/v1/platform-billing/mock-checkout/gym/${institution.id}?tier=${tier.id}`;
    authorizationUrl = checkoutUrl;
  }

  await query(
    `UPDATE institutions
     SET saas_pending_tier = $2::gym_saas_tier,
         saas_billing_status = 'pending',
         saas_mp_preapproval_id = $3,
         saas_authorization_url = $4,
         updated_at = now()
     WHERE id = $1`,
    [institution.id, tier.id, preapprovalId, authorizationUrl],
  );

  return {
    tier: institution.saas_tier,
    pendingTier: tier.id,
    ...serializeBillingFields(
      {
        ...institution,
        saas_billing_status: 'pending',
        saas_authorization_url: authorizationUrl,
        saas_mp_preapproval_id: preapprovalId,
      },
      'gym',
    ),
    checkoutUrl,
    authorizationUrl,
  };
}

async function startInstructorPlanBilling(userId, planId) {
  const plans = getPlans();
  const plan = plans.find((p) => p.id === planId);
  if (!plan) throw badRequest('Invalid instructor plan');
  if (!isPaymentsActive()) throw badRequest('Payments are not configured');

  const instructor = await getInstructorByUserId(userId);

  if (plan.monthlyFeeCents === 0) {
    await query(
      `UPDATE instructors
       SET plan = $2::instructor_plan,
           saas_billing_status = 'not_required',
           saas_mp_preapproval_id = NULL,
           saas_authorization_url = NULL,
           saas_pending_plan = NULL,
           updated_at = now()
       WHERE id = $1`,
      [instructor.id, plan.id],
    );
    return {
      plan: plan.id,
      ...serializeBillingFields(
        { ...instructor, plan: plan.id, saas_billing_status: 'not_required' },
        'instructor',
      ),
      checkoutUrl: null,
    };
  }

  const externalReference = `${SAAS_REF_INSTRUCTOR}${instructor.id}:${plan.id}`;
  let authorizationUrl = null;
  let preapprovalId = null;
  let checkoutUrl = null;

  if (isMercadoPagoConfigured()) {
    const userRows = await query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const payerEmail = userRows[0]?.email;
    const preapproval = await createPreapproval({
      externalReference,
      reason: `Fitnexia — Plan ${plan.name}`,
      amountCents: plan.monthlyFeeCents,
      currency: defaultCurrency,
      payerEmail,
      billingFrequency: 'monthly',
      backUrl: buildPlatformBillingBackUrl('instructor', instructor.id, 'success'),
    });
    preapprovalId = preapproval.preapprovalId;
    authorizationUrl = preapproval.authorizationUrl;
    checkoutUrl = authorizationUrl;
  } else if (useMockPayments()) {
    checkoutUrl = `${require('../config/env').apiPublicUrl}/v1/platform-billing/mock-checkout/instructor/${instructor.id}?plan=${plan.id}`;
    authorizationUrl = checkoutUrl;
  }

  await query(
    `UPDATE instructors
     SET saas_pending_plan = $2::instructor_plan,
         saas_billing_status = 'pending',
         saas_mp_preapproval_id = $3,
         saas_authorization_url = $4,
         updated_at = now()
     WHERE id = $1`,
    [instructor.id, plan.id, preapprovalId, authorizationUrl],
  );

  return {
    plan: instructor.plan,
    pendingPlan: plan.id,
    ...serializeBillingFields(
      {
        ...instructor,
        saas_billing_status: 'pending',
        saas_authorization_url: authorizationUrl,
        saas_mp_preapproval_id: preapprovalId,
      },
      'instructor',
    ),
    checkoutUrl,
    authorizationUrl,
  };
}

async function activateGymBilling(institutionId, { preapprovalId, tierId } = {}) {
  const { rows } = await query(`SELECT * FROM institutions WHERE id = $1`, [institutionId]);
  if (!rows.length) throw notFound('Institution not found');
  const institution = rows[0];
  const nextTier = (tierId || institution.saas_pending_tier || institution.saas_tier || 'basic').toLowerCase();

  await query(
    `UPDATE institutions
     SET saas_tier = $2::gym_saas_tier,
         saas_pending_tier = NULL,
         saas_billing_status = 'active',
         saas_mp_preapproval_id = COALESCE($3, saas_mp_preapproval_id),
         saas_last_billed_at = now(),
         saas_next_billing_at = now() + interval '1 month',
         updated_at = now()
     WHERE id = $1`,
    [institutionId, nextTier, preapprovalId || null],
  );

  return { activated: true, kind: 'gym', ownerId: institutionId, tier: nextTier };
}

async function activateInstructorBilling(instructorId, { preapprovalId, planId } = {}) {
  const { rows } = await query(`SELECT * FROM instructors WHERE id = $1`, [instructorId]);
  if (!rows.length) throw notFound('Instructor not found');
  const instructor = rows[0];
  const nextPlan = (planId || instructor.saas_pending_plan || instructor.plan || 'basic').toLowerCase();

  await query(
    `UPDATE instructors
     SET plan = $2::instructor_plan,
         saas_pending_plan = NULL,
         saas_billing_status = 'active',
         saas_mp_preapproval_id = COALESCE($3, saas_mp_preapproval_id),
         saas_last_billed_at = now(),
         saas_next_billing_at = now() + interval '1 month',
         updated_at = now()
     WHERE id = $1`,
    [instructorId, nextPlan, preapprovalId || null],
  );

  return { activated: true, kind: 'instructor', ownerId: instructorId, plan: nextPlan };
}

/** Paused preapproval → past_due (keep tier). Cancelled → downgrade to free Basic. */
async function suspendGymBilling(institutionId, { cancelled = false } = {}) {
  if (cancelled) {
    await query(
      `UPDATE institutions
       SET saas_tier = 'basic',
           saas_pending_tier = NULL,
           saas_billing_status = 'cancelled',
           saas_mp_preapproval_id = NULL,
           saas_authorization_url = NULL,
           updated_at = now()
       WHERE id = $1`,
      [institutionId],
    );
    return { processed: true, kind: 'gym', ownerId: institutionId, status: 'cancelled' };
  }

  await query(
    `UPDATE institutions
     SET saas_billing_status = 'past_due', updated_at = now()
     WHERE id = $1`,
    [institutionId],
  );
  return { processed: true, kind: 'gym', ownerId: institutionId, status: 'past_due' };
}

async function suspendInstructorBilling(instructorId, { cancelled = false } = {}) {
  if (cancelled) {
    await query(
      `UPDATE instructors
       SET plan = 'basic',
           saas_pending_plan = NULL,
           saas_billing_status = 'cancelled',
           saas_mp_preapproval_id = NULL,
           saas_authorization_url = NULL,
           updated_at = now()
       WHERE id = $1`,
      [instructorId],
    );
    return { processed: true, kind: 'instructor', ownerId: instructorId, status: 'cancelled' };
  }

  await query(
    `UPDATE instructors
     SET saas_billing_status = 'past_due', updated_at = now()
     WHERE id = $1`,
    [instructorId],
  );
  return { processed: true, kind: 'instructor', ownerId: instructorId, status: 'past_due' };
}

async function processPlatformPreapproval(preapproval) {
  const externalReference = String(preapproval.external_reference || '');
  const status = String(preapproval.status || '').toLowerCase();
  const preapprovalId = String(preapproval.id || '');

  const isGym = externalReference.startsWith(SAAS_REF_GYM);
  const isInstructor = externalReference.startsWith(SAAS_REF_INSTRUCTOR);
  if (!isGym && !isInstructor) {
    return { processed: false, reason: 'not_platform_saas' };
  }

  const rest = isGym
    ? externalReference.slice(SAAS_REF_GYM.length)
    : externalReference.slice(SAAS_REF_INSTRUCTOR.length);
  const [ownerId, planOrTierId] = rest.split(':');

  if (['authorized', 'active'].includes(status)) {
    return isGym
      ? activateGymBilling(ownerId, { preapprovalId, tierId: planOrTierId })
      : activateInstructorBilling(ownerId, { preapprovalId, planId: planOrTierId });
  }

  if (['cancelled', 'paused'].includes(status)) {
    const cancelled = status === 'cancelled';
    return isGym
      ? suspendGymBilling(ownerId, { cancelled })
      : suspendInstructorBilling(ownerId, { cancelled });
  }

  return { processed: false, reason: 'preapproval_not_active', status };
}

async function processPlatformPaymentReference(externalReference, providerPaymentId) {
  const ref = String(externalReference || '');
  if (ref.startsWith(SAAS_REF_GYM)) {
    const [institutionId, tierId] = ref.slice(SAAS_REF_GYM.length).split(':');
    return activateGymBilling(institutionId, { tierId });
  }
  if (ref.startsWith(SAAS_REF_INSTRUCTOR)) {
    const [instructorId, planId] = ref.slice(SAAS_REF_INSTRUCTOR.length).split(':');
    return activateInstructorBilling(instructorId, { planId });
  }
  return { processed: false, reason: 'not_platform_saas', providerPaymentId };
}

/** One-time Checkout Pro fallback if preapproval is unavailable. */
async function createGymTierCheckout(userId, tierId) {
  if (!isValidGymTier(tierId)) throw badRequest('Invalid gym tier');
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const tier = getGymTier(tierId.toLowerCase());
  if (tier.monthlyFeeCents === 0) {
    return startGymTierBilling(userId, tierId);
  }

  const externalReference = `${SAAS_REF_GYM}${institution.id}:${tier.id}`;
  if (!isMercadoPagoConfigured()) {
    return startGymTierBilling(userId, tierId);
  }

  const preference = await createCheckoutPreference({
    externalReference,
    title: `Fitnexia — Plan ${tier.name}`,
    amountCents: tier.monthlyFeeCents,
    currency: defaultCurrency,
    platformBillingKind: 'gym',
    platformBillingOwnerId: institution.id,
  });

  await query(
    `UPDATE institutions
     SET saas_pending_tier = $2::gym_saas_tier,
         saas_billing_status = 'pending',
         saas_authorization_url = $3,
         updated_at = now()
     WHERE id = $1`,
    [institution.id, tier.id, preference.checkoutUrl],
  );

  return {
    tier: institution.saas_tier,
    pendingTier: tier.id,
    billingStatus: 'pending',
    checkoutUrl: preference.checkoutUrl,
    preferenceId: preference.preferenceId,
  };
}

module.exports = {
  SAAS_REF_GYM,
  SAAS_REF_INSTRUCTOR,
  serializeBillingFields,
  startGymTierBilling,
  startInstructorPlanBilling,
  activateGymBilling,
  activateInstructorBilling,
  suspendGymBilling,
  suspendInstructorBilling,
  processPlatformPreapproval,
  processPlatformPaymentReference,
  createGymTierCheckout,
  isPaymentsActive,
};
