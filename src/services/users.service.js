const { query } = require('../db/pool');
const { badRequest, notFound, forbidden, conflict } = require('../utils/errors');
const { validateAthleteProfile, validateUserAccountUpdate } = require('../utils/validation');
const { serializeAthleteProfile, serializeUser } = require('../utils/serializers');
const { verifyPassword, hashPassword } = require('../utils/password');

async function updateUserAccount(userId, updates) {
  const { email, currentPassword, newPassword } = validateUserAccountUpdate(updates);

  const { rows: current } = await query(
    `SELECT id, email, role, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!current.length) throw notFound('User not found');

  let nextEmail = current[0].email;
  let emailChanged = false;

  if (email !== undefined) {
    if (current[0].email.toLowerCase() !== email) {
      const { rows: taken } = await query(
        `SELECT id FROM users WHERE email = $1 AND id != $2 AND deleted_at IS NULL`,
        [email, userId],
      );
      if (taken.length) {
        throw conflict('EMAIL_EXISTS', 'Email already registered');
      }
      nextEmail = email;
      emailChanged = true;
    }
  }

  let passwordHash = current[0].password_hash;

  if (newPassword !== undefined) {
    if (!current[0].password_hash) {
      throw badRequest('Password cannot be changed for this account');
    }
    const valid = await verifyPassword(currentPassword, current[0].password_hash);
    if (!valid) {
      throw forbidden('Current password is incorrect');
    }
    passwordHash = await hashPassword(newPassword);
  }

  if (!emailChanged && newPassword === undefined) {
    return serializeUser(current[0]);
  }

  const { rows } = await query(
    `UPDATE users
     SET email = $1,
         password_hash = $2,
         email_verified = CASE WHEN $3 THEN FALSE ELSE email_verified END,
         updated_at = now()
     WHERE id = $4 AND deleted_at IS NULL
     RETURNING id, email, role`,
    [nextEmail, passwordHash, emailChanged, userId],
  );

  if (newPassword !== undefined) {
    await query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  return serializeUser(rows[0]);
}

async function getAthleteProfile(userId) {
  const { rows } = await query(`SELECT * FROM athlete_profiles WHERE user_id = $1`, [userId]);
  if (!rows.length) throw notFound('Athlete profile not found');
  return serializeAthleteProfile(rows[0]);
}

async function updateAthleteProfile(userId, updates) {
  const validated = validateAthleteProfile(updates);
  const allowed = ['firstName', 'lastName', 'photoUrl', 'favoriteSports', 'locale'];
  const map = {
    firstName: 'first_name',
    lastName: 'last_name',
    photoUrl: 'photo_url',
    favoriteSports: 'favorite_sports',
    locale: 'locale',
  };

  const sets = [];
  const values = [];
  let i = 1;

  for (const key of allowed) {
    if (validated[key] !== undefined) {
      sets.push(`${map[key]} = $${i++}`);
      values.push(validated[key]);
    }
  }

  if (!sets.length) {
    throw badRequest('No valid fields to update');
  }

  values.push(userId);
  await query(
    `UPDATE athlete_profiles SET ${sets.join(', ')} WHERE user_id = $${i}`,
    values,
  );

  return getAthleteProfile(userId);
}

async function getNotificationPreferences(userId) {
  const { rows } = await query(
    `SELECT * FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  if (!rows.length) throw notFound('Preferences not found');
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

async function updateNotificationPreferences(userId, updates) {
  const map = {
    bookingConfirmed: 'booking_confirmed',
    classReminders: 'class_reminders',
    paymentUpdates: 'payment_updates',
    creditsExpiring: 'credits_expiring',
    reviewInvites: 'review_invites',
    marketing: 'marketing',
  };

  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, col] of Object.entries(map)) {
    if (updates[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(updates[key]);
    }
  }

  if (!sets.length) {
    return getNotificationPreferences(userId);
  }

  values.push(userId);
  await query(
    `UPDATE notification_preferences SET ${sets.join(', ')} WHERE user_id = $${i}`,
    values,
  );

  return getNotificationPreferences(userId);
}

async function closeAccount(userId) {
  const { rows } = await query(
    `SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!rows.length) throw notFound('User not found');

  if (rows[0].role === 'admin') {
    const { rows: adminCount } = await query(
      `SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND deleted_at IS NULL`,
    );
    if (adminCount[0].c <= 1) {
      throw forbidden('Cannot delete the last admin account');
    }
  }

  const { purgeUserRelatedData } = require('./user-purge.service');
  const { pool } = require('../db/pool');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await purgeUserRelatedData(client, userId);
    await client.query(`UPDATE users SET deleted_at = now(), updated_at = now() WHERE id = $1`, [
      userId,
    ]);
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { id: userId, status: 'deleted' };
}

module.exports = {
  updateUserAccount,
  getAthleteProfile,
  updateAthleteProfile,
  getNotificationPreferences,
  updateNotificationPreferences,
  closeAccount,
};
