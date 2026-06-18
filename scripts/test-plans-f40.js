/**
 * F-40 integration tests — membership plans CRUD.
 * Run: node scripts/test-plans-f40.js
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
  const email = `f40-gym-${Date.now()}@fitnexia.test`;
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
     VALUES ($1, 'F40 Test Club', 'Integration test club')
     RETURNING id`,
    [userId],
  );
  return { userId, institutionId: institutions[0].id, email };
}

async function cleanup(userId, institutionId, memberIds = [], planIds = [], extraUserIds = []) {
  for (const memberId of memberIds) {
    await pool.query(`DELETE FROM membership_payments WHERE club_member_id = $1`, [memberId]);
    await pool.query(`DELETE FROM membership_subscriptions WHERE club_member_id = $1`, [memberId]);
    await pool.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
  }
  for (const planId of planIds) {
    await pool.query(`DELETE FROM membership_plans WHERE id = $1`, [planId]);
  }
  for (const extraUserId of extraUserIds) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [extraUserId]);
  }
  await pool.query(`DELETE FROM institution_membership_settings WHERE institution_id = $1`, [
    institutionId,
  ]);
  await pool.query(`DELETE FROM institutions WHERE id = $1`, [institutionId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

async function run() {
  console.log('\nF-40 — Membership plans\n');

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
  const extraUserIds = [];

  try {
    console.log('Create individual plan');
    const individual = await membershipsService.createPlan(userId, {
      name: 'F40 Monthly',
      description: 'Acceso ilimitado',
      priceCents: 250000,
      billingFrequency: 'monthly',
      planType: 'individual',
    });
    planIds.push(individual.id);
    assert(individual.planType === 'individual', 'createPlan individual sets planType');
    assert(individual.priceCents === 250000, 'createPlan sets priceCents');
    assert(individual.description === 'Acceso ilimitado', 'createPlan sets description');

    console.log('Create family plan');
    const family = await membershipsService.createPlan(userId, {
      name: 'F40 Family',
      description: 'Hasta 4 integrantes',
      priceCents: 800000,
      billingFrequency: 'quarterly',
      planType: 'family',
      maxMembers: 4,
    });
    planIds.push(family.id);
    assert(family.planType === 'family', 'createPlan family sets planType');
    assert(family.maxMembers === 4, 'createPlan family sets maxMembers');

    console.log('Validation — family without maxMembers');
    let familyValidationOk = false;
    try {
      await membershipsService.createPlan(userId, {
        name: 'Bad Family',
        priceCents: 100000,
        billingFrequency: 'monthly',
        planType: 'family',
      });
    } catch (err) {
      familyValidationOk = err.code === 'VALIDATION_ERROR';
    }
    assert(familyValidationOk, 'createPlan family without maxMembers rejected');

    console.log('List plans');
    const all = await membershipsService.listPlans(userId);
    assert(all.length >= 2, 'listPlans returns created plans');
    assert(all.some((p) => p.id === individual.id), 'listPlans includes individual plan');

    console.log('Get plan by id');
    const one = await membershipsService.getPlan(userId, family.id);
    assert(one.name === 'F40 Family', 'getPlan returns correct name');
    assert(one.billingFrequency === 'quarterly', 'getPlan returns billing frequency');

    console.log('Update plan');
    const updated = await membershipsService.updatePlan(userId, individual.id, {
      name: 'F40 Monthly VIP',
      priceCents: 300000,
      description: 'Incluye clases',
    });
    assert(updated.name === 'F40 Monthly VIP', 'updatePlan changes name');
    assert(updated.priceCents === 300000, 'updatePlan changes price');

    console.log('Deactivate plan');
    await membershipsService.deletePlan(userId, family.id);
    const afterDeactivate = await membershipsService.listPlans(userId);
    const deactivated = afterDeactivate.find((p) => p.id === family.id);
    assert(deactivated && deactivated.active === false, 'deletePlan sets active false');

    console.log('Reactivate plan');
    const reactivated = await membershipsService.updatePlan(userId, family.id, { active: true });
    assert(reactivated.active === true, 'updatePlan reactivates plan');

    console.log('Deactivate blocked when plan has active member');
    const athleteEmail = `f40-athlete-${Date.now()}@fitnexia.test`;
    const passwordHash = await bcrypt.hash('TestPass123!', 10);
    const { rows: athletes } = await pool.query(
      `INSERT INTO users (email, password_hash, role, email_verified)
       VALUES ($1, $2, 'athlete', true) RETURNING id`,
      [athleteEmail, passwordHash],
    );
    extraUserIds.push(athletes[0].id);
    const member = await membershipsService.addMember(userId, {
      planId: individual.id,
      contactName: 'Plan Holder',
      contactEmail: athleteEmail,
    });
    memberIds.push(member.id);
    let planInUseOk = false;
    try {
      await membershipsService.deletePlan(userId, individual.id);
    } catch (err) {
      planInUseOk = err.code === 'PLAN_IN_USE';
    }
    assert(planInUseOk, 'deletePlan rejects plan with active members');
  } finally {
    await cleanup(userId, institutionId, memberIds, planIds, extraUserIds);
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
