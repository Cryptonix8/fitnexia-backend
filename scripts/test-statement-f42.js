/**
 * F-42 integration tests — athlete membership statement & debt payment.
 * Run: node scripts/test-statement-f42.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { pool } = require('../src/db/pool');
const bcrypt = require('bcryptjs');
const membershipsService = require('../src/services/memberships.service');
const { notFound, forbidden, badRequest } = require('../src/utils/errors');

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

async function assertThrows(fn, code, message) {
  try {
    await fn();
    failed += 1;
    console.error(`  ✗ ${message} (expected ${code})`);
  } catch (err) {
    if (err.code === code || err.name === code) {
      passed += 1;
      console.log(`  ✓ ${message}`);
    } else {
      failed += 1;
      console.error(`  ✗ ${message} (got ${err.code || err.name}: ${err.message})`);
    }
  }
}

async function ensureMembershipTables() {
  await pool.query(`SELECT 1 FROM membership_subscriptions LIMIT 1`);
}

async function createTestClubWithMember() {
  const passwordHash = await bcrypt.hash('TestPass123!', 10);
  const athleteEmail = `f42-athlete-${Date.now()}@fitnexia.test`;
  const gymEmail = `f42-gym-${Date.now()}@fitnexia.test`;
  const otherEmail = `f42-other-${Date.now()}@fitnexia.test`;

  const { rows: gymUsers } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'institution', true) RETURNING id`,
    [gymEmail, passwordHash],
  );
  const gymUserId = gymUsers[0].id;

  const { rows: institutions } = await pool.query(
    `INSERT INTO institutions (user_id, name, description)
     VALUES ($1, 'F42 Test Club', 'Statement test club') RETURNING id`,
    [gymUserId],
  );
  const institutionId = institutions[0].id;

  const plan = await membershipsService.createPlan(gymUserId, {
    name: 'F42 Monthly',
    priceCents: 300000,
    billingFrequency: 'monthly',
  });

  const { rows: athletes } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'athlete', true) RETURNING id`,
    [athleteEmail, passwordHash],
  );
  const athleteUserId = athletes[0].id;

  const { rows: others } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'athlete', true) RETURNING id`,
    [otherEmail, passwordHash],
  );
  const otherUserId = others[0].id;

  const member = await membershipsService.addMember(gymUserId, {
    planId: plan.id,
    contactName: 'F42 Athlete',
    contactEmail: athleteEmail,
  });

  await pool.query(`UPDATE club_members SET user_id = $1 WHERE id = $2`, [
    athleteUserId,
    member.id,
  ]);

  const { rows: subs } = await pool.query(
    `SELECT id FROM membership_subscriptions WHERE club_member_id = $1`,
    [member.id],
  );

  return {
    gymUserId,
    institutionId,
    athleteUserId,
    otherUserId,
    planId: plan.id,
    memberId: member.id,
    subscriptionId: subs[0].id,
    athleteEmail,
  };
}

async function cleanup(ctx) {
  await pool.query(`DELETE FROM membership_payments WHERE club_member_id = $1`, [ctx.memberId]);
  await pool.query(`DELETE FROM membership_subscriptions WHERE club_member_id = $1`, [ctx.memberId]);
  await pool.query(`DELETE FROM club_members WHERE id = $1`, [ctx.memberId]);
  await pool.query(`DELETE FROM membership_plans WHERE id = $1`, [ctx.planId]);
  await pool.query(`DELETE FROM institution_membership_settings WHERE institution_id = $1`, [
    ctx.institutionId,
  ]);
  await pool.query(`DELETE FROM institutions WHERE id = $1`, [ctx.institutionId]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [
    ctx.gymUserId,
    ctx.athleteUserId,
    ctx.otherUserId,
  ]);
}

async function run() {
  console.log('\nF-42 — Member statement (athlete)\n');

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
    console.log('Active member statement');
    await membershipsService.activateSubscription(ctx.subscriptionId, {
      preapprovalId: `mock-${ctx.subscriptionId}`,
    });
    await membershipsService.recordRecurringPayment(ctx.subscriptionId, {
      providerPaymentId: `f42-recurring-${Date.now()}`,
      amountCents: 300000,
      currency: 'UYU',
    });

    const statement = await membershipsService.getStatement(ctx.athleteUserId, ctx.memberId);
    assert(statement.member.id === ctx.memberId, 'statement returns correct member');
    assert(statement.member.feeStatus === 'up_to_date', 'active member feeStatus is up_to_date');
    assert(statement.plan.name === 'F42 Monthly', 'statement includes plan name');
    assert(statement.plan.price.amount === 300000, 'statement includes plan price');
    assert(statement.plan.billingFrequency === 'monthly', 'statement includes billing frequency');
    assert(Boolean(statement.nextDueDate), 'statement includes next due date');
    assert(statement.amountDue === null, 'active member has no amountDue');
    assert(statement.payments.length >= 1, 'statement lists payment history');
    assert(statement.payments[0].status === 'approved', 'latest payment is approved');

    console.log('List my memberships');
    const mine = await membershipsService.getMyMemberships(ctx.athleteUserId);
    assert(mine.some((m) => m.id === ctx.memberId), 'getMyMemberships includes linked member');

    console.log('Overdue member shows amount due');
    await pool.query(
      `UPDATE membership_subscriptions SET status = 'past_due' WHERE id = $1`,
      [ctx.subscriptionId],
    );
    await pool.query(`UPDATE club_members SET status = 'overdue' WHERE id = $1`, [ctx.memberId]);
    await pool.query(
      `UPDATE institution_membership_settings SET grace_days = 5 WHERE institution_id = $1`,
      [ctx.institutionId],
    );

    const overdueStmt = await membershipsService.getStatement(ctx.athleteUserId, ctx.memberId);
    assert(overdueStmt.member.feeStatus === 'overdue', 'overdue member feeStatus');
    assert(overdueStmt.amountDue?.amount === 300000, 'overdue member amountDue equals plan price');
    assert(overdueStmt.graceDays === 5, 'statement includes institution grace days');

    console.log('Pay-debt creates checkout');
    const debt = await membershipsService.payDebt(ctx.athleteUserId, ctx.memberId);
    assert(Boolean(debt.paymentId), 'pay-debt returns paymentId');
    assert(Boolean(debt.checkoutUrl), 'pay-debt returns checkoutUrl');
    assert(debt.amount.amount === 300000, 'pay-debt amount matches plan');

    const pendingPayment = await membershipsService.getMembershipPaymentForUser(
      ctx.athleteUserId,
      ctx.memberId,
      debt.paymentId,
    );
    assert(pendingPayment.status === 'pending', 'debt payment starts as pending');

    console.log('Pay-debt rejected when no debt');
    await membershipsService.confirmMembershipPayment(debt.paymentId, 'mock-f42-debt');
    await assertThrows(
      () => membershipsService.payDebt(ctx.athleteUserId, ctx.memberId),
      badRequest().code,
      'pay-debt fails when member is active',
    );

    const paidStmt = await membershipsService.getStatement(ctx.athleteUserId, ctx.memberId);
    assert(paidStmt.member.feeStatus === 'up_to_date', 'statement shows up_to_date after payment');
    assert(paidStmt.amountDue === null, 'amountDue cleared after payment');
    assert(
      paidStmt.payments.some((p) => p.id === debt.paymentId && p.status === 'approved'),
      'payment history includes approved debt payment',
    );

    console.log('Access control');
    await assertThrows(
      () => membershipsService.getStatement(ctx.otherUserId, ctx.memberId),
      notFound().code,
      'other athlete cannot read statement',
    );
    await assertThrows(
      () =>
        membershipsService.getMembershipPaymentForUser(
          ctx.otherUserId,
          ctx.memberId,
          debt.paymentId,
        ),
      notFound().code,
      'other athlete cannot read membership payment',
    );

    console.log('Sync membership payment (no MP configured)');
    await pool.query(`UPDATE club_members SET status = 'pending_payment' WHERE id = $1`, [
      ctx.memberId,
    ]);
    await pool.query(
      `UPDATE membership_subscriptions SET status = 'past_due' WHERE id = $1`,
      [ctx.subscriptionId],
    );
    const debt2 = await membershipsService.payDebt(ctx.athleteUserId, ctx.memberId);
    const syncResult = await membershipsService.syncMembershipPayment(
      ctx.athleteUserId,
      ctx.memberId,
      debt2.paymentId,
    );
    assert(syncResult.payment.status === 'pending', 'sync leaves pending without MP match');
    await membershipsService.confirmMembershipPayment(debt2.paymentId, 'mock-f42-sync');
    const syncApproved = await membershipsService.syncMembershipPayment(
      ctx.athleteUserId,
      ctx.memberId,
      debt2.paymentId,
    );
    assert(syncApproved.synced === true, 'sync detects already-approved payment');
    assert(syncApproved.payment.status === 'approved', 'sync returns approved payment');
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
