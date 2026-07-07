const { query } = require('../db/pool');
const { sendPushToTokens } = require('./push.service');
const { listDeviceTokens, deleteTokens } = require('./notifications-devices.service');
const inboxService = require('./notifications-inbox.service');
const copy = require('./notification-copy');
const { tabForNotification } = require('./notification-tabs');

const PREF_BY_TYPE = {
  password_reset: null,
  booking_confirmed: 'bookingConfirmed',
  class_scheduled: 'bookingConfirmed',
  payment_confirmed: 'paymentUpdates',
  class_reminder_24h: 'classReminders',
  class_reminder_1h: 'classReminders',
  class_reminder_10m: 'classReminders',
  class_posted: null,
  class_ended: 'classReminders',
  instructor_invite: null,
  review_invite: 'reviewInvites',
  membership_invite: null,
  membership_due_reminder: 'paymentUpdates',
  membership_payment_confirmed: 'paymentUpdates',
  membership_payment_failed: 'paymentUpdates',
  membership_overdue: 'paymentUpdates',
  club_arrears_alert: 'paymentUpdates',
  verification_approved: null,
  verification_rejected: null,
  class_cancelled_by_instructor: 'bookingConfirmed',
  class_updated_by_instructor: 'classReminders',
  series_paused: 'classReminders',
  series_deleted: 'classReminders',
  waitlist_spot: 'bookingConfirmed',
  court_reservation_confirmed: 'bookingConfirmed',
};

function buildDedupeKey(userId, type, { bookingId, inviteId, memberId, dueDate, classId } = {}) {
  const dueKey = dueDate ? new Date(dueDate).toISOString().slice(0, 10) : '-';
  return [userId, type, bookingId || '-', inviteId || '-', memberId || '-', classId || '-', dueKey].join(':');
}

function formatClassWhen(startAt) {
  if (!startAt) return '';
  return new Date(startAt).toLocaleString('es-UY', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function getPreferences(userId) {
  const { rows } = await query(`SELECT * FROM notification_preferences WHERE user_id = $1`, [
    userId,
  ]);
  if (!rows.length) {
    return {
      bookingConfirmed: true,
      classReminders: true,
      paymentUpdates: true,
      creditsExpiring: true,
      reviewInvites: true,
      marketing: false,
    };
  }
  const p = rows[0];
  return {
    bookingConfirmed: p.booking_confirmed,
    classReminders: p.class_reminders,
    paymentUpdates: p.payment_updates,
    creditsExpiring: p.credits_expiring,
    reviewInvites: p.review_invites ?? true,
    marketing: p.marketing,
  };
}

function shouldSend(type, prefs) {
  const prefKey = PREF_BY_TYPE[type];
  if (prefKey === null) return true;
  return prefs[prefKey] === true;
}

async function claimDelivery(
  userId,
  type,
  dedupeKey,
  { bookingId = null, inviteId = null, memberId = null } = {},
) {
  try {
    await query(
      `INSERT INTO notification_deliveries (user_id, booking_id, invite_id, type, channel, dedupe_key)
       VALUES ($1, $2, $3, $4, 'push', $5)`,
      [userId, bookingId, inviteId || memberId, type, dedupeKey],
    );
    return true;
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

async function dispatchPush({
  userId,
  type,
  title,
  body,
  data = {},
  bookingId = null,
  inviteId = null,
  memberId = null,
  classId = null,
  dueDate = null,
  skipDedupe = false,
}) {
  try {
    const prefs = await getPreferences(userId);
    if (!shouldSend(type, prefs)) {
      return { sent: false, reason: 'pref_disabled' };
    }

    const dedupeKey = buildDedupeKey(userId, type, { bookingId, inviteId, memberId, dueDate, classId });
    if (!skipDedupe) {
      const claimed = await claimDelivery(userId, type, dedupeKey, {
        bookingId,
        inviteId,
        memberId,
      });
      if (!claimed) return { sent: false, reason: 'duplicate' };
    }

    const payload = { type, ...data };
    try {
      await inboxService.createInboxNotification({ userId, type, title, body, data: payload });
    } catch (inboxErr) {
      console.warn(`[notifications] inbox write failed for user ${userId}:`, inboxErr.message);
    }

    const tokens = await listDeviceTokens(userId);
    if (!tokens.length) {
      return { sent: false, reason: 'no_devices' };
    }

    const { sent, invalidTokens } = await sendPushToTokens(tokens, { title, body, data: payload });
    if (invalidTokens.length) {
      await deleteTokens(invalidTokens);
    }

    return { sent: sent > 0, successCount: sent, reason: sent > 0 ? undefined : 'push_failed' };
  } catch (err) {
    console.warn(`[notifications] ${type} push failed for user ${userId}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

async function getBookingContext(bookingId) {
  const { rows } = await query(
    `SELECT b.id, b.athlete_user_id, b.status, b.price_cents, b.price_currency,
            c.id AS class_id, c.title AS class_title, c.start_at,
            i.user_id AS instructor_user_id,
            ap.first_name AS athlete_first_name, ap.last_name AS athlete_last_name
     FROM bookings b
     JOIN classes c ON c.id = b.class_id
     JOIN instructors i ON i.id = c.instructor_id
     LEFT JOIN athlete_profiles ap ON ap.user_id = b.athlete_user_id
     WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0] || null;
}

async function getClassPublishContext(classId) {
  const { rows } = await query(
    `SELECT c.id, c.title, c.start_at, c.series_id,
            i.user_id AS instructor_user_id,
            inst.user_id AS institution_user_id
     FROM classes c
     JOIN instructors i ON i.id = c.instructor_id
     LEFT JOIN institutions inst ON inst.id = c.institution_id
     WHERE c.id = $1`,
    [classId],
  );
  return rows[0] || null;
}

async function notifyPasswordReset(userId) {
  return dispatchPush({
    userId,
    type: 'password_reset',
    title: 'Restablecer contraseña',
    body: 'Recibimos una solicitud para restablecer tu contraseña. Revisá tu email para continuar.',
    data: { screen: '/(auth)/forgot-password' },
    skipDedupe: true,
  });
}

async function notifyBookingConfirmed(bookingId, { skipAthlete = false } = {}) {
  const ctx = await getBookingContext(bookingId);
  if (!ctx) return;

  const when = copy.formatWhen(ctx.start_at);
  const athleteCopy = copy.classScheduledAthlete({ title: ctx.class_title, when });
  const instructorCopy = copy.classScheduledInstructor({
    title: ctx.class_title,
    when,
    athleteName: copy.athleteName(ctx),
  });

  const tasks = [];
  if (!skipAthlete) {
    tasks.push(
      dispatchPush({
        userId: ctx.athlete_user_id,
        type: 'class_scheduled',
        title: athleteCopy.title,
        body: athleteCopy.body,
        bookingId,
        data: {
          bookingId,
          classId: ctx.class_id,
          tab: tabForNotification('class_scheduled', 'athlete'),
          screen: '/(athlete)/(tabs)/bookings',
        },
      }),
    );
  }

  tasks.push(
    dispatchPush({
      userId: ctx.instructor_user_id,
      type: 'booking_confirmed',
      title: instructorCopy.title,
      body: instructorCopy.body,
      bookingId,
      data: {
        bookingId,
        classId: ctx.class_id,
        tab: tabForNotification('booking_confirmed', 'instructor'),
        screen: '/(instructor)/(tabs)/dashboard',
      },
    }),
  );

  await Promise.all(tasks);
}

async function notifyPaymentConfirmed(bookingId) {
  const ctx = await getBookingContext(bookingId);
  if (!ctx) return;

  const amount = (ctx.price_cents / 100).toFixed(2);
  const currency = ctx.price_currency || 'UYU';
  const { title, body } = copy.paymentConfirmed({
    title: ctx.class_title,
    amount,
    currency,
  });

  await dispatchPush({
    userId: ctx.athlete_user_id,
    type: 'payment_confirmed',
    title,
    body,
    bookingId,
    data: {
      bookingId,
      classId: ctx.class_id,
      tab: tabForNotification('payment_confirmed', 'athlete'),
      screen: '/(athlete)/(tabs)/bookings',
    },
  });
}

async function notifyClassPosted(classId, { instancesCreated = 1 } = {}) {
  const ctx = await getClassPublishContext(classId);
  if (!ctx) return;

  const when = copy.formatWhen(ctx.start_at);
  const isSeries = Boolean(ctx.series_id) || instancesCreated > 1;
  const { title, body } = copy.classPosted({
    title: ctx.title,
    when,
    isSeries,
    instanceCount: instancesCreated,
  });

  const payload = {
    type: 'class_posted',
    title,
    body,
    data: {
      classId,
      tab: tabForNotification('class_posted', 'instructor'),
      screen: '/(instructor)/(tabs)/classes',
    },
  };

  const tasks = [
    dispatchPush({
      userId: ctx.instructor_user_id,
      ...payload,
      classId,
    }),
  ];

  if (ctx.institution_user_id && ctx.institution_user_id !== ctx.instructor_user_id) {
    tasks.push(
      dispatchPush({
        userId: ctx.institution_user_id,
        ...payload,
        classId,
        data: {
          classId,
          tab: tabForNotification('class_posted', 'institution'),
          screen: '/(gym)/(tabs)/classes',
        },
      }),
    );
  }

  await Promise.all(tasks);
}

async function notifyClassEnded({ bookingId, athleteUserId, instructorUserId, classId, classTitle, startAt }) {
  const when = copy.formatWhen(startAt);
  const athleteCopy = copy.classEndedAthlete({ title: classTitle, when });
  const instructorCopy = copy.classEndedInstructor({ title: classTitle, when });

  await Promise.all([
    dispatchPush({
      userId: athleteUserId,
      type: 'class_ended',
      title: athleteCopy.title,
      body: athleteCopy.body,
      bookingId,
      data: {
        bookingId,
        classId,
        tab: tabForNotification('class_ended', 'athlete'),
        screen: '/(athlete)/(tabs)/bookings',
      },
    }),
    dispatchPush({
      userId: instructorUserId,
      type: 'class_ended',
      title: instructorCopy.title,
      body: instructorCopy.body,
      bookingId,
      data: {
        bookingId,
        classId,
        tab: tabForNotification('class_ended', 'instructor'),
        screen: '/(instructor)/(tabs)/calendar',
      },
    }),
  ]);
}

async function notifyClassReminder({
  bookingId,
  athleteUserId,
  classId,
  classTitle,
  startAt,
  hoursBefore,
  minutesBefore,
}) {
  let type;
  let copyBlock;
  if (hoursBefore === 24) {
    type = 'class_reminder_24h';
    copyBlock = copy.classReminder24h({ title: classTitle, when: startAt });
  } else if (hoursBefore === 1) {
    type = 'class_reminder_1h';
    copyBlock = copy.classReminder1h({ title: classTitle, when: startAt });
  } else {
    type = 'class_reminder_10m';
    copyBlock = copy.classReminder10m({ title: classTitle });
  }

  return dispatchPush({
    userId: athleteUserId,
    type,
    title: copyBlock.title,
    body: copyBlock.body,
    bookingId,
    data: {
      bookingId,
      classId,
      tab: tabForNotification(type, 'athlete'),
      screen: classId ? `/class/${classId}` : '/(athlete)/(tabs)/bookings',
    },
  });
}

async function notifyInstructorInvite({ inviteId, email, institutionName }) {
  const { rows } = await query(
    `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
    [email.toLowerCase()],
  );
  if (!rows.length) return { sent: false, reason: 'user_not_registered' };

  return dispatchPush({
    userId: rows[0].id,
    type: 'instructor_invite',
    title: 'Invitación de gimnasio',
    body: `${institutionName} te invitó a unirte al staff`,
    inviteId,
    data: {
      inviteId,
      screen: '/(instructor)/(tabs)/dashboard',
    },
  });
}

async function notifyReviewInvite({ bookingId, athleteUserId, classId, classTitle }) {
  const { title, body } = copy.reviewInvite({ title: classTitle });
  return dispatchPush({
    userId: athleteUserId,
    type: 'review_invite',
    title,
    body,
    bookingId,
    data: {
      bookingId,
      classId,
      tab: tabForNotification('review_invite', 'athlete'),
      screen: `/review/${bookingId}`,
    },
  });
}

async function findUserIdByEmail(email) {
  const { rows } = await query(
    `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
    [email.toLowerCase()],
  );
  return rows[0]?.id || null;
}

async function notifyMembershipInvite({ email, institutionName, inviteCode }) {
  const userId = await findUserIdByEmail(email);
  if (!userId) return { sent: false, reason: 'user_not_registered' };
  return dispatchPush({
    userId,
    type: 'membership_invite',
    title: 'Invitación de club',
    body: `${institutionName} te invitó como socio. Código: ${inviteCode}`,
    data: { screen: '/membership/join', inviteCode },
    skipDedupe: true,
  });
}

async function notifyMembershipDueReminder({ userId, memberId, institutionName, dueDate }) {
  const when = dueDate
    ? new Date(dueDate).toLocaleDateString('es-UY', { dateStyle: 'medium' })
    : 'pronto';
  return dispatchPush({
    userId,
    type: 'membership_due_reminder',
    title: 'Cuota próxima a vencer',
    body: `${institutionName} — vence el ${when}`,
    memberId,
    dueDate,
    data: { memberId, screen: `/membership/${memberId}` },
  });
}

async function notifyMembershipPaymentConfirmed({ userId, memberId, institutionName }) {
  return dispatchPush({
    userId,
    type: 'membership_payment_confirmed',
    title: 'Cuota confirmada',
    body: `Pago registrado en ${institutionName}`,
    memberId,
    data: { memberId, screen: `/membership/${memberId}` },
  });
}

async function notifyMembershipPaymentFailed({ userId, memberId, institutionName }) {
  return dispatchPush({
    userId,
    type: 'membership_payment_failed',
    title: 'Problema con tu cuota',
    body: `No pudimos cobrar la cuota en ${institutionName}. Regularizá desde la app.`,
    memberId,
    data: { memberId, screen: `/membership/${memberId}` },
  });
}

async function notifyMembershipOverdue({ userId, memberId, institutionName }) {
  return dispatchPush({
    userId,
    type: 'membership_overdue',
    title: 'Cuota vencida',
    body: `Tu membresía en ${institutionName} está en mora`,
    memberId,
    data: { memberId, screen: `/membership/${memberId}` },
  });
}

async function notifyClubArrearsAlert({ userId, overdueCount, institutionName }) {
  return dispatchPush({
    userId,
    type: 'club_arrears_alert',
    title: 'Socios en mora',
    body: `${overdueCount} socio(s) con cuota vencida en ${institutionName}`,
    data: { screen: '/(gym)/(tabs)/members' },
    skipDedupe: false,
  });
}

async function notifyVerificationApproved({ userId, displayName }) {
  const { title, body } = copy.verificationApproved({ displayName });
  return dispatchPush({
    userId,
    type: 'verification_approved',
    title,
    body,
    data: { tab: 'profile', screen: '/profile/verify' },
  });
}

async function notifyVerificationRejected({ userId, displayName, reason }) {
  const preview = reason.length > 80 ? `${reason.slice(0, 77)}…` : reason;
  const { title, body } = copy.verificationRejected({ displayName, preview });
  return dispatchPush({
    userId,
    type: 'verification_rejected',
    title,
    body,
    data: { tab: 'profile', screen: '/profile/verify' },
  });
}

async function listBookedAthletesForClass(classId) {
  const { rows } = await query(
    `SELECT DISTINCT b.athlete_user_id, u.email, ap.first_name, ap.last_name
     FROM bookings b
     JOIN users u ON u.id = b.athlete_user_id
     LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
     WHERE b.class_id = $1 AND b.status IN ('pending_payment', 'confirmed')`,
    [classId],
  );
  return rows;
}

async function listBookedAthletesForSeries(seriesId) {
  const { rows } = await query(
    `SELECT DISTINCT b.athlete_user_id, u.email, ap.first_name, ap.last_name
     FROM bookings b
     JOIN classes c ON c.id = b.class_id
     JOIN users u ON u.id = b.athlete_user_id
     LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
     WHERE c.series_id = $1
       AND c.start_at > now()
       AND b.status IN ('pending_payment', 'confirmed')`,
    [seriesId],
  );
  return rows;
}

async function getClassNotificationContext(classId) {
  const { rows } = await query(
    `SELECT c.id, c.title, c.start_at, c.series_id FROM classes c WHERE c.id = $1`,
    [classId],
  );
  return rows[0] || null;
}

async function notifyClassInstanceCancelled(classId) {
  const ctx = await getClassNotificationContext(classId);
  if (!ctx) return;

  const athletes = await listBookedAthletesForClass(classId);
  const emailService = require('./email.service');

  await Promise.all(
    athletes.map(async (athlete) => {
      const when = copy.formatWhen(ctx.start_at);
      const { title, body } = copy.classCancelled({ title: ctx.title, when });
      await dispatchPush({
        userId: athlete.athlete_user_id,
        type: 'class_cancelled_by_instructor',
        title,
        body,
        data: {
          classId,
          tab: tabForNotification('class_cancelled_by_instructor', 'athlete'),
          screen: '/(athlete)/(tabs)/bookings',
        },
      });
      if (athlete.email && emailService.isEmailEnabled()) {
        await emailService.sendClassCancelledEmail({
          to: athlete.email,
          athleteName: [athlete.first_name, athlete.last_name].filter(Boolean).join(' ') || 'Atleta',
          classTitle: ctx.title,
          when,
        });
      }
    }),
  );
}

async function notifyClassInstanceUpdated(classId) {
  const ctx = await getClassNotificationContext(classId);
  if (!ctx) return;

  const athletes = await listBookedAthletesForClass(classId);
  const emailService = require('./email.service');

  await Promise.all(
    athletes.map(async (athlete) => {
      const when = copy.formatWhen(ctx.start_at);
      const { title, body } = copy.classUpdated({ title: ctx.title, when });
      await dispatchPush({
        userId: athlete.athlete_user_id,
        type: 'class_updated_by_instructor',
        title,
        body,
        data: {
          classId,
          tab: tabForNotification('class_updated_by_instructor', 'athlete'),
          screen: `/class/${classId}`,
        },
      });
      if (athlete.email && emailService.isEmailEnabled()) {
        await emailService.sendClassUpdatedEmail({
          to: athlete.email,
          athleteName: [athlete.first_name, athlete.last_name].filter(Boolean).join(' ') || 'Atleta',
          classTitle: ctx.title,
          when,
        });
      }
    }),
  );
}

async function notifySeriesPaused(seriesId) {
  const { rows } = await query(`SELECT title FROM class_series WHERE id = $1`, [seriesId]);
  const title = rows[0]?.title || 'Serie de clases';
  const athletes = await listBookedAthletesForSeries(seriesId);
  const emailService = require('./email.service');

  await Promise.all(
    athletes.map(async (athlete) => {
      await dispatchPush({
        userId: athlete.athlete_user_id,
        type: 'series_paused',
        title: 'Serie pausada',
        body: `La serie "${title}" fue pausada. Tus reservas confirmadas siguen vigentes.`,
        data: { seriesId, screen: '/(athlete)/(tabs)/bookings' },
      });
      if (athlete.email && emailService.isEmailEnabled()) {
        await emailService.sendSeriesPausedEmail({
          to: athlete.email,
          athleteName: [athlete.first_name, athlete.last_name].filter(Boolean).join(' ') || 'Atleta',
          seriesTitle: title,
        });
      }
    }),
  );
}

async function notifySeriesDeleted(seriesId) {
  const { rows } = await query(`SELECT title FROM class_series WHERE id = $1`, [seriesId]);
  const title = rows[0]?.title || 'Serie de clases';
  const athletes = await listBookedAthletesForSeries(seriesId);
  const emailService = require('./email.service');

  await Promise.all(
    athletes.map(async (athlete) => {
      await dispatchPush({
        userId: athlete.athlete_user_id,
        type: 'series_deleted',
        title: 'Serie eliminada',
        body: `La serie "${title}" fue eliminada. Revisá tus reservas futuras.`,
        data: { seriesId, screen: '/(athlete)/(tabs)/bookings' },
      });
      if (athlete.email && emailService.isEmailEnabled()) {
        await emailService.sendSeriesDeletedEmail({
          to: athlete.email,
          athleteName: [athlete.first_name, athlete.last_name].filter(Boolean).join(' ') || 'Atleta',
          seriesTitle: title,
        });
      }
    }),
  );
}

module.exports = {
  dispatchPush,
  notifyPasswordReset,
  notifyBookingConfirmed,
  notifyPaymentConfirmed,
  notifyClassPosted,
  notifyClassEnded,
  notifyClassReminder,
  notifyInstructorInvite,
  notifyReviewInvite,
  notifyMembershipInvite,
  notifyMembershipDueReminder,
  notifyMembershipPaymentConfirmed,
  notifyMembershipPaymentFailed,
  notifyMembershipOverdue,
  notifyClubArrearsAlert,
  notifyVerificationApproved,
  notifyVerificationRejected,
  notifyClassInstanceCancelled,
  notifyClassInstanceUpdated,
  notifySeriesPaused,
  notifySeriesDeleted,
  findUserIdByEmail,
  formatClassWhen,
};
