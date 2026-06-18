/**
 * F-39 integration tests — club member list CRUD.
 * Run: node scripts/test-members-f39.js
 *
 * Requires DATABASE_URL and existing institution user in DB.
 * Creates ephemeral test data and cleans up on success.
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
  await pool.query(`SELECT 1 FROM membership_plans LIMIT 1`);
}

async function createTestInstitutionUser() {
  const email = `f39-gym-${Date.now()}@fitnexia.test`;
  const passwordHash = await bcrypt.hash('TestPass123!', 10);
  const { rows: users } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'institution', true)
     RETURNING id`,
    [email, passwordHash],
  );
  const userId = users[0].id;
  const { rows: institutions } = await pool.query(
    `INSERT INTO institutions (user_id, name, description)
     VALUES ($1, 'F39 Test Club', 'Integration test club')
     RETURNING id`,
    [userId],
  );
  return { userId, institutionId: institutions[0].id, email };
}

async function cleanup(userId, institutionId, memberIds = [], planIds = []) {
  for (const memberId of memberIds) {
    await pool.query(`DELETE FROM membership_payments WHERE club_member_id = $1`, [memberId]);
    await pool.query(`DELETE FROM membership_subscriptions WHERE club_member_id = $1`, [memberId]);
    await pool.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
  }
  for (const planId of planIds) {
    await pool.query(`DELETE FROM membership_plans WHERE id = $1`, [planId]);
  }
  await pool.query(`DELETE FROM institution_membership_settings WHERE institution_id = $1`, [
    institutionId,
  ]);
  await pool.query(`DELETE FROM institutions WHERE id = $1`, [institutionId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

async function run() {
  console.log('\nF-39 — List of members\n');

  try {
    await ensureMembershipTables();
  } catch (err) {
    console.error(
      'Membership tables missing. Run: node scripts/migrate-club-memberships.js\n',
      err.message,
    );
    process.exit(1);
  }

  const { userId, institutionId } = await createTestInstitutionUser();
  const memberIds = [];
  const planIds = [];

  try {
    console.log('Create plan');
    const plan = await membershipsService.createPlan(userId, {
      name: 'F39 Monthly',
      priceCents: 250000,
      billingFrequency: 'monthly',
    });
    planIds.push(plan.id);
    assert(plan.id && plan.name === 'F39 Monthly', 'createPlan returns plan');

    console.log('Add member (manual registration)');
    const member = await membershipsService.addMember(userId, {
      planId: plan.id,
      contactName: 'Ana Test',
      contactEmail: 'ana-f39@fitnexia.test',
      contactPhone: '+59899111222',
    });
    memberIds.push(member.id);
    assert(member.contactName === 'Ana Test', 'addMember sets contact name');
    assert(member.feeStatus === 'pending', 'unlinked user without subscription is pending');
    assert(member.planId === plan.id, 'addMember assigns plan');

    console.log('List members');
    const all = await membershipsService.listMembers(userId);
    assert(all.some((m) => m.id === member.id), 'listMembers includes new member');

    const pending = await membershipsService.listMembers(userId, { status: 'pending' });
    assert(pending.some((m) => m.id === member.id), 'filter pending works');

    console.log('Get member by id');
    const one = await membershipsService.getMember(userId, member.id);
    assert(one.contactPhone === '+59899111222', 'getMember returns contact phone');

    console.log('Update member');
    const updated = await membershipsService.updateMember(userId, member.id, {
      contactName: 'Ana Updated',
      contactPhone: '+59899333444',
    });
    assert(updated.contactName === 'Ana Updated', 'updateMember changes name');
    assert(updated.contactPhone === '+59899333444', 'updateMember changes phone');

    console.log('Members summary');
    const summary = await membershipsService.getMembersSummary(userId);
    assert(summary.total >= 1, 'summary total >= 1');
    assert(summary.pending >= 1, 'summary pending >= 1');

    console.log('Deregister member');
    await membershipsService.removeMember(userId, member.id);
    const afterRemove = await membershipsService.listMembers(userId);
    assert(!afterRemove.some((m) => m.id === member.id), 'removed member not in active list');

    const inactiveList = await membershipsService.listMembers(userId, { status: 'inactive' });
    assert(inactiveList.some((m) => m.id === member.id), 'inactive filter shows deregistered member');

    console.log('Validation');
    let validationOk = false;
    try {
      await membershipsService.updateMember(userId, member.id, {});
    } catch (err) {
      validationOk = err.code === 'VALIDATION_ERROR';
    }
    assert(validationOk, 'updateMember rejects empty body');
  } finally {
    await cleanup(userId, institutionId, memberIds, planIds);
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
