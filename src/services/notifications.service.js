const { query } = require('../db/pool');
const { sendPushToTokens } = require('./push.service');
const { listDeviceTokens, deleteTokens } = require('./notifications-devices.service');

const PREF_BY_TYPE = {
  password_reset: null,
  booking_confirmed: 'bookingConfirmed',
  payment_confirmed: 'paymentUpdates',
  class_reminder_24h: 'classReminders',
  class_reminder_1h: 'classReminders',
  instructor_invite: null,
  review_invite: 'reviewInvites',
};

function buildDedupeKey(userId, type, { bookingId, inviteId } = {}) {
  return [userId, type, bookingId || '-', inviteId || '-'].join(':');
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

async function claimDelivery(userId, type, dedupeKey, { bookingId = null, inviteId = null } = {}) {
  try {
    await query(
      `INSERT INTO notification_deliveries (user_id, booking_id, invite_id, type, channel, dedupe_key)
       VALUES ($1, $2, $3, $4, 'push', $5)`,
      [userId, bookingId, inviteId, type, dedupeKey],
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
  skipDedupe = false,
}) {
  try {
    const prefs = await getPreferences(userId);
    if (!shouldSend(type, prefs)) {
      return { sent: false, reason: 'pref_disabled' };
    }

    const dedupeKey = buildDedupeKey(userId, type, { bookingId, inviteId });
    if (!skipDedupe) {
      const claimed = await claimDelivery(userId, type, dedupeKey, { bookingId, inviteId });
      if (!claimed) return { sent: false, reason: 'duplicate' };
    }

    const tokens = await listDeviceTokens(userId);
    if (!tokens.length) {
      return { sent: false, reason: 'no_devices' };
    }

    const payload = { type, ...data };
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
            i.user_id AS instructor_user_id
     FROM bookings b
     JOIN classes c ON c.id = b.class_id
     JOIN instructors i ON i.id = c.instructor_id
     WHERE b.id = $1`,
    [bookingId],
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

  const when = formatClassWhen(ctx.start_at);
  const athleteBody = `${ctx.class_title}${when ? ` — ${when}` : ''}`;
  const instructorBody = `Un atleta reservó: ${athleteBody}`;

  const tasks = [];
  if (!skipAthlete) {
    tasks.push(
      dispatchPush({
        userId: ctx.athlete_user_id,
        type: 'booking_confirmed',
        title: 'Reserva confirmada',
        body: athleteBody,
        bookingId,
        data: {
          bookingId,
          classId: ctx.class_id,
          screen: '/(athlete)/(tabs)/bookings',
        },
      }),
    );
  }

  tasks.push(
    dispatchPush({
      userId: ctx.instructor_user_id,
      type: 'booking_confirmed',
      title: 'Nueva reserva',
      body: instructorBody,
      bookingId,
      data: {
        bookingId,
        classId: ctx.class_id,
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
  const body = `${ctx.class_title} — ${amount} ${ctx.price_currency || 'UYU'}`;

  await dispatchPush({
    userId: ctx.athlete_user_id,
    type: 'payment_confirmed',
    title: 'Pago confirmado',
    body,
    bookingId,
    data: {
      bookingId,
      classId: ctx.class_id,
      screen: '/(athlete)/(tabs)/bookings',
    },
  });
}

async function notifyClassReminder({ bookingId, athleteUserId, classId, classTitle, startAt, hoursBefore }) {
  const type = hoursBefore === 24 ? 'class_reminder_24h' : 'class_reminder_1h';
  const when = formatClassWhen(startAt);
  const title =
    hoursBefore === 24 ? 'Tu clase es mañana' : 'Tu clase empieza en 1 hora';
  const body = `${classTitle}${when ? ` — ${when}` : ''}`;

  return dispatchPush({
    userId: athleteUserId,
    type,
    title,
    body,
    bookingId,
    data: {
      bookingId,
      classId,
      screen: `/class/${classId}`,
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
  return dispatchPush({
    userId: athleteUserId,
    type: 'review_invite',
    title: '¿Cómo estuvo la clase?',
    body: `Dejá una reseña de ${classTitle}`,
    bookingId,
    data: {
      bookingId,
      classId,
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

module.exports = {
  dispatchPush,
  notifyPasswordReset,
  notifyBookingConfirmed,
  notifyPaymentConfirmed,
  notifyClassReminder,
  notifyInstructorInvite,
  notifyReviewInvite,
  findUserIdByEmail,
  formatClassWhen,
};
