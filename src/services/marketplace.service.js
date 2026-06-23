const { query } = require('../db/pool');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { getCommissionPercent, getInstitutionCommissionPercent } = require('../config/plans');
const {
  isMarketplaceEnabled,
  requireSellerConnect,
  getGymPayeePolicy,
  getPassRevenuePolicy,
} = require('../config/marketplace.config');

function getCommissionRate(plan, sellerType, institutionRow) {
  if (sellerType === 'institution' && institutionRow) {
    return getInstitutionCommissionPercent(institutionRow) / 100;
  }
  return getCommissionPercent(plan) / 100;
}

function computeSplitAmounts(grossCents, plan, sellerType, institutionRow) {
  const commissionRate = getCommissionRate(plan, sellerType, institutionRow);
  const platformFeeCents = Math.round(grossCents * commissionRate);
  const sellerNetCents = grossCents - platformFeeCents;
  return { platformFeeCents, sellerNetCents, commissionRate };
}

async function loadInstructor(instructorId) {
  const { rows } = await query(`SELECT * FROM instructors WHERE id = $1`, [instructorId]);
  if (!rows.length) throw notFound('Instructor not found');
  return rows[0];
}

async function loadInstitution(institutionId) {
  const { rows } = await query(`SELECT * FROM institutions WHERE id = $1`, [institutionId]);
  if (!rows.length) throw notFound('Institution not found');
  return rows[0];
}

async function resolvePayeeForClass(classRow) {
  const instructor = await loadInstructor(classRow.instructor_id);
  const institution = classRow.institution_id
    ? await loadInstitution(classRow.institution_id)
    : null;
  const policy = getGymPayeePolicy();

  if (institution && policy === 'institution') {
    return {
      sellerType: 'institution',
      seller: institution,
      plan: institution.plan,
      institution,
    };
  }

  if (institution && policy === 'instructor') {
    return {
      sellerType: 'instructor',
      seller: instructor,
      plan: instructor.plan,
      institution,
    };
  }

  if (institution && policy === 'split') {
    throw badRequest(
      'Gym/instructor split payouts require additional Mercado Pago configuration. Use institution or instructor policy for now.',
    );
  }

  return {
    sellerType: 'instructor',
    seller: instructor,
    plan: instructor.plan,
  };
}

function isSellerConnected(seller) {
  return seller.mp_connection_status === 'connected' && Boolean(seller.mp_collector_id);
}

function assertSellerConnected(payee) {
  if (!requireSellerConnect() || !isMarketplaceEnabled()) return;
  if (!isSellerConnected(payee.seller)) {
    throw conflict(
      'SELLER_NOT_CONNECTED',
      'The class provider has not connected Mercado Pago to receive payouts yet.',
    );
  }
}

async function resolveCheckoutSplit(classRow, grossCents, { isPassPurchase = false } = {}) {
  if (!isMarketplaceEnabled()) {
    return { splitMode: 'single_collector' };
  }

  if (isPassPurchase && getPassRevenuePolicy() === 'platform_ledger') {
    return { splitMode: 'single_collector' };
  }

  const payee = await resolvePayeeForClass(classRow);
  assertSellerConnected(payee);

  const { platformFeeCents, sellerNetCents } = computeSplitAmounts(
    grossCents,
    payee.plan,
    payee.sellerType,
    payee.institution,
  );

  return {
    splitMode: 'marketplace',
    sellerType: payee.sellerType,
    sellerCollectorId: payee.seller.mp_collector_id,
    platformFeeCents,
    sellerNetCents,
    marketplaceFee: platformFeeCents / 100,
    collectorId: payee.seller.mp_collector_id,
  };
}

async function assertClassSellerCanReceivePayment(classRow, options = {}) {
  if (!isMarketplaceEnabled() || !requireSellerConnect()) return;
  if (options.usingActivePass) return;

  const split = await resolveCheckoutSplit(classRow, classRow.price_cents, {
    isPassPurchase: Boolean(options.isPassPurchase),
  });

  if (split.splitMode === 'single_collector' && options.isPassPurchase) {
    return;
  }

  if (split.splitMode === 'marketplace') {
    return;
  }

  if (options.isPassPurchase) return;

  const payee = await resolvePayeeForClass(classRow);
  assertSellerConnected(payee);
}

async function recordPassBookingLedger(bookingRow, classRow) {
  if (!isMarketplaceEnabled() || getPassRevenuePolicy() !== 'platform_ledger') {
    return null;
  }

  if (!bookingRow.athlete_pass_id) return null;

  const payee = await resolvePayeeForClass(classRow);
  const { platformFeeCents, sellerNetCents } = computeSplitAmounts(
    bookingRow.price_cents,
    payee.plan,
    payee.sellerType,
    payee.institution,
  );

  const { rows } = await query(
    `INSERT INTO payout_ledger (
      booking_id, instructor_id, institution_id,
      gross_cents, platform_fee_cents, net_cents, currency, source
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pass_ledger')
    ON CONFLICT (booking_id) DO NOTHING
    RETURNING *`,
    [
      bookingRow.id,
      classRow.instructor_id,
      classRow.institution_id || null,
      bookingRow.price_cents,
      platformFeeCents,
      sellerNetCents,
      bookingRow.price_currency,
    ],
  );

  return rows[0] || null;
}

function getSellerConnectionView(seller, sellerType) {
  return {
    sellerType,
    status: seller.mp_connection_status || 'disconnected',
    connected: isSellerConnected(seller),
    collectorId: seller.mp_collector_id || undefined,
    connectedAt: seller.mp_connected_at?.toISOString(),
  };
}

async function getSellerConnectionForUser(user) {
  if (user.role === 'instructor') {
    const { rows } = await query(`SELECT * FROM instructors WHERE user_id = $1`, [user.id]);
    if (!rows.length) throw notFound('Instructor profile not found');
    return getSellerConnectionView(rows[0], 'instructor');
  }

  if (user.role === 'institution') {
    const { rows } = await query(`SELECT * FROM institutions WHERE user_id = $1`, [user.id]);
    if (!rows.length) throw notFound('Institution profile not found');
    return getSellerConnectionView(rows[0], 'institution');
  }

  throw badRequest('Only instructors and institutions can connect Mercado Pago');
}

module.exports = {
  getCommissionRate,
  computeSplitAmounts,
  resolvePayeeForClass,
  resolveCheckoutSplit,
  assertClassSellerCanReceivePayment,
  recordPassBookingLedger,
  getSellerConnectionForUser,
  isSellerConnected,
};
