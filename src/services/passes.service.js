const { query } = require('../db/pool');
const { badRequest, notFound } = require('../utils/errors');
const { defaultCurrency } = require('../config/env');
const { serializeMoney } = require('../utils/serializers');

const PASS_PRODUCTS = {
  monthly_unlimited: {
    id: 'monthly_unlimited',
    paymentModel: 'monthly_unlimited',
    name: 'Pase mensual ilimitado',
    priceCents: 500000,
    periodDays: 30,
    unlimited: true,
  },
  per_period: {
    week: {
      periodType: 'week',
      name: 'Pase semanal',
      priceCents: 120000,
      periodDays: 7,
      classCredits: 4,
    },
    month: {
      periodType: 'month',
      name: 'Pase mensual',
      priceCents: 350000,
      periodDays: 30,
      classCredits: 12,
    },
    quarter: {
      periodType: 'quarter',
      name: 'Pase trimestral',
      priceCents: 900000,
      periodDays: 90,
      classCredits: 36,
    },
  },
};

function getPassProducts() {
  const currency = defaultCurrency;
  return {
    monthly_unlimited: {
      ...PASS_PRODUCTS.monthly_unlimited,
      currency,
      price: serializeMoney(PASS_PRODUCTS.monthly_unlimited.priceCents, currency),
    },
    per_period: Object.fromEntries(
      Object.entries(PASS_PRODUCTS.per_period).map(([key, product]) => [
        key,
        {
          ...product,
          currency,
          price: serializeMoney(product.priceCents, currency),
        },
      ]),
    ),
  };
}

function resolvePassProduct(paymentModel, periodType) {
  if (paymentModel === 'monthly_unlimited') {
    return PASS_PRODUCTS.monthly_unlimited;
  }
  if (paymentModel === 'per_period') {
    if (!periodType || !PASS_PRODUCTS.per_period[periodType]) {
      throw badRequest('periodType is required for per_period (week, month, quarter)');
    }
    return PASS_PRODUCTS.per_period[periodType];
  }
  throw badRequest('Invalid payment model for passes');
}

async function expireStalePasses(athleteUserId) {
  await query(
    `UPDATE athlete_passes
     SET status = 'expired', updated_at = now()
     WHERE athlete_user_id = $1
       AND status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < now()`,
    [athleteUserId],
  );
}

function serializePass(row) {
  return {
    id: row.id,
    paymentModel: row.payment_model,
    periodType: row.period_type || undefined,
    status: row.status,
    price: serializeMoney(row.price_cents, row.price_currency),
    classCreditsTotal: row.class_credits_total,
    classCreditsUsed: row.class_credits_used,
    classCreditsRemaining:
      row.class_credits_total == null
        ? null
        : Math.max(0, row.class_credits_total - row.class_credits_used),
    startsAt: row.starts_at?.toISOString(),
    expiresAt: row.expires_at?.toISOString(),
    checkoutUrl: row.checkout_url || undefined,
    createdAt: row.created_at.toISOString(),
  };
}

async function getActivePass(athleteUserId, paymentModel, periodType = null) {
  await expireStalePasses(athleteUserId);

  const values = [athleteUserId, paymentModel];
  let periodFilter = '';
  if (paymentModel === 'per_period' && periodType) {
    periodFilter = 'AND period_type = $3';
    values.push(periodType);
  }

  const { rows } = await query(
    `SELECT * FROM athlete_passes
     WHERE athlete_user_id = $1
       AND payment_model = $2
       ${periodFilter}
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > now())
       AND (
         class_credits_total IS NULL
         OR class_credits_used < class_credits_total
       )
     ORDER BY expires_at DESC NULLS LAST
     LIMIT 1`,
    values,
  );

  return rows[0] || null;
}

async function listMyPasses(athleteUserId) {
  await expireStalePasses(athleteUserId);
  const { rows } = await query(
    `SELECT * FROM athlete_passes
     WHERE athlete_user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [athleteUserId],
  );
  return rows.map(serializePass);
}

async function getMyActivePasses(athleteUserId) {
  await expireStalePasses(athleteUserId);
  const { rows } = await query(
    `SELECT * FROM athlete_passes
     WHERE athlete_user_id = $1
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > now())
       AND (
         class_credits_total IS NULL
         OR class_credits_used < class_credits_total
       )
     ORDER BY expires_at ASC`,
    [athleteUserId],
  );
  return rows.map(serializePass);
}

async function createPendingPass(client, athleteUserId, paymentModel, periodType) {
  const product = resolvePassProduct(paymentModel, periodType);
  const currency = defaultCurrency;

  const { rows } = await client.query(
    `INSERT INTO athlete_passes (
      athlete_user_id, payment_model, period_type, status,
      price_cents, price_currency, class_credits_total
    ) VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6)
    RETURNING *`,
    [
      athleteUserId,
      paymentModel,
      paymentModel === 'per_period' ? product.periodType : null,
      product.priceCents,
      currency,
      product.unlimited ? null : product.classCredits,
    ],
  );

  return { pass: rows[0], product };
}

async function activatePass(passId, providerPaymentId = null) {
  const { rows } = await query(`SELECT * FROM athlete_passes WHERE id = $1 FOR UPDATE`, [passId]);
  if (!rows.length) throw notFound('Pass not found');
  const pass = rows[0];

  if (pass.status === 'active') return pass;

  const product = resolvePassProduct(
    pass.payment_model,
    pass.period_type || undefined,
  );
  const startsAt = new Date();
  const expiresAt = new Date(startsAt);
  expiresAt.setDate(expiresAt.getDate() + product.periodDays);

  const { rows: updated } = await query(
    `UPDATE athlete_passes
     SET status = 'active',
         starts_at = $2,
         expires_at = $3,
         provider_payment_id = COALESCE($4, provider_payment_id),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [passId, startsAt, expiresAt, providerPaymentId],
  );

  return updated[0];
}

async function consumeCredit(passId) {
  const { rows } = await query(
    `UPDATE athlete_passes
     SET class_credits_used = class_credits_used + 1,
         updated_at = now()
     WHERE id = $1
       AND status = 'active'
       AND (
         class_credits_total IS NULL
         OR class_credits_used < class_credits_total
       )
     RETURNING *`,
    [passId],
  );
  if (!rows.length) {
    throw badRequest('Pass has no remaining class credits');
  }
  return rows[0];
}

async function getPassById(passId) {
  const { rows } = await query(`SELECT * FROM athlete_passes WHERE id = $1`, [passId]);
  if (!rows.length) throw notFound('Pass not found');
  return rows[0];
}

module.exports = {
  getPassProducts,
  resolvePassProduct,
  getActivePass,
  listMyPasses,
  getMyActivePasses,
  createPendingPass,
  activatePass,
  consumeCredit,
  getPassById,
  serializePass,
  expireStalePasses,
};
