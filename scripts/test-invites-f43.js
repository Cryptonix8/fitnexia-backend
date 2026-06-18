/**
 * F-43 integration tests — membership invites & registration.
 * Run: node scripts/test-invites-f43.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { pool } = require('../src/db/pool');
const bcrypt = require('bcryptjs');
const membershipsService = require('../src/services/memberships.service');
const { notFound, forbidden, badRequest, conflict } = require('../src/utils/errors');

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
    if (err.code === code) {
      passed += 1;
      console.log(`  ✓ ${message}`);
    } else {
      failed += 1;
      console.error(`  ✗ ${message} (got ${err.code}: ${err.message})`);
    }
  }
}

async function ensureMembershipTables() {
  await pool.query(`SELECT 1 FROM membership_invites LIMIT 1`);
}

async function createTestContext() {
  const passwordHash = await bcrypt.hash('TestPass123!', 10);
  const ts = Date.now();
  const gymEmail = `f43-gym-${ts}@fitnexia.test`;
  const athleteEmail = `f43-athlete-${ts}@fitnexia.test`;
  const otherEmail = `f43-other-${ts}@fitnexia.test`;

  const { rows: gymUsers } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'institution', true) RETURNING id`,
    [gymEmail, passwordHash],
  );
  const gymUserId = gymUsers[0].id;

  const { rows: institutions } = await pool.query(
    `INSERT INTO institutions (user_id, name, description)
     VALUES ($1, 'F43 Test Club', 'Invite test club') RETURNING id`,
    [gymUserId],
  );
  const institutionId = institutions[0].id;

  const plan = await membershipsService.createPlan(gymUserId, {
    name: 'F43 Monthly',
    priceCents: 250000,
    billingFrequency: 'monthly',
  });

  const { rows: athletes } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'athlete', true) RETURNING id, email`,
    [athleteEmail, passwordHash],
  );
  const athleteUser = athletes[0];

  const { rows: others } = await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'athlete', true) RETURNING id, email`,
    [otherEmail, passwordHash],
  );
  const otherUser = others[0];

  return {
    gymUserId,
    institutionId,
    planId: plan.id,
    athleteUser,
    otherUser,
    inviteIds: [],
    memberIds: [],
  };
}

async function cleanup(ctx) {
  for (const memberId of ctx.memberIds) {
    await pool.query(`DELETE FROM membership_payments WHERE club_member_id = $1`, [memberId]);
    await pool.query(`DELETE FROM membership_subscriptions WHERE club_member_id = $1`, [memberId]);
    await pool.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
  }
  for (const inviteId of ctx.inviteIds) {
    await pool.query(`DELETE FROM membership_invites WHERE id = $1`, [inviteId]);
  }
  await pool.query(`DELETE FROM membership_plans WHERE institution_id = $1`, [ctx.institutionId]);
  await pool.query(`DELETE FROM institution_membership_settings WHERE institution_id = $1`, [
    ctx.institutionId,
  ]);
  await pool.query(`DELETE FROM institutions WHERE id = $1`, [ctx.institutionId]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [
    ctx.gymUserId,
    ctx.athleteUser.id,
    ctx.otherUser.id,
  ]);
}

async function run() {
  console.log('\nF-43 — Membership invites & registration\n');

  try {
    await ensureMembershipTables();
  } catch (err) {
    console.error(
      'Membership tables missing. Run: node scripts/migrate-club-memberships.js\n',
      err.message,
    );
    process.exit(1);
  }

  const ctx = await createTestContext();

  try {
    console.log('Create invite');
    const invite = await membershipsService.createInvite(ctx.gymUserId, {
      planId: ctx.planId,
      email: ctx.athleteUser.email,
      invitedName: 'F43 Athlete',
    });
    ctx.inviteIds.push(invite.id);
    assert(invite.code && invite.code.length === 8, 'invite has 8-char code');
    assert(invite.status === 'pending', 'invite status is pending');
    assert(invite.planId === ctx.planId, 'invite references plan');
    assert(Boolean(invite.joinUrl), 'invite includes joinUrl deep link');
    assert(invite.joinUrl.includes(invite.code), 'joinUrl contains invite code');

    console.log('Preview invite by code');
    const preview = await membershipsService.getInviteByCode(invite.code);
    assert(preview.institutionName === 'F43 Test Club', 'preview shows institution');
    assert(preview.plan.name === 'F43 Monthly', 'preview shows plan name');
    assert(preview.email === ctx.athleteUser.email, 'preview includes invite email');

    console.log('List invites');
    const listed = await membershipsService.listInvites(ctx.gymUserId);
    assert(listed.some((i) => i.id === invite.id), 'listInvites includes new invite');

    console.log('Email mismatch on accept');
    await assertThrows(
      () =>
        membershipsService.acceptInvite(
          { id: ctx.otherUser.id, email: ctx.otherUser.email, role: 'athlete' },
          invite.code,
        ),
      forbidden().code,
      'wrong email cannot accept invite',
    );

    console.log('Accept invite');
    const accepted = await membershipsService.acceptInvite(
      { id: ctx.athleteUser.id, email: ctx.athleteUser.email, role: 'athlete' },
      invite.code,
    );
    ctx.memberIds.push(accepted.member.id);
    assert(accepted.member.id, 'accept returns member');
    assert(accepted.member.status === 'pending_authorization', 'accepted member pending authorization');
    assert(accepted.subscriptionId, 'accept returns subscriptionId');

    const { rows: inviteRows } = await pool.query(`SELECT status FROM membership_invites WHERE id = $1`, [
      invite.id,
    ]);
    assert(inviteRows[0].status === 'accepted', 'invite marked accepted');

    console.log('Cannot accept same invite twice');
    await assertThrows(
      () =>
        membershipsService.acceptInvite(
          { id: ctx.athleteUser.id, email: ctx.athleteUser.email, role: 'athlete' },
          invite.code,
        ),
      badRequest().code,
      'used invite cannot be accepted again',
    );

    console.log('Already member conflict');
    const invite2 = await membershipsService.createInvite(ctx.gymUserId, {
      planId: ctx.planId,
      email: ctx.athleteUser.email,
    });
    ctx.inviteIds.push(invite2.id);
    await assertThrows(
      () =>
        membershipsService.acceptInvite(
          { id: ctx.athleteUser.id, email: ctx.athleteUser.email, role: 'athlete' },
          invite2.code,
        ),
      conflict('ALREADY_MEMBER').code,
      'already member cannot accept another invite',
    );

    console.log('Cancel invite');
    const pendingInvite = await membershipsService.createInvite(ctx.gymUserId, {
      planId: ctx.planId,
      email: 'cancel-me@fitnexia.test',
    });
    ctx.inviteIds.push(pendingInvite.id);
    await membershipsService.cancelInvite(ctx.gymUserId, pendingInvite.id);
    await assertThrows(
      () => membershipsService.getInviteByCode(pendingInvite.code),
      badRequest().code,
      'cancelled invite is not valid',
    );

    console.log('Expired invite');
    const expiredInvite = await membershipsService.createInvite(ctx.gymUserId, {
      planId: ctx.planId,
      expiresInDays: 1,
    });
    ctx.inviteIds.push(expiredInvite.id);
    await pool.query(`UPDATE membership_invites SET expires_at = now() - interval '1 day' WHERE id = $1`, [
      expiredInvite.id,
    ]);
    await assertThrows(
      () => membershipsService.getInviteByCode(expiredInvite.code),
      badRequest().code,
      'expired invite rejected',
    );

    console.log('Bulk create invites');
    const bulk = await membershipsService.bulkCreateInvites(ctx.gymUserId, {
      members: [
        { planId: ctx.planId, email: `bulk-a-${Date.now()}@fitnexia.test`, invitedName: 'Bulk A' },
        { planId: ctx.planId, email: `bulk-b-${Date.now()}@fitnexia.test`, invitedName: 'Bulk B' },
        { planId: 'not-a-uuid', email: 'bad@fitnexia.test' },
      ],
    });
    assert(Boolean(bulk.batchId), 'bulk returns batchId');
    assert(bulk.results.length === 3, 'bulk returns result per row');
    assert(bulk.results.filter((r) => r.ok).length === 2, 'bulk succeeds for valid rows');
    assert(bulk.results.some((r) => !r.ok), 'bulk reports failed row');
    for (const row of bulk.results) {
      if (row.ok && row.invite) ctx.inviteIds.push(row.invite.id);
    }

    console.log('Invalid code');
    await assertThrows(
      () => membershipsService.getInviteByCode('ZZZZZZZZ'),
      notFound().code,
      'unknown code returns not found',
    );
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
