const { query, pool } = require('../db/pool');
const { forbidden, badRequest } = require('../utils/errors');
const { defaultCurrency } = require('../config/env');

const CREDITS_FOR_REWARD = 10;
const EXPIRY_MONTHS = 12;
const EXPIRY_WARNING_DAYS = 30;

function getMaxFreeClassCents() {
  const envVal = process.env.LOYALTY_MAX_FREE_CLASS_CENTS;
  if (envVal) return Number(envVal);
  return defaultCurrency === 'USD' ? 3000 : 150_000;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function serializeBalance(row) {
  const balance = row?.balance ?? 0;
  const expiresAt = row?.expires_at;
  const expired = expiresAt && new Date(expiresAt) < new Date();
  const effectiveBalance = expired ? 0 : balance;

  return {
    balance: effectiveBalance,
    creditsUntilReward: creditsUntilReward(effectiveBalance),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    lastBookingAt: row?.last_booking_at ? row.last_booking_at.toISOString() : null,
    freeClassEligible: effectiveBalance >= CREDITS_FOR_REWARD,
    maxFreeClassValue: {
      amount: getMaxFreeClassCents(),
      currency: defaultCurrency,
    },
    creditsForReward: CREDITS_FOR_REWARD,
  };
}

function creditsUntilReward(balance) {
  if (balance <= 0) return CREDITS_FOR_REWARD;
  const remainder = balance % CREDITS_FOR_REWARD;
  return remainder === 0 ? CREDITS_FOR_REWARD : CREDITS_FOR_REWARD - remainder;
}

async function getOrCreateAccount(userId, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO loyalty_accounts (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = loyalty_accounts.updated_at
     RETURNING *`,
    [userId],
  );
  return rows[0];
}

async function expireAccountIfNeeded(userId, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(`SELECT * FROM loyalty_accounts WHERE user_id = $1 FOR UPDATE`, [userId]);
  if (!rows.length) return null;
  const account = rows[0];
  if (!account.expires_at || new Date(account.expires_at) >= new Date() || account.balance === 0) {
    return account;
  }

  const expiredAmount = account.balance;
  await q(
    `UPDATE loyalty_accounts
     SET balance = 0, updated_at = now()
     WHERE user_id = $1`,
    [userId],
  );
  await q(
    `INSERT INTO loyalty_credit_transactions (user_id, type, amount, balance_after, note)
     VALUES ($1, 'expire', $2, 0, 'Credits expired after 12 months of inactivity')`,
    [userId, -expiredAmount],
  );
  return { ...account, balance: 0 };
}

async function getMyBalance(user) {
  if (user.role !== 'athlete') throw forbidden('Only athletes have loyalty credits');
  const account = await getOrCreateAccount(user.id);
  const fresh = await expireAccountIfNeeded(user.id);
  const row = fresh || account;
  const serialized = serializeBalance(row);
  serialized.creditsUntilReward = creditsUntilReward(serialized.balance);
  return serialized;
}

async function listMyTransactions(user, limit = 50) {
  if (user.role !== 'athlete') throw forbidden('Only athletes have loyalty credits');
  await expireAccountIfNeeded(user.id);
  const { rows } = await query(
    `SELECT * FROM loyalty_credit_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [user.id, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    amount: row.amount,
    balanceAfter: row.balance_after,
    bookingId: row.booking_id || undefined,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  }));
}

async function assertEligibleForRedemption(userId, classPriceCents, client) {
  const account = await expireAccountIfNeeded(userId, client);
  if (!account || account.balance < CREDITS_FOR_REWARD) {
    throw badRequest('Not enough credits for a free class (10 required)');
  }
  if (classPriceCents > getMaxFreeClassCents()) {
    throw badRequest(
      `Free class reward applies to classes up to ${getMaxFreeClassCents() / 100} ${defaultCurrency}`,
    );
  }
  return account;
}

async function redeemCredits(client, userId, bookingId) {
  const account = await expireAccountIfNeeded(userId, client);
  if (!account || account.balance < CREDITS_FOR_REWARD) {
    throw badRequest('Not enough credits for redemption');
  }

  const newBalance = account.balance - CREDITS_FOR_REWARD;
  const now = new Date();
  const expiresAt = addMonths(now, EXPIRY_MONTHS);

  await client.query(
    `UPDATE loyalty_accounts
     SET balance = $2,
         last_booking_at = $3,
         expires_at = $4,
         updated_at = now()
     WHERE user_id = $1`,
    [userId, newBalance, now.toISOString(), expiresAt.toISOString()],
  );

  await client.query(
    `INSERT INTO loyalty_credit_transactions (user_id, type, amount, balance_after, booking_id, note)
     VALUES ($1, 'redeem', $2, $3, $4, 'Redeemed 10 credits for a free class')`,
    [userId, -CREDITS_FOR_REWARD, newBalance, bookingId],
  );
}

async function earnCreditForPaidBooking(bookingId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT athlete_user_id FROM bookings WHERE id = $1`, [
      bookingId,
    ]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const balance = await earnCreditForBooking(client, rows[0].athlete_user_id, bookingId);
    await client.query('COMMIT');
    return balance;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function earnCreditForBooking(client, userId, bookingId) {
  const { rows: bookingRows } = await client.query(
    `SELECT payment_model, loyalty_redemption, status FROM bookings WHERE id = $1`,
    [bookingId],
  );
  const booking = bookingRows[0];
  if (!booking || booking.loyalty_redemption || booking.payment_model !== 'per_class') {
    return null;
  }
  if (booking.status !== 'confirmed') return null;

  const { rows: existing } = await client.query(
    `SELECT id FROM loyalty_credit_transactions
     WHERE booking_id = $1 AND type = 'earn' LIMIT 1`,
    [bookingId],
  );
  if (existing.length) return null;

  await getOrCreateAccount(userId, client);
  const account = await expireAccountIfNeeded(userId, client);
  const newBalance = (account?.balance ?? 0) + 1;
  const now = new Date();
  const expiresAt = addMonths(now, EXPIRY_MONTHS);

  await client.query(
    `UPDATE loyalty_accounts
     SET balance = $2,
         last_booking_at = $3,
         expires_at = $4,
         updated_at = now()
     WHERE user_id = $1`,
    [userId, newBalance, now.toISOString(), expiresAt.toISOString()],
  );

  await client.query(
    `INSERT INTO loyalty_credit_transactions (user_id, type, amount, balance_after, booking_id, note)
     VALUES ($1, 'earn', 1, $2, $3, 'Credit earned for paid class booking')`,
    [userId, newBalance, bookingId],
  );

  return newBalance;
}

async function processExpiringCreditAlerts() {
  const warningStart = new Date();
  warningStart.setDate(warningStart.getDate() + EXPIRY_WARNING_DAYS - 1);
  const warningEnd = new Date();
  warningEnd.setDate(warningEnd.getDate() + EXPIRY_WARNING_DAYS + 1);

  const { rows } = await query(
    `SELECT la.user_id, la.balance, la.expires_at
     FROM loyalty_accounts la
     JOIN notification_preferences np ON np.user_id = la.user_id
     WHERE la.balance > 0
       AND la.expires_at BETWEEN $1 AND $2
       AND np.credits_expiring = TRUE`,
    [warningStart.toISOString(), warningEnd.toISOString()],
  );

  const notificationsService = require('./notifications.service');
  for (const row of rows) {
    await notificationsService.notifyCreditsExpiring({
      userId: row.user_id,
      balance: row.balance,
      expiresAt: row.expires_at,
    });
  }
}

module.exports = {
  CREDITS_FOR_REWARD,
  getMaxFreeClassCents,
  getMyBalance,
  listMyTransactions,
  assertEligibleForRedemption,
  redeemCredits,
  earnCreditForBooking,
  earnCreditForPaidBooking,
  processExpiringCreditAlerts,
  expireAccountIfNeeded,
};
