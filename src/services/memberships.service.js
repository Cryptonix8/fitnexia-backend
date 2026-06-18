const crypto = require('crypto');
const { query, pool } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const { serializeMoney } = require('../utils/serializers');
const { defaultCurrency, paymentsEnabled } = require('../config/env');
const {
  validateMembershipPlan,
  validateMembershipSettings,
  validateMembershipInvite,
  validateAddMember,
  validateUpdateMember,
} = require('../utils/validation');
const institutionsService = require('./institutions.service');
const {
  isMercadoPagoConfigured,
  useMockPayments,
  createCheckoutPreference,
  createPreapproval,
  buildMockCheckoutUrl,
  buildMockMembershipAuthorizeUrl,
  searchMercadoPagoPaymentsByReference,
} = require('./mercadopago.service');
const {
  sendMembershipInviteEmail,
  sendMembershipDueReminderEmail,
  sendMembershipOverdueEmail,
  sendMembershipPaymentReceiptEmail,
  sendMembershipArrearsAlertEmail,
} = require('./email.service');
const notificationsService = require('./notifications.service');

function isPaymentsActive() {
  return paymentsEnabled && (isMercadoPagoConfigured() || useMockPayments());
}

const MEMBERSHIP_MAX_PAYMENT_RETRIES = 3;

function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function addBillingPeriod(date, frequency) {
  const d = new Date(date);
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (frequency === 'quarterly') d.setMonth(d.getMonth() + 3);
  else if (frequency === 'annual') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function mapFeeStatus(status) {
  if (status === 'active') return 'up_to_date';
  if (status === 'pending_payment') return 'pending';
  if (status === 'overdue') return 'overdue';
  if (status === 'inactive') return 'inactive';
  if (status === 'invited' || status === 'pending_authorization') return 'pending';
  return 'pending';
}

function serializePlan(row) {
  return {
    id: row.id,
    institutionId: row.institution_id,
    name: row.name,
    description: row.description || '',
    price: serializeMoney(row.price_cents, row.price_currency),
    priceCents: row.price_cents,
    priceCurrency: row.price_currency,
    billingFrequency: row.billing_frequency,
    planType: row.plan_type,
    maxMembers: row.max_members ?? undefined,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function serializeMember(row, extras = {}) {
  return {
    id: row.id,
    institutionId: row.institution_id,
    userId: row.user_id || undefined,
    planId: row.plan_id,
    status: row.status,
    feeStatus: mapFeeStatus(row.status),
    contactName: row.contact_name || undefined,
    contactEmail: row.contact_email || undefined,
    contactPhone: row.contact_phone || undefined,
    joinedAt: row.joined_at?.toISOString(),
    leftAt: row.left_at?.toISOString(),
    planName: extras.planName,
    institutionName: extras.institutionName,
    nextBillingAt: extras.nextBillingAt,
    subscriptionStatus: extras.subscriptionStatus,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function serializeInvite(row, extras = {}) {
  return {
    id: row.id,
    institutionId: row.institution_id,
    planId: row.plan_id,
    code: row.code,
    email: row.email || undefined,
    invitedName: row.invited_name || undefined,
    invitedPhone: row.invited_phone || undefined,
    status: row.status,
    expiresAt: row.expires_at?.toISOString(),
    bulkBatchId: row.bulk_batch_id || undefined,
    planName: extras.planName,
    institutionName: extras.institutionName,
    createdAt: row.created_at.toISOString(),
  };
}

function serializePayment(row) {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    clubMemberId: row.club_member_id,
    status: row.status,
    amount: serializeMoney(row.amount_cents, row.currency),
    periodStart: row.period_start?.toISOString(),
    periodEnd: row.period_end?.toISOString(),
    isManual: row.is_manual,
    checkoutUrl: row.checkout_url || undefined,
    createdAt: row.created_at.toISOString(),
  };
}

async function getOrCreateSettings(institutionId) {
  const { rows } = await query(
    `SELECT * FROM institution_membership_settings WHERE institution_id = $1`,
    [institutionId],
  );
  if (rows.length) return rows[0];
  const { rows: inserted } = await query(
    `INSERT INTO institution_membership_settings (institution_id)
     VALUES ($1) ON CONFLICT (institution_id) DO NOTHING
     RETURNING *`,
    [institutionId],
  );
  if (inserted.length) return inserted[0];
  const { rows: again } = await query(
    `SELECT * FROM institution_membership_settings WHERE institution_id = $1`,
    [institutionId],
  );
  return again[0];
}

async function getPlanForInstitution(institutionId, planId) {
  const { rows } = await query(
    `SELECT * FROM membership_plans WHERE id = $1 AND institution_id = $2`,
    [planId, institutionId],
  );
  if (!rows.length) throw notFound('Membership plan not found');
  return rows[0];
}

async function linkMemberToUser(memberId, userId) {
  const { rows } = await query(`SELECT * FROM club_members WHERE id = $1`, [memberId]);
  if (!rows.length) return;
  const member = rows[0];
  if (member.user_id && member.user_id !== userId) return;

  const nextStatus = member.status === 'invited' ? 'pending_authorization' : member.status;

  await query(
    `UPDATE club_members
     SET user_id = $1,
         status = $2,
         joined_at = COALESCE(joined_at, now()),
         updated_at = now()
     WHERE id = $3`,
    [userId, nextStatus, memberId],
  );

  const { rows: subs } = await query(
    `SELECT id FROM membership_subscriptions WHERE club_member_id = $1`,
    [memberId],
  );
  if (!subs.length) {
    const subStatus =
      nextStatus === 'active'
        ? 'active'
        : ['pending_payment', 'overdue'].includes(nextStatus)
          ? 'past_due'
          : 'pending_authorization';
    await query(
      `INSERT INTO membership_subscriptions (club_member_id, institution_id, plan_id, status)
       VALUES ($1, $2, $3, $4)`,
      [memberId, member.institution_id, member.plan_id, subStatus],
    );
  }
}

async function syncMemberLinksForUser(userId) {
  const { rows: userRows } = await query(`SELECT email FROM users WHERE id = $1`, [userId]);
  if (!userRows.length) return;

  const { rows: pending } = await query(
    `SELECT id FROM club_members
     WHERE left_at IS NULL
       AND user_id IS NULL
       AND contact_email IS NOT NULL
       AND LOWER(contact_email) = LOWER($1)`,
    [userRows[0].email],
  );

  for (const row of pending) {
    await linkMemberToUser(row.id, userId);
  }
}

// ─── Plans (F-40) ───────────────────────────────────────────────────────────

async function listPlans(userId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT * FROM membership_plans
     WHERE institution_id = $1
     ORDER BY active DESC, name ASC`,
    [institution.id],
  );
  return rows.map(serializePlan);
}

async function getPlan(userId, planId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const row = await getPlanForInstitution(institution.id, planId);
  return serializePlan(row);
}

async function createPlan(userId, body) {
  const validated = validateMembershipPlan(body);
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rows } = await query(
    `INSERT INTO membership_plans (
      institution_id, name, description, price_cents, price_currency,
      billing_frequency, plan_type, max_members, active
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      institution.id,
      validated.name,
      validated.description || '',
      validated.priceCents,
      validated.priceCurrency || defaultCurrency,
      validated.billingFrequency,
      validated.planType || 'individual',
      validated.maxMembers ?? null,
      validated.active !== false,
    ],
  );
  return serializePlan(rows[0]);
}

async function updatePlan(userId, planId, body) {
  const validated = validateMembershipPlan(body, { partial: true });
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const existing = await getPlanForInstitution(institution.id, planId);

  const nextPlanType = validated.planType ?? existing.plan_type;
  const nextMaxMembers =
    validated.maxMembers !== undefined ? validated.maxMembers : existing.max_members;
  if (nextPlanType === 'family' && !nextMaxMembers) {
    throw badRequest('maxMembers is required for family plans');
  }

  const fieldMap = {
    name: 'name',
    description: 'description',
    priceCents: 'price_cents',
    priceCurrency: 'price_currency',
    billingFrequency: 'billing_frequency',
    planType: 'plan_type',
    maxMembers: 'max_members',
    active: 'active',
  };

  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(fieldMap)) {
    if (validated[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(validated[key]);
    }
  }
  if (!sets.length) throw badRequest('No valid fields to update');

  sets.push(`updated_at = now()`);
  values.push(planId, institution.id);

  const { rows } = await query(
    `UPDATE membership_plans SET ${sets.join(', ')}
     WHERE id = $${i++} AND institution_id = $${i}
     RETURNING *`,
    values,
  );
  if (!rows.length) throw notFound('Membership plan not found');
  return serializePlan(rows[0]);
}

async function deletePlan(userId, planId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  await getPlanForInstitution(institution.id, planId);

  const { rows: activeMembers } = await query(
    `SELECT id FROM club_members
     WHERE plan_id = $1 AND left_at IS NULL AND status NOT IN ('inactive', 'invited')`,
    [planId],
  );
  if (activeMembers.length) {
    throw conflict('PLAN_IN_USE', 'Cannot delete a plan with active members. Deactivate it instead.');
  }

  await query(`UPDATE membership_plans SET active = FALSE, updated_at = now() WHERE id = $1`, [
    planId,
  ]);
}

async function getSettings(userId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const settings = await getOrCreateSettings(institution.id);
  return {
    graceDays: settings.grace_days,
    dueReminderDays: settings.due_reminder_days,
  };
}

async function updateSettings(userId, body) {
  const validated = validateMembershipSettings(body);
  const institution = await institutionsService.getInstitutionByUserId(userId);
  await getOrCreateSettings(institution.id);

  const sets = [];
  const values = [];
  let i = 1;
  if (validated.graceDays !== undefined) {
    sets.push(`grace_days = $${i++}`);
    values.push(validated.graceDays);
  }
  if (validated.dueReminderDays !== undefined) {
    sets.push(`due_reminder_days = $${i++}`);
    values.push(validated.dueReminderDays);
  }
  if (!sets.length) throw badRequest('No valid fields to update');

  sets.push(`updated_at = now()`);
  values.push(institution.id);

  const { rows } = await query(
    `UPDATE institution_membership_settings SET ${sets.join(', ')}
     WHERE institution_id = $${i}
     RETURNING *`,
    values,
  );
  return {
    graceDays: rows[0].grace_days,
    dueReminderDays: rows[0].due_reminder_days,
  };
}

// ─── Invites (F-43) ─────────────────────────────────────────────────────────

async function createInvite(userId, body) {
  const validated = validateMembershipInvite(body);
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const plan = await getPlanForInstitution(institution.id, validated.planId);
  if (!plan.active) throw badRequest('Plan is not active');

  const code = generateInviteCode();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + validated.expiresInDays);

  const { rows } = await query(
    `INSERT INTO membership_invites (
      institution_id, plan_id, code, email, invited_name, invited_phone, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      institution.id,
      plan.id,
      code,
      validated.email || null,
      validated.invitedName || null,
      validated.invitedPhone || null,
      expiresAt,
    ],
  );

  const invite = rows[0];

  if (validated.email) {
    sendMembershipInviteEmail({
      to: validated.email,
      institutionName: institution.name,
      planName: plan.name,
      inviteCode: code,
    }).catch((err) => console.warn('[memberships] invite email failed:', err.message));

    notificationsService
      .notifyMembershipInvite({
        email: validated.email,
        institutionName: institution.name,
        inviteCode: code,
      })
      .catch((err) => console.warn('[memberships] invite push failed:', err.message));
  }

  return serializeInvite(invite, { planName: plan.name, institutionName: institution.name });
}

async function bulkCreateInvites(userId, body) {
  const { members } = body ?? {};
  if (!Array.isArray(members) || !members.length) {
    throw badRequest('members array is required');
  }
  if (members.length > 500) throw badRequest('Maximum 500 members per bulk upload');

  const batchId = crypto.randomUUID();
  const results = [];
  for (const row of members) {
    try {
      const invite = await createInvite(userId, { ...row, expiresInDays: row.expiresInDays ?? 30 });
      await query(`UPDATE membership_invites SET bulk_batch_id = $1 WHERE id = $2`, [
        batchId,
        invite.id,
      ]);
      results.push({ ok: true, invite });
    } catch (err) {
      results.push({ ok: false, error: err.message, row });
    }
  }
  return { batchId, results };
}

async function listInvites(userId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT mi.*, mp.name AS plan_name
     FROM membership_invites mi
     JOIN membership_plans mp ON mp.id = mi.plan_id
     WHERE mi.institution_id = $1
     ORDER BY mi.created_at DESC`,
    [institution.id],
  );
  return rows.map((r) =>
    serializeInvite(r, { planName: r.plan_name, institutionName: institution.name }),
  );
}

async function cancelInvite(userId, inviteId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rows } = await query(
    `UPDATE membership_invites
     SET status = 'cancelled'
     WHERE id = $1 AND institution_id = $2 AND status = 'pending'
     RETURNING *`,
    [inviteId, institution.id],
  );
  if (!rows.length) throw notFound('Invite not found or already used');
}

async function getInviteByCode(code) {
  const { rows } = await query(
    `SELECT mi.*, mp.name AS plan_name, mp.price_cents, mp.price_currency,
            mp.billing_frequency, mp.plan_type, mp.description AS plan_description,
            i.name AS institution_name, i.logo_url AS institution_logo
     FROM membership_invites mi
     JOIN membership_plans mp ON mp.id = mi.plan_id
     JOIN institutions i ON i.id = mi.institution_id
     WHERE mi.code = $1`,
    [code.toUpperCase()],
  );
  if (!rows.length) throw notFound('Invite not found');

  const row = rows[0];
  if (row.status !== 'pending') throw badRequest('Invite is no longer valid');
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    await query(`UPDATE membership_invites SET status = 'expired' WHERE id = $1`, [row.id]);
    throw badRequest('Invite has expired');
  }

  return {
    code: row.code,
    institutionName: row.institution_name,
    institutionLogo: row.institution_logo || undefined,
    plan: {
      id: row.plan_id,
      name: row.plan_name,
      description: row.plan_description || '',
      price: serializeMoney(row.price_cents, row.price_currency),
      billingFrequency: row.billing_frequency,
      planType: row.plan_type,
    },
    invitedName: row.invited_name || undefined,
    email: row.email || undefined,
    expiresAt: row.expires_at?.toISOString(),
  };
}

// ─── Members (F-39) ─────────────────────────────────────────────────────────

async function listMembers(userId, { status } = {}) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const values = [institution.id];
  let statusFilter = `AND cm.left_at IS NULL`;
  if (status) {
    if (status === 'up_to_date') {
      statusFilter += ` AND cm.status = 'active'`;
    } else if (status === 'pending') {
      statusFilter += ` AND cm.status IN ('invited', 'pending_authorization', 'pending_payment')`;
    } else if (status === 'overdue') {
      statusFilter += ` AND cm.status = 'overdue'`;
    } else if (status === 'inactive') {
      statusFilter = `AND cm.status = 'inactive'`;
    }
  }

  const { rows } = await query(
    `SELECT cm.*, mp.name AS plan_name, ms.next_billing_at, ms.status AS subscription_status
     FROM club_members cm
     JOIN membership_plans mp ON mp.id = cm.plan_id
     LEFT JOIN membership_subscriptions ms ON ms.club_member_id = cm.id
     WHERE cm.institution_id = $1 ${statusFilter}
     ORDER BY cm.created_at DESC`,
    values,
  );

  return rows.map((r) =>
    serializeMember(r, {
      planName: r.plan_name,
      institutionName: institution.name,
      nextBillingAt: r.next_billing_at?.toISOString(),
      subscriptionStatus: r.subscription_status,
    }),
  );
}

async function addMember(userId, body) {
  const validated = validateAddMember(body);
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const plan = await getPlanForInstitution(institution.id, validated.planId);

  let memberUserId = validated.userId;
  if (!memberUserId && validated.contactEmail) {
    const { rows } = await query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
      [validated.contactEmail],
    );
    memberUserId = rows[0]?.id;
  }

  if (memberUserId) {
    const { rows: existing } = await query(
      `SELECT id FROM club_members
       WHERE institution_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [institution.id, memberUserId],
    );
    if (existing.length) throw conflict('ALREADY_MEMBER', 'User is already a member of this club');
  }

  const { rows } = await query(
    `INSERT INTO club_members (
      institution_id, user_id, plan_id, status,
      contact_name, contact_email, contact_phone, joined_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      institution.id,
      memberUserId || null,
      plan.id,
      memberUserId ? 'pending_authorization' : 'invited',
      validated.contactName || null,
      validated.contactEmail || null,
      validated.contactPhone || null,
      memberUserId ? new Date() : null,
    ],
  );

  const member = rows[0];

  if (memberUserId) {
    await query(
      `INSERT INTO membership_subscriptions (club_member_id, institution_id, plan_id, status)
       VALUES ($1, $2, $3, 'pending_authorization')`,
      [member.id, institution.id, plan.id],
    );
  }

  return serializeMember(member, { planName: plan.name, institutionName: institution.name });
}

async function getMemberForInstitution(institutionId, memberId) {
  const { rows } = await query(
    `SELECT cm.*, mp.name AS plan_name, ms.next_billing_at, ms.status AS subscription_status
     FROM club_members cm
     JOIN membership_plans mp ON mp.id = cm.plan_id
     LEFT JOIN membership_subscriptions ms ON ms.club_member_id = cm.id
     WHERE cm.id = $1 AND cm.institution_id = $2`,
    [memberId, institutionId],
  );
  if (!rows.length) throw notFound('Member not found');
  return rows[0];
}

async function getMember(userId, memberId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const row = await getMemberForInstitution(institution.id, memberId);
  return serializeMember(row, {
    planName: row.plan_name,
    institutionName: institution.name,
    nextBillingAt: row.next_billing_at?.toISOString(),
    subscriptionStatus: row.subscription_status,
  });
}

async function updateMember(userId, memberId, body) {
  const validated = validateUpdateMember(body);
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const member = await getMemberForInstitution(institution.id, memberId);

  if (member.left_at) {
    throw badRequest('Cannot update an inactive member');
  }

  if (validated.planId) {
    await getPlanForInstitution(institution.id, validated.planId);
  }

  if (validated.contactEmail) {
    const { rows: linkedUser } = await query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
      [validated.contactEmail],
    );
    if (linkedUser.length) {
      const { rows: conflictMember } = await query(
        `SELECT id FROM club_members
         WHERE institution_id = $1 AND user_id = $2 AND left_at IS NULL AND id <> $3`,
        [institution.id, linkedUser[0].id, memberId],
      );
      if (conflictMember.length) {
        throw conflict('ALREADY_MEMBER', 'Another member with this email is already registered');
      }
    }
  }

  const fieldMap = {
    planId: 'plan_id',
    contactName: 'contact_name',
    contactEmail: 'contact_email',
    contactPhone: 'contact_phone',
  };

  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(fieldMap)) {
    if (validated[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(validated[key]);
    }
  }

  if (!sets.length) throw badRequest('No valid fields to update');

  sets.push('updated_at = now()');
  values.push(memberId, institution.id);

  const { rows } = await query(
    `UPDATE club_members SET ${sets.join(', ')}
     WHERE id = $${i++} AND institution_id = $${i}
     RETURNING *`,
    values,
  );

  if (validated.planId) {
    await query(
      `UPDATE membership_subscriptions
       SET plan_id = $1, updated_at = now()
       WHERE club_member_id = $2`,
      [validated.planId, memberId],
    );
  }

  if (validated.contactEmail) {
    const { rows: users } = await query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
      [validated.contactEmail],
    );
    if (users.length) {
      await linkMemberToUser(memberId, users[0].id);
    }
  }

  return getMember(userId, memberId);
}

async function removeMember(userId, memberId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rows } = await query(
    `UPDATE club_members
     SET status = 'inactive', left_at = now(), updated_at = now()
     WHERE id = $1 AND institution_id = $2 AND left_at IS NULL
     RETURNING *`,
    [memberId, institution.id],
  );
  if (!rows.length) throw notFound('Member not found');

  await query(
    `UPDATE membership_subscriptions
     SET status = 'cancelled', updated_at = now()
     WHERE club_member_id = $1`,
    [memberId],
  );
}

async function getMembersSummary(userId) {
  const institution = await institutionsService.getInstitutionByUserId(userId);
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active' AND left_at IS NULL) AS up_to_date,
       COUNT(*) FILTER (WHERE status IN ('pending_payment', 'pending_authorization', 'invited') AND left_at IS NULL) AS pending,
       COUNT(*) FILTER (WHERE status = 'overdue' AND left_at IS NULL) AS overdue,
       COUNT(*) FILTER (WHERE left_at IS NULL) AS total
     FROM club_members
     WHERE institution_id = $1`,
    [institution.id],
  );
  return {
    upToDate: Number(rows[0].up_to_date),
    pending: Number(rows[0].pending),
    overdue: Number(rows[0].overdue),
    total: Number(rows[0].total),
  };
}

// ─── Athlete: accept invite & authorize (F-41, F-43) ────────────────────────

async function acceptInvite(user, code) {
  if (user.role !== 'athlete') {
    throw forbidden('Only athletes can join a club membership');
  }

  const invitePreview = await getInviteByCode(code);

  const { rows: inviteRows } = await query(`SELECT * FROM membership_invites WHERE code = $1`, [
    code.toUpperCase(),
  ]);
  const invite = inviteRows[0];

  if (invite.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
    throw forbidden('This invite was sent to a different email address');
  }

  const { rows: existing } = await query(
    `SELECT id FROM club_members
     WHERE institution_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [invite.institution_id, user.id],
  );
  if (existing.length) throw conflict('ALREADY_MEMBER', 'You are already a member of this club');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: memberRows } = await client.query(
      `INSERT INTO club_members (
        institution_id, user_id, plan_id, status, invite_id,
        contact_name, contact_email, contact_phone, joined_at
      ) VALUES ($1, $2, $3, 'pending_authorization', $4, $5, $6, $7, now())
      RETURNING *`,
      [
        invite.institution_id,
        user.id,
        invite.plan_id,
        invite.id,
        invite.invited_name || user.email,
        user.email,
        invite.invited_phone,
      ],
    );

    const member = memberRows[0];

    const { rows: subRows } = await client.query(
      `INSERT INTO membership_subscriptions (club_member_id, institution_id, plan_id, status)
       VALUES ($1, $2, $3, 'pending_authorization')
       RETURNING *`,
      [member.id, invite.institution_id, invite.plan_id],
    );

    await client.query(
      `UPDATE membership_invites
       SET status = 'accepted', accepted_by_user_id = $1, accepted_at = now()
       WHERE id = $2`,
      [user.id, invite.id],
    );

    await client.query('COMMIT');

    const authResult = await startAuthorization(user, member.id);

    return {
      member: serializeMember(member, {
        planName: invitePreview.plan.name,
        institutionName: invitePreview.institutionName,
      }),
      ...authResult,
      subscriptionId: subRows[0].id,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function loadMemberForUser(userId, memberId) {
  await syncMemberLinksForUser(userId);
  const { rows } = await query(
    `SELECT cm.*, mp.name AS plan_name, mp.price_cents, mp.price_currency,
            mp.billing_frequency, i.name AS institution_name, i.user_id AS institution_user_id,
            ms.id AS subscription_id, ms.status AS subscription_status,
            ms.next_billing_at, ms.authorization_url, ms.mp_preapproval_id
     FROM club_members cm
     JOIN membership_plans mp ON mp.id = cm.plan_id
     JOIN institutions i ON i.id = cm.institution_id
     LEFT JOIN membership_subscriptions ms ON ms.club_member_id = cm.id
     WHERE cm.id = $1 AND cm.left_at IS NULL
       AND (
         cm.user_id = $2
         OR LOWER(cm.contact_email) = (SELECT LOWER(email) FROM users WHERE id = $2)
       )`,
    [memberId, userId],
  );
  if (!rows.length) throw notFound('Membership not found');
  return rows[0];
}

async function startAuthorization(user, memberId) {
  const member = await loadMemberForUser(user.id, memberId);
  if (!['pending_authorization', 'overdue', 'pending_payment'].includes(member.status)) {
    throw badRequest('Membership does not require authorization');
  }
  if (!isPaymentsActive()) throw badRequest('Payments are not configured');

  const plan = {
    name: member.plan_name,
    price_cents: member.price_cents,
    price_currency: member.price_currency,
    billing_frequency: member.billing_frequency,
  };

  let authorizationUrl = null;
  let preapprovalId = null;

  if (isMercadoPagoConfigured()) {
    const preapproval = await createPreapproval({
      externalReference: `msub:${member.subscription_id}`,
      reason: `${member.institution_name} — ${plan.name}`,
      amountCents: plan.price_cents,
      currency: plan.price_currency,
      payerEmail: user.email,
      billingFrequency: plan.billing_frequency,
      returnMemberId: member.id,
    });
    preapprovalId = preapproval.preapprovalId;
    authorizationUrl = preapproval.authorizationUrl;
  } else if (useMockPayments()) {
    authorizationUrl = buildMockMembershipAuthorizeUrl(member.subscription_id);
  }

  await query(
    `UPDATE membership_subscriptions
     SET mp_preapproval_id = $2, authorization_url = $3, updated_at = now()
     WHERE id = $1`,
    [member.subscription_id, preapprovalId, authorizationUrl],
  );

  return { authorizationUrl, preapprovalId };
}

async function activateSubscription(subscriptionId, { preapprovalId, providerPaymentId } = {}) {
  const { rows } = await query(`SELECT * FROM membership_subscriptions WHERE id = $1`, [
    subscriptionId,
  ]);
  if (!rows.length) throw notFound('Subscription not found');
  const sub = rows[0];

  if (sub.status === 'active') {
    if (providerPaymentId) {
      const { rows: dup } = await query(
        `SELECT id FROM membership_payments WHERE provider_payment_id = $1`,
        [providerPaymentId],
      );
      if (!dup.length) {
        await recordRecurringPayment(subscriptionId, { providerPaymentId });
      }
    }
    return sub;
  }

  if (sub.status !== 'pending_authorization') {
    throw badRequest('Subscription cannot be activated');
  }

  const { rows: planRows } = await query(`SELECT * FROM membership_plans WHERE id = $1`, [
    sub.plan_id,
  ]);
  const plan = planRows[0];
  const now = new Date();
  const periodEnd = addBillingPeriod(now, plan.billing_frequency);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE membership_subscriptions
       SET status = 'active',
           mp_preapproval_id = COALESCE($2, mp_preapproval_id),
           last_billed_at = now(),
           next_billing_at = $3,
           retry_count = 0,
           last_failure_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [subscriptionId, preapprovalId || null, periodEnd],
    );

    await client.query(
      `UPDATE club_members SET status = 'active', updated_at = now() WHERE id = $1`,
      [sub.club_member_id],
    );

    const { rows: paymentRows } = await client.query(
      `INSERT INTO membership_payments (
        subscription_id, club_member_id, institution_id,
        status, amount_cents, currency, period_start, period_end, provider_payment_id
      ) VALUES ($1, $2, $3, 'approved', $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        subscriptionId,
        sub.club_member_id,
        sub.institution_id,
        plan.price_cents,
        plan.price_currency,
        now,
        periodEnd,
        providerPaymentId || null,
      ],
    );

    await client.query('COMMIT');

    const { rows: memberCtx } = await query(
      `SELECT cm.user_id, u.email, i.name AS institution_name, mp.name AS plan_name
       FROM club_members cm
       JOIN users u ON u.id = cm.user_id
       JOIN institutions i ON i.id = cm.institution_id
       JOIN membership_plans mp ON mp.id = cm.plan_id
       WHERE cm.id = $1`,
      [sub.club_member_id],
    );

    if (memberCtx.length) {
      const ctx = memberCtx[0];
      sendMembershipPaymentReceiptEmail({
        to: ctx.email,
        institutionName: ctx.institution_name,
        planName: ctx.plan_name,
        amountCents: plan.price_cents,
        currency: plan.price_currency,
      }).catch((err) => console.warn('[memberships] receipt email failed:', err.message));

      notificationsService
        .notifyMembershipPaymentConfirmed({
          userId: ctx.user_id,
          memberId: sub.club_member_id,
          institutionName: ctx.institution_name,
        })
        .catch((err) => console.warn('[memberships] payment push failed:', err.message));
    }

    return paymentRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Statement & debt payment (F-42) ──────────────────────────────────────────

async function getMyMemberships(userId) {
  await syncMemberLinksForUser(userId);
  const { rows } = await query(
    `SELECT cm.*, mp.name AS plan_name, mp.billing_frequency,
            i.name AS institution_name, i.logo_url,
            ms.next_billing_at, ms.status AS subscription_status
     FROM club_members cm
     JOIN membership_plans mp ON mp.id = cm.plan_id
     JOIN institutions i ON i.id = cm.institution_id
     LEFT JOIN membership_subscriptions ms ON ms.club_member_id = cm.id
     WHERE cm.left_at IS NULL
       AND (
         cm.user_id = $1
         OR LOWER(cm.contact_email) = (SELECT LOWER(email) FROM users WHERE id = $1)
       )
     ORDER BY cm.created_at DESC`,
    [userId],
  );
  return rows.map((r) =>
    serializeMember(r, {
      planName: r.plan_name,
      institutionName: r.institution_name,
      nextBillingAt: r.next_billing_at?.toISOString(),
      subscriptionStatus: r.subscription_status,
    }),
  );
}

async function getStatement(userId, memberId) {
  const member = await loadMemberForUser(userId, memberId);

  const { rows: payments } = await query(
    `SELECT * FROM membership_payments
     WHERE club_member_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [memberId],
  );

  const settings = await getOrCreateSettings(member.institution_id);
  let amountDueCents = 0;
  if (['overdue', 'pending_payment'].includes(member.status)) {
    amountDueCents = member.price_cents;
  }

  return {
    member: serializeMember(member, {
      planName: member.plan_name,
      institutionName: member.institution_name,
      nextBillingAt: member.next_billing_at?.toISOString(),
      subscriptionStatus: member.subscription_status,
    }),
    plan: {
      name: member.plan_name,
      price: serializeMoney(member.price_cents, member.price_currency),
      billingFrequency: member.billing_frequency,
    },
    nextDueDate: member.next_billing_at?.toISOString(),
    amountDue: amountDueCents > 0 ? serializeMoney(amountDueCents, member.price_currency) : null,
    graceDays: settings.grace_days,
    payments: payments.map(serializePayment),
  };
}

async function payDebt(userId, memberId) {
  const member = await loadMemberForUser(userId, memberId);
  if (!['overdue', 'pending_payment'].includes(member.status)) {
    throw badRequest('No outstanding debt for this membership');
  }
  if (!isPaymentsActive()) throw badRequest('Payments are not configured');

  const amountCents = member.price_cents;
  const externalReference = `msub_pay:${member.subscription_id}:${Date.now()}`;

  let preferenceId = null;
  let checkoutUrl = null;

  const { rows: paymentRows } = await query(
    `INSERT INTO membership_payments (
      subscription_id, club_member_id, institution_id,
      amount_cents, currency, is_manual, status
    ) VALUES ($1, $2, $3, $4, $5, TRUE, 'pending')
    RETURNING *`,
    [
      member.subscription_id,
      memberId,
      member.institution_id,
      amountCents,
      member.price_currency,
    ],
  );
  const payment = paymentRows[0];

  const payRef = `msub_pay:${payment.id}`;

  if (isMercadoPagoConfigured()) {
    const preference = await createCheckoutPreference({
      externalReference: payRef,
      title: `${member.institution_name} — cuota pendiente`,
      amountCents,
      currency: member.price_currency,
      membershipMemberId: memberId,
    });
    preferenceId = preference.preferenceId;
    checkoutUrl = preference.checkoutUrl;
  } else if (useMockPayments()) {
    checkoutUrl = `${require('../config/env').apiPublicUrl}/v1/memberships/mock-checkout/${payment.id}`;
  }

  await query(
    `UPDATE membership_payments
     SET preference_id = $2, checkout_url = $3, updated_at = now()
     WHERE id = $1`,
    [payment.id, preferenceId, checkoutUrl],
  );

  return {
    paymentId: payment.id,
    checkoutUrl,
    amount: serializeMoney(amountCents, member.price_currency),
  };
}

async function confirmMembershipPayment(paymentId, providerPaymentId = null) {
  const { rows } = await query(`SELECT * FROM membership_payments WHERE id = $1`, [paymentId]);
  if (!rows.length) throw notFound('Payment not found');
  const payment = rows[0];
  if (payment.status === 'approved') return payment;

  const { rows: planRows } = await query(
    `SELECT mp.* FROM membership_plans mp
     JOIN club_members cm ON cm.plan_id = mp.id
     WHERE cm.id = $1`,
    [payment.club_member_id],
  );
  const plan = planRows[0];
  const now = new Date();
  const periodEnd = addBillingPeriod(now, plan.billing_frequency);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE membership_payments
       SET status = 'approved',
           provider_payment_id = COALESCE($2, provider_payment_id),
           period_start = COALESCE(period_start, $3),
           period_end = COALESCE(period_end, $4),
           updated_at = now()
       WHERE id = $1`,
      [paymentId, providerPaymentId, now, periodEnd],
    );

    await client.query(
      `UPDATE membership_subscriptions
       SET status = 'active',
           last_billed_at = now(),
           next_billing_at = $2,
           retry_count = 0,
           last_failure_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [payment.subscription_id, periodEnd],
    );

    await client.query(
      `UPDATE club_members SET status = 'active', updated_at = now() WHERE id = $1`,
      [payment.club_member_id],
    );

    await client.query('COMMIT');

    const { rows: ctx } = await query(
      `SELECT cm.user_id, u.email, i.name AS institution_name, mp.name AS plan_name
       FROM club_members cm
       JOIN users u ON u.id = cm.user_id
       JOIN institutions i ON i.id = cm.institution_id
       JOIN membership_plans mp ON mp.id = cm.plan_id
       WHERE cm.id = $1`,
      [payment.club_member_id],
    );
    if (ctx.length) {
      sendMembershipPaymentReceiptEmail({
        to: ctx[0].email,
        institutionName: ctx[0].institution_name,
        planName: ctx[0].plan_name,
        amountCents: payment.amount_cents,
        currency: payment.currency,
      }).catch(() => {});
      notificationsService
        .notifyMembershipPaymentConfirmed({
          userId: ctx[0].user_id,
          memberId: payment.club_member_id,
          institutionName: ctx[0].institution_name,
        })
        .catch(() => {});
    }

    return payment;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getMembershipPaymentById(paymentId) {
  const { rows } = await query(`SELECT * FROM membership_payments WHERE id = $1`, [paymentId]);
  if (!rows.length) throw notFound('Payment not found');
  return rows[0];
}

async function getMembershipPaymentForUser(userId, memberId, paymentId) {
  await loadMemberForUser(userId, memberId);
  const payment = await getMembershipPaymentById(paymentId);
  if (payment.club_member_id !== memberId) {
    throw forbidden('Payment does not belong to this membership');
  }
  return serializePayment(payment);
}

async function syncMembershipPayment(userId, memberId, paymentId) {
  await loadMemberForUser(userId, memberId);
  const payment = await getMembershipPaymentById(paymentId);
  if (payment.club_member_id !== memberId) {
    throw forbidden('Payment does not belong to this membership');
  }

  if (payment.status === 'approved') {
    const member = await loadMemberForUser(userId, memberId);
    return {
      synced: true,
      payment: serializePayment(payment),
      memberFeeStatus: mapFeeStatus(member.status),
    };
  }

  if (!isMercadoPagoConfigured()) {
    return {
      synced: false,
      payment: serializePayment(payment),
      reason: 'mercadopago_not_configured',
    };
  }

  const payRef = `msub_pay:${paymentId}`;
  const mpPayments = await searchMercadoPagoPaymentsByReference(payRef);
  const approved = mpPayments.find((p) => p.status === 'approved');
  if (approved) {
    await confirmMembershipPayment(paymentId, String(approved.id));
    const updated = await getMembershipPaymentById(paymentId);
    const member = await loadMemberForUser(userId, memberId);
    return {
      synced: true,
      payment: serializePayment(updated),
      memberFeeStatus: mapFeeStatus(member.status),
    };
  }

  const rejected = mpPayments.find((p) => ['rejected', 'cancelled'].includes(p.status));
  if (rejected) {
    await query(
      `UPDATE membership_payments SET status = 'rejected', updated_at = now() WHERE id = $1`,
      [paymentId],
    );
    const updated = await getMembershipPaymentById(paymentId);
    return {
      synced: true,
      payment: serializePayment(updated),
      memberFeeStatus: mapFeeStatus((await loadMemberForUser(userId, memberId)).status),
    };
  }

  return {
    synced: false,
    payment: serializePayment(payment),
    reason: 'payment_not_found',
  };
}

async function handlePreapprovalAuthorized(subscriptionId, preapprovalId) {
  const { rows } = await query(`SELECT * FROM membership_subscriptions WHERE id = $1`, [
    subscriptionId,
  ]);
  if (!rows.length) return { processed: false, reason: 'subscription_not_found' };
  const sub = rows[0];

  if (preapprovalId && sub.mp_preapproval_id !== preapprovalId) {
    await query(
      `UPDATE membership_subscriptions SET mp_preapproval_id = $2, updated_at = now() WHERE id = $1`,
      [subscriptionId, preapprovalId],
    );
  }

  if (sub.status === 'active') {
    return { processed: true, subscriptionId, status: 'already_active' };
  }

  if (sub.status === 'pending_authorization') {
    await activateSubscription(subscriptionId, { preapprovalId });
    return { processed: true, subscriptionId, status: 'activated' };
  }

  return { processed: false, subscriptionId, reason: 'invalid_status', status: sub.status };
}

async function handlePreapprovalCancelled(subscriptionId) {
  const { rows } = await query(
    `SELECT ms.id, cm.id AS club_member_id
     FROM membership_subscriptions ms
     JOIN club_members cm ON cm.id = ms.club_member_id
     WHERE ms.id = $1`,
    [subscriptionId],
  );
  if (!rows.length) return { processed: false, reason: 'subscription_not_found' };

  await query(
    `UPDATE membership_subscriptions SET status = 'cancelled', updated_at = now() WHERE id = $1`,
    [subscriptionId],
  );
  await query(`UPDATE club_members SET status = 'inactive', updated_at = now() WHERE id = $1`, [
    rows[0].club_member_id,
  ]);

  return { processed: true, subscriptionId, status: 'cancelled' };
}

async function handleSubscriptionPaymentFailure(subscriptionId) {
  const { rows } = await query(
    `SELECT ms.*, cm.user_id, i.name AS institution_name
     FROM membership_subscriptions ms
     JOIN club_members cm ON cm.id = ms.club_member_id
     JOIN institutions i ON i.id = ms.institution_id
     WHERE ms.id = $1`,
    [subscriptionId],
  );
  if (!rows.length) return;
  const sub = rows[0];

  const nextRetry = sub.retry_count + 1;
  const cancelSubscription = nextRetry >= MEMBERSHIP_MAX_PAYMENT_RETRIES;

  await query(
    `UPDATE club_members SET status = $2, updated_at = now() WHERE id = $1`,
    [sub.club_member_id, cancelSubscription ? 'inactive' : 'pending_payment'],
  );
  await query(
    `UPDATE membership_subscriptions
     SET status = $2,
         last_failure_at = now(),
         retry_count = retry_count + 1,
         updated_at = now()
     WHERE id = $1`,
    [subscriptionId, cancelSubscription ? 'cancelled' : 'past_due'],
  );

  if (sub.user_id) {
    notificationsService
      .notifyMembershipPaymentFailed({
        userId: sub.user_id,
        memberId: sub.club_member_id,
        institutionName: sub.institution_name,
      })
      .catch(() => {});
  }
}

async function recordRecurringPayment(
  subscriptionId,
  { providerPaymentId, amountCents, currency } = {},
) {
  const { rows } = await query(
    `SELECT ms.*, cm.user_id
     FROM membership_subscriptions ms
     JOIN club_members cm ON cm.id = ms.club_member_id
     WHERE ms.id = $1`,
    [subscriptionId],
  );
  if (!rows.length) throw notFound('Subscription not found');
  const sub = rows[0];

  if (providerPaymentId) {
    const { rows: dup } = await query(
      `SELECT id FROM membership_payments WHERE provider_payment_id = $1`,
      [providerPaymentId],
    );
    if (dup.length) return dup[0];
  }

  const { rows: planRows } = await query(`SELECT * FROM membership_plans WHERE id = $1`, [
    sub.plan_id,
  ]);
  const plan = planRows[0];
  const now = new Date();
  const periodEnd = addBillingPeriod(now, plan.billing_frequency);
  const cents = amountCents ?? plan.price_cents;
  const curr = currency ?? plan.price_currency;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: paymentRows } = await client.query(
      `INSERT INTO membership_payments (
        subscription_id, club_member_id, institution_id,
        status, amount_cents, currency, period_start, period_end, provider_payment_id
      ) VALUES ($1, $2, $3, 'approved', $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        subscriptionId,
        sub.club_member_id,
        sub.institution_id,
        cents,
        curr,
        now,
        periodEnd,
        providerPaymentId || null,
      ],
    );

    await client.query(
      `UPDATE membership_subscriptions
       SET status = 'active',
           last_billed_at = now(),
           next_billing_at = $2,
           retry_count = 0,
           last_failure_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [subscriptionId, periodEnd],
    );

    await client.query(
      `UPDATE club_members SET status = 'active', updated_at = now() WHERE id = $1`,
      [sub.club_member_id],
    );

    await client.query('COMMIT');

    if (sub.user_id) {
      const { rows: ctx } = await query(
        `SELECT u.email, i.name AS institution_name, mp.name AS plan_name
         FROM users u
         JOIN club_members cm ON cm.user_id = u.id
         JOIN institutions i ON i.id = cm.institution_id
         JOIN membership_plans mp ON mp.id = cm.plan_id
         WHERE cm.id = $1`,
        [sub.club_member_id],
      );
      if (ctx.length) {
        sendMembershipPaymentReceiptEmail({
          to: ctx[0].email,
          institutionName: ctx[0].institution_name,
          planName: ctx[0].plan_name,
          amountCents: cents,
          currency: curr,
        }).catch(() => {});
        notificationsService
          .notifyMembershipPaymentConfirmed({
            userId: sub.user_id,
            memberId: sub.club_member_id,
            institutionName: ctx[0].institution_name,
          })
          .catch(() => {});
      }
    }

    return paymentRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function processSubscriptionPayment(
  subscriptionId,
  { providerPaymentId, status, amountCents, currency } = {},
) {
  const { rows } = await query(`SELECT * FROM membership_subscriptions WHERE id = $1`, [
    subscriptionId,
  ]);
  if (!rows.length) return { processed: false, reason: 'subscription_not_found' };
  const sub = rows[0];

  if (providerPaymentId) {
    const { rows: dup } = await query(
      `SELECT id FROM membership_payments WHERE provider_payment_id = $1`,
      [providerPaymentId],
    );
    if (dup.length) {
      return { processed: true, subscriptionId, status: 'duplicate', duplicate: true };
    }
  }

  if (status !== 'approved') {
    await handleSubscriptionPaymentFailure(subscriptionId);
    return { processed: true, subscriptionId, status: status || 'rejected' };
  }

  if (sub.status === 'pending_authorization') {
    await activateSubscription(subscriptionId, {
      preapprovalId: sub.mp_preapproval_id,
      providerPaymentId,
    });
    return { processed: true, subscriptionId, status: 'activated' };
  }

  if (['active', 'past_due'].includes(sub.status)) {
    await recordRecurringPayment(subscriptionId, { providerPaymentId, amountCents, currency });
    return { processed: true, subscriptionId, status: 'recurring_recorded' };
  }

  return { processed: false, subscriptionId, reason: 'invalid_status', status: sub.status };
}

async function processSubscriptionPaymentByPreapproval(
  preapprovalId,
  { providerPaymentId, status, amountCents, currency } = {},
) {
  const { rows } = await query(
    `SELECT id FROM membership_subscriptions WHERE mp_preapproval_id = $1`,
    [preapprovalId],
  );
  if (!rows.length) return { processed: false, reason: 'subscription_not_found' };
  return processSubscriptionPayment(rows[0].id, {
    providerPaymentId,
    status,
    amountCents,
    currency,
  });
}

// ─── Scheduler helpers (F-41, F-44) ─────────────────────────────────────────

async function processDueBilling() {
  const { rows } = await query(
    `SELECT ms.*, cm.user_id, cm.status AS member_status,
            mp.price_cents, mp.price_currency, mp.billing_frequency, mp.name AS plan_name,
            u.email, i.name AS institution_name, i.user_id AS institution_user_id
     FROM membership_subscriptions ms
     JOIN club_members cm ON cm.id = ms.club_member_id
     JOIN membership_plans mp ON mp.id = ms.plan_id
     JOIN users u ON u.id = cm.user_id
     JOIN institutions i ON i.id = ms.institution_id
     WHERE ms.status = 'active'
       AND ms.next_billing_at IS NOT NULL
       AND ms.next_billing_at <= now()
       AND cm.left_at IS NULL`,
  );

  for (const sub of rows) {
    if (sub.mp_preapproval_id) {
      // Auto-debit authorized — Mercado Pago (or mock) charges via webhooks.
      continue;
    }

    if (sub.retry_count >= MEMBERSHIP_MAX_PAYMENT_RETRIES) {
      await query(
        `UPDATE membership_subscriptions SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [sub.id],
      );
      await query(`UPDATE club_members SET status = 'inactive', updated_at = now() WHERE id = $1`, [
        sub.club_member_id,
      ]);
      continue;
    }

    await handleSubscriptionPaymentFailure(sub.id);
  }
}

async function processDelinquency() {
  const { rows } = await query(
    `SELECT cm.id, cm.user_id, cm.institution_id, ims.grace_days,
            i.name AS institution_name, i.user_id AS institution_user_id, u.email
     FROM club_members cm
     JOIN institution_membership_settings ims ON ims.institution_id = cm.institution_id
     JOIN institutions i ON i.id = cm.institution_id
     JOIN users u ON u.id = cm.user_id
     JOIN membership_subscriptions ms ON ms.club_member_id = cm.id
     WHERE cm.status = 'pending_payment'
       AND cm.left_at IS NULL
       AND ms.last_failure_at IS NOT NULL
       AND ms.last_failure_at + (ims.grace_days || ' days')::interval < now()`,
  );

  for (const row of rows) {
    await query(`UPDATE club_members SET status = 'overdue', updated_at = now() WHERE id = $1`, [
      row.id,
    ]);

    notificationsService
      .notifyMembershipOverdue({
        userId: row.user_id,
        memberId: row.id,
        institutionName: row.institution_name,
      })
      .catch(() => {});

    sendMembershipOverdueEmail({
      to: row.email,
      institutionName: row.institution_name,
    }).catch(() => {});
  }
}

async function processDueReminders() {
  const { rows } = await query(
    `SELECT cm.id AS member_id, cm.user_id, ms.next_billing_at,
            i.name AS institution_name, mp.name AS plan_name, u.email,
            ims.due_reminder_days
     FROM membership_subscriptions ms
     JOIN club_members cm ON cm.id = ms.club_member_id
     JOIN institutions i ON i.id = ms.institution_id
     JOIN membership_plans mp ON mp.id = ms.plan_id
     JOIN users u ON u.id = cm.user_id
     JOIN institution_membership_settings ims ON ims.institution_id = ms.institution_id
     WHERE ms.status = 'active'
       AND cm.left_at IS NULL
       AND ms.next_billing_at BETWEEN now() AND now() + (ims.due_reminder_days || ' days')::interval`,
  );

  for (const row of rows) {
    notificationsService
      .notifyMembershipDueReminder({
        userId: row.user_id,
        memberId: row.member_id,
        institutionName: row.institution_name,
        dueDate: row.next_billing_at,
      })
      .catch(() => {});

    sendMembershipDueReminderEmail({
      to: row.email,
      institutionName: row.institution_name,
      planName: row.plan_name,
      dueDate: row.next_billing_at,
    }).catch(() => {});
  }
}

async function processClubArrearsAlerts() {
  const { rows } = await query(
    `SELECT i.user_id, i.name AS institution_name,
            COUNT(*) FILTER (WHERE cm.status = 'overdue') AS overdue_count
     FROM institutions i
     JOIN club_members cm ON cm.institution_id = i.id AND cm.left_at IS NULL
     GROUP BY i.id, i.user_id, i.name
     HAVING COUNT(*) FILTER (WHERE cm.status = 'overdue') > 0`,
  );

  for (const row of rows) {
    notificationsService
      .notifyClubArrearsAlert({
        userId: row.user_id,
        overdueCount: Number(row.overdue_count),
        institutionName: row.institution_name,
      })
      .catch(() => {});

    const { rows: gymUser } = await query(`SELECT email FROM users WHERE id = $1`, [row.user_id]);
    if (gymUser.length) {
      sendMembershipArrearsAlertEmail({
        to: gymUser[0].email,
        institutionName: row.institution_name,
        overdueCount: Number(row.overdue_count),
      }).catch(() => {});
    }
  }
}

async function runMembershipScheduler() {
  await processDueReminders();
  await processDueBilling();
  await processDelinquency();
  await processClubArrearsAlerts();
}

module.exports = {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  getSettings,
  updateSettings,
  createInvite,
  bulkCreateInvites,
  listInvites,
  cancelInvite,
  getInviteByCode,
  listMembers,
  addMember,
  getMember,
  updateMember,
  removeMember,
  getMembersSummary,
  acceptInvite,
  startAuthorization,
  activateSubscription,
  handlePreapprovalAuthorized,
  handlePreapprovalCancelled,
  processSubscriptionPayment,
  processSubscriptionPaymentByPreapproval,
  recordRecurringPayment,
  getMyMemberships,
  getStatement,
  payDebt,
  confirmMembershipPayment,
  getMembershipPaymentById,
  getMembershipPaymentForUser,
  syncMembershipPayment,
  runMembershipScheduler,
  processDueBilling,
  addBillingPeriod,
};
