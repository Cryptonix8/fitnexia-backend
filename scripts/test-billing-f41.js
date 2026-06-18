/**
 * F-41 integration tests — recurring membership billing.
 * Run: node scripts/test-billing-f41.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { pool } = require('../src/db/pool');
const bcrypt = require('bcryptjs');
const membershipsService = require('../src/services/memberships.service');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

async function ensureMembershipTables() {
  await pool.query(`SELECT 1 FROM membership_subscriptions LIMIT 1`);
}

async function createTestClubWithMember() {
  const passwordHash = await bcrypt.hash('TestPass123!', 10);
  const athleteEmail = `f41-athlete-${Date.now()}@fitnexia.test`;
  const gymEmail = `f41-gym-${Date.now()}@fitnexia.test`;

  const { rows: gymUsers } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'institution', true) RETURNING id`,
    [gymEmail, passwordHash],
  );
  const gymUserId = gymUsers[0].id;

  const { rows: institutions } = await pool.query(
    `INSERT INTO institutions (user_id, name, description)
     VALUES ($1, 'F41 Test Club', 'Billing test club') RETURNING id`,
    [gymUserId],
  );
  const institutionId = institutions[0].id;

  const plan = await membershipsService.createPlan(gymUserId, {
    name: 'F41 Monthly',
    priceCents: 250000,
    billingFrequency: 'monthly',
  });

  const { rows: athletes } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'athlete', true) RETURNING id`,
    [athleteEmail, passwordHash],
  );
  const athleteUserId = athletes[0].id;

  const member = await membershipsService.addMember(gymUserId, {
    planId: plan.id,
    contactName: 'F41 Athlete',
    contactEmail: athleteEmail,
  });

  const { rows: subs } = await pool.query(
    `SELECT id FROM membership_subscriptions WHERE club_member_id = $1`,
    [member.id],
  );

  return {
    gymUserId,
    institutionId,
    athleteUserId,
    planId: plan.id,
    memberId: member.id,
    subscriptionId: subs[0].id,
    athleteEmail,
  };
}

async function cleanup(ctx, extraPlanIds = []) {
  const { gymUserId, institutionId, athleteUserId, memberId, subscriptionId, planId } = ctx;
  await pool.query(`DELETE FROM membership_payments WHERE subscription_id = $1`, [subscriptionId]);
  await pool.query(`DELETE FROM membership_subscriptions WHERE id = $1`, [subscriptionId]);
  await pool.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
  for (const id of [planId, ...extraPlanIds]) {
    await pool.query(`DELETE FROM membership_plans WHERE id = $1`, [id]);
  }
  await pool.query(`DELETE FROM institution_membership_settings WHERE institution_id = $1`, [
    institutionId,
  ]);
  await pool.query(`DELETE FROM institutions WHERE id = $1`, [institutionId]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [gymUserId, athleteUserId]);
}

async function getSubscription(subscriptionId) {
  const { rows } = await pool.query(`SELECT * FROM membership_subscriptions WHERE id = $1`, [
    subscriptionId,
  ]);
  return rows[0];
}

async function getMember(memberId) {
  const { rows } = await pool.query(`SELECT * FROM club_members WHERE id = $1`, [memberId]);
  return rows[0];
}

async function run() {
  console.log('\nF-41 — Recurring collection\n');

  try {
    await ensureMembershipTables();
  } catch (err) {
    console.error(
      'Membership tables missing. Run: node scripts/migrate-club-memberships.js\n',
      err.message,
    );
    process.exit(1);
  }

  const ctx = await createTestClubWithMember();

  try {
    console.log('Activate subscription (mock preapproval)');
    await membershipsService.activateSubscription(ctx.subscriptionId, {
      preapprovalId: `mock-${ctx.subscriptionId}`,
    });
    let sub = await getSubscription(ctx.subscriptionId);
    let member = await getMember(ctx.memberId);
    assert(sub.status === 'active', 'activateSubscription sets active status');
    assert(member.status === 'active', 'member becomes active');
    assert(sub.next_billing_at, 'next_billing_at is set');

    console.log('Preapproval authorized webhook handler');
    const preResult = await membershipsService.handlePreapprovalAuthorized(ctx.subscriptionId, 'mock-pre');
    assert(preResult.status === 'already_active', 'handlePreapprovalAuthorized is idempotent');

    console.log('Subscription payment (msub) activates pending');
    const ctx2 = await createTestClubWithMember();
    try {
      const payActivate = await membershipsService.processSubscriptionPayment(ctx2.subscriptionId, {
        providerPaymentId: `mp-test-activate-${Date.now()}`,
        status: 'approved',
        amountCents: 250000,
        currency: 'UYU',
      });
      assert(payActivate.status === 'activated', 'processSubscriptionPayment activates pending sub');
      sub = await getSubscription(ctx2.subscriptionId);
      assert(sub.status === 'active', 'subscription active after payment');
    } finally {
      await cleanup(ctx2);
    }

    console.log('Recurring payment records charge and advances billing');
    const beforeBilling = (await getSubscription(ctx.subscriptionId)).next_billing_at;
    await membershipsService.recordRecurringPayment(ctx.subscriptionId, {
      providerPaymentId: `mp-test-recurring-${Date.now()}`,
      amountCents: 250000,
      currency: 'UYU',
    });
    sub = await getSubscription(ctx.subscriptionId);
    assert(
      new Date(sub.next_billing_at) > new Date(beforeBilling),
      'recordRecurringPayment advances next_billing_at',
    );

    const { rows: payments } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM membership_payments WHERE subscription_id = $1`,
      [ctx.subscriptionId],
    );
    assert(payments[0].count >= 2, 'recurring payment stored in history');

    console.log('Duplicate provider payment is ignored');
    const dupId = `mp-test-dup-${Date.now()}`;
    await membershipsService.recordRecurringPayment(ctx.subscriptionId, {
      providerPaymentId: dupId,
    });
    const dupResult = await membershipsService.processSubscriptionPayment(ctx.subscriptionId, {
      providerPaymentId: dupId,
      status: 'approved',
    });
    assert(dupResult.duplicate === true, 'duplicate provider_payment_id ignored');

    console.log('Scheduler skips auto-debit subscriptions');
    await pool.query(
      `UPDATE membership_subscriptions SET next_billing_at = now() - interval '1 day' WHERE id = $1`,
      [ctx.subscriptionId],
    );
    await membershipsService.processDueBilling();
    sub = await getSubscription(ctx.subscriptionId);
    assert(sub.status === 'active', 'preapproval sub stays active when due');
    member = await getMember(ctx.memberId);
    assert(member.status === 'active', 'member stays active with preapproval');

    console.log('Scheduler marks manual subscriptions past_due');
    const ctx3 = await createTestClubWithMember();
    try {
      await membershipsService.activateSubscription(ctx3.subscriptionId, {
        preapprovalId: null,
      });
      await pool.query(
        `UPDATE membership_subscriptions
         SET mp_preapproval_id = NULL, next_billing_at = now() - interval '1 day'
         WHERE id = $1`,
        [ctx3.subscriptionId],
      );
      await membershipsService.processDueBilling();
      sub = await getSubscription(ctx3.subscriptionId);
      member = await getMember(ctx3.memberId);
      assert(sub.status === 'past_due', 'manual sub becomes past_due when due');
      assert(member.status === 'pending_payment', 'member pending_payment without auto-debit');
      assert(sub.retry_count === 1, 'retry_count incremented');
    } finally {
      await cleanup(ctx3);
    }

    console.log('Rejected subscription payment increments retries');
    const ctx4 = await createTestClubWithMember();
    try {
      await membershipsService.activateSubscription(ctx4.subscriptionId, {
        preapprovalId: `mock-${ctx4.subscriptionId}`,
      });
      await membershipsService.processSubscriptionPayment(ctx4.subscriptionId, {
        providerPaymentId: `mp-test-fail-${Date.now()}`,
        status: 'rejected',
      });
      sub = await getSubscription(ctx4.subscriptionId);
      assert(sub.status === 'past_due', 'rejected payment sets past_due');
      assert(sub.retry_count === 1, 'rejected payment increments retry_count');
    } finally {
      await cleanup(ctx4);
    }

    console.log('Pay-debt confirms manual payment');
    const ctx5 = await createTestClubWithMember();
    try {
      await membershipsService.activateSubscription(ctx5.subscriptionId, { preapprovalId: null });
      await pool.query(
        `UPDATE membership_subscriptions SET mp_preapproval_id = NULL, status = 'past_due' WHERE id = $1`,
        [ctx5.subscriptionId],
      );
      await pool.query(`UPDATE club_members SET status = 'pending_payment' WHERE id = $1`, [
        ctx5.memberId,
      ]);
      const debt = await membershipsService.payDebt(ctx5.athleteUserId, ctx5.memberId);
      await membershipsService.confirmMembershipPayment(debt.paymentId, 'mock-debt-pay');
      sub = await getSubscription(ctx5.subscriptionId);
      member = await getMember(ctx5.memberId);
      assert(sub.status === 'active', 'pay-debt restores active subscription');
      assert(member.status === 'active', 'pay-debt restores active member');
      assert(sub.retry_count === 0, 'pay-debt resets retry_count');
    } finally {
      await cleanup(ctx5);
    }
  } finally {
    await cleanup(ctx);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
