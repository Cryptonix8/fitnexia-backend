const crypto = require('crypto');
const { query } = require('../db/pool');
const { hashPassword, verifyPassword } = require('../utils/password');
const {
  signAccessToken,
  signRefreshToken,
  hashToken,
  verifyRefreshToken,
} = require('../utils/jwt');
const { AppError, badRequest, conflict, unauthorized, notFound, forbidden } = require('../utils/errors');
const { validateRegister, validateLogin, validateResetPassword, validatePasswordField } = require('../utils/validation');
const { verifyGoogleIdToken, parseGoogleProfile } = require('../utils/google');
const { jwtAccessExpiresIn, appDeepLinkScheme, passwordResetExpiresMinutes, isDev, apiPublicUrl } = require('../config/env');
const { sendPasswordResetEmail } = require('./email.service');
const notificationsService = require('./notifications.service');
const {
  serializeUser,
  serializeAthleteProfile,
  serializeInstructorFull,
  serializeInstitutionFull,
} = require('../utils/serializers');

const VALID_OAUTH_ROLES = ['athlete', 'instructor', 'institution'];

const DEFAULT_SCHEDULE = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  enabled: weekday >= 1 && weekday <= 5,
  startTime: '09:00',
  endTime: '17:00',
}));

async function insertRoleProfile(client, userId, role, profile) {
  const {
    firstName,
    lastName,
    photoUrl = null,
    favoriteSports = [],
    disciplines = [],
    institutionName,
    gender = null,
  } = profile;

  if (role === 'athlete') {
    await client.query(
      `INSERT INTO athlete_profiles (user_id, first_name, last_name, photo_url, favorite_sports)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, firstName, lastName, photoUrl, favoriteSports],
    );
    return;
  }

  if (role === 'instructor') {
    const displayName = `${firstName} ${lastName}`.trim();
    const instructorResult = await client.query(
      `INSERT INTO instructors (user_id, display_name, photo_url, disciplines, gender)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, displayName, photoUrl, disciplines, gender],
    );

    for (const day of DEFAULT_SCHEDULE) {
      await client.query(
        `INSERT INTO instructor_schedule (instructor_id, weekday, enabled, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5)`,
        [instructorResult.rows[0].id, day.weekday, day.enabled, day.startTime, day.endTime],
      );
    }
    return;
  }

  if (role === 'institution') {
    await client.query(
      `INSERT INTO institutions (user_id, name, logo_url)
       VALUES ($1, $2, $3)`,
      [userId, institutionName, photoUrl],
    );
  }
}

async function createTokens(client, user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt],
  );

  return {
    user: serializeUser(user),
    accessToken,
    refreshToken,
    expiresIn: jwtAccessExpiresIn,
  };
}

/** Hard-delete a soft-deleted user so their email can be registered again. */
async function reclaimEmailIfSoftDeleted(client, email) {
  const { rows } = await client.query(
    `SELECT id FROM users WHERE email = $1 AND deleted_at IS NOT NULL`,
    [email],
  );
  if (!rows.length) return;

  const { purgeUserRelatedData } = require('./user-purge.service');
  await purgeUserRelatedData(client, rows[0].id);
  await client.query(`DELETE FROM users WHERE id = $1`, [rows[0].id]);
}

async function register(body) {
  const input = validateRegister(body);
  const {
    email,
    password,
    role,
    firstName,
    lastName,
    favoriteSports,
    disciplines,
    institutionName,
    photoUrl,
    gender,
  } = input;

  const passwordHash = await hashPassword(password);
  const client = await require('../db/pool').pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email],
    );
    if (existing.rows.length) {
      throw conflict('EMAIL_EXISTS', 'Email already registered');
    }

    await reclaimEmailIfSoftDeleted(client, email);

    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, email, role`,
      [email, passwordHash, role],
    );
    const user = userResult.rows[0];

    await client.query(
      `INSERT INTO notification_preferences (user_id) VALUES ($1)`,
      [user.id],
    );

    await insertRoleProfile(client, user.id, role, {
      firstName,
      lastName,
      photoUrl,
      favoriteSports,
      disciplines,
      institutionName,
      gender,
    });

    const tokens = await createTokens(client, user);
    await client.query('COMMIT');
    return tokens;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') {
      throw conflict(
        'EMAIL_RECLAIM_FAILED',
        'This email was used before and could not be freed for registration. Contact support.',
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

async function login(email, password) {
  const input = validateLogin({ email, password });

  const { rows } = await query(
    `SELECT id, email, role, password_hash FROM users
     WHERE email = $1 AND deleted_at IS NULL`,
    [input.email],
  );

  if (!rows.length) {
    throw unauthorized('Invalid email or password');
  }

  const user = rows[0];
  if (!user.password_hash) {
    throw unauthorized('This account uses Google Sign-In');
  }
  const valid = await verifyPassword(input.password, user.password_hash);
  if (!valid) {
    throw unauthorized('Invalid email or password');
  }

  const client = await require('../db/pool').pool.connect();
  try {
    await client.query('BEGIN');
    const tokens = await createTokens(client, user);
    await client.query('COMMIT');
    return tokens;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function googleOAuth(body) {
  const { idToken, role, institutionName } = body ?? {};
  if (!idToken || typeof idToken !== 'string') {
    throw badRequest('idToken is required');
  }

  const payload = await verifyGoogleIdToken(idToken);
  const googleProfile = parseGoogleProfile(payload);

  const { rows } = await query(
    `SELECT id, email, role FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [googleProfile.email],
  );

  const client = await require('../db/pool').pool.connect();

  try {
    await client.query('BEGIN');

    if (rows.length) {
      const tokens = await createTokens(client, rows[0]);
      await client.query('COMMIT');
      return { ...tokens, isNewUser: false };
    }

    if (!role || !VALID_OAUTH_ROLES.includes(role)) {
      throw new AppError(
        400,
        'NEEDS_ROLE',
        'Choose athlete, instructor, or gym profile type before signing up with Google',
      );
    }

    await reclaimEmailIfSoftDeleted(client, googleProfile.email);

    const resolvedInstitutionName =
      role === 'institution'
        ? institutionName?.trim() || `${googleProfile.firstName}'s Gym`
        : undefined;

    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, role, email_verified)
       VALUES ($1, NULL, $2, TRUE)
       RETURNING id, email, role`,
      [googleProfile.email, role],
    );
    const user = userResult.rows[0];

    await client.query(`INSERT INTO notification_preferences (user_id) VALUES ($1)`, [user.id]);

    await insertRoleProfile(client, user.id, role, {
      firstName: googleProfile.firstName,
      lastName: googleProfile.lastName,
      photoUrl: googleProfile.photoUrl,
      institutionName: resolvedInstitutionName,
    });

    const tokens = await createTokens(client, user);
    await client.query('COMMIT');
    return { ...tokens, isNewUser: true };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') {
      throw conflict(
        'EMAIL_RECLAIM_FAILED',
        'This email was used before and could not be freed for registration. Contact support.',
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

async function refresh(refreshToken) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw unauthorized('Invalid refresh token');
  }

  const tokenHash = hashToken(refreshToken);
  const { rows } = await query(
    `SELECT rt.id, rt.user_id, u.email, u.role
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()
       AND u.deleted_at IS NULL`,
    [tokenHash],
  );

  if (!rows.length) {
    throw unauthorized('Refresh token revoked or expired');
  }

  const user = {
    id: rows[0].user_id,
    email: rows[0].email,
    role: rows[0].role,
  };

  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [rows[0].id]);

  const client = await require('../db/pool').pool.connect();
  try {
    await client.query('BEGIN');
    const tokens = await createTokens(client, user);
    await client.query('COMMIT');
    return tokens;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function logout(refreshToken) {
  if (!refreshToken) return;
  const tokenHash = hashToken(refreshToken);
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [tokenHash]);
}

async function loadInstructorExtras(instructorId) {
  const [certs, schedule] = await Promise.all([
    query(
      `SELECT name, issuer, year FROM instructor_certifications WHERE instructor_id = $1 ORDER BY year DESC`,
      [instructorId],
    ),
    query(
      `SELECT weekday, enabled, to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time
       FROM instructor_schedule WHERE instructor_id = $1 ORDER BY weekday`,
      [instructorId],
    ),
  ]);

  return {
    certifications: certs.rows.map((c) => ({
      name: c.name,
      issuer: c.issuer,
      year: c.year,
    })),
    schedule: schedule.rows.map((s) => ({
      weekday: s.weekday,
      enabled: s.enabled,
      startTime: s.start_time,
      endTime: s.end_time,
    })),
  };
}

async function loadInstitutionExtras(institutionId) {
  const [gallery, instructors] = await Promise.all([
    query(
      `SELECT url FROM institution_gallery WHERE institution_id = $1 ORDER BY sort_order, id`,
      [institutionId],
    ),
    query(
      `SELECT i.id, i.display_name
       FROM institution_instructors ii
       JOIN instructors i ON i.id = ii.instructor_id
       WHERE ii.institution_id = $1 AND ii.status = 'active'
       ORDER BY i.display_name`,
      [institutionId],
    ),
  ]);

  return {
    gallery: gallery.rows.map((g) => g.url),
    instructors: instructors.rows.map((i) => ({
      id: i.id,
      displayName: i.display_name,
    })),
  };
}

async function getMe(userId) {
  const { rows } = await query(
    `SELECT id, email, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!rows.length) throw notFound('User not found');

  const user = rows[0];
  let profile;

  if (user.role === 'athlete') {
    const { rows: profiles } = await query(
      `SELECT * FROM athlete_profiles WHERE user_id = $1`,
      [userId],
    );
    profile = profiles.length ? serializeAthleteProfile(profiles[0]) : null;
  } else if (user.role === 'instructor') {
    const { rows: instructors } = await query(
      `SELECT * FROM instructors WHERE user_id = $1`,
      [userId],
    );
    if (instructors.length) {
      const extras = await loadInstructorExtras(instructors[0].id);
      profile = await serializeInstructorFull(
        instructors[0],
        extras.certifications,
        extras.schedule,
      );
    }
  } else if (user.role === 'institution') {
    const { rows: institutions } = await query(
      `SELECT * FROM institutions WHERE user_id = $1`,
      [userId],
    );
    if (institutions.length) {
      const extras = await loadInstitutionExtras(institutions[0].id);
      profile = await serializeInstitutionFull(
        institutions[0],
        extras.gallery,
        extras.instructors,
      );
    }
  }

  return { user: serializeUser(user), profile };
}

async function changePassword(userId, body) {
  const currentPassword = body?.currentPassword;
  const newPassword = body?.newPassword;

  if (!currentPassword || typeof currentPassword !== 'string') {
    throw badRequest('Current password is required');
  }

  const passwordError = validatePasswordField(newPassword);
  if (passwordError) {
    throw badRequest(passwordError.message);
  }

  const { rows } = await query(
    `SELECT id, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!rows.length) throw notFound('User not found');
  if (!rows[0].password_hash) {
    throw badRequest('Password cannot be changed for this account');
  }

  const valid = await verifyPassword(currentPassword, rows[0].password_hash);
  if (!valid) {
    throw forbidden('Current password is incorrect');
  }

  const passwordHash = await hashPassword(newPassword);
  await query(
    `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL`,
    [passwordHash, userId],
  );
  await query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );

  return { ok: true };
}

async function forgotPassword(email) {
  const normalized = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    throw badRequest('Email is required');
  }

  const { rows } = await query(
    `SELECT id, email, password_hash FROM users
     WHERE email = $1 AND deleted_at IS NULL`,
    [normalized],
  );

  if (!rows.length || !rows[0].password_hash) {
    return;
  }

  const user = rows[0];
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + passwordResetExpiresMinutes * 60 * 1000);

  await query(
    `UPDATE password_reset_tokens
     SET used_at = now()
     WHERE user_id = $1 AND used_at IS NULL`,
    [user.id],
  );

  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt],
  );

  const appResetUrl = `${appDeepLinkScheme}:///reset-password?token=${encodeURIComponent(rawToken)}`;
  const webResetUrl = `${apiPublicUrl}/v1/auth/reset-password/open?token=${encodeURIComponent(rawToken)}`;
  const emailResult = await sendPasswordResetEmail({
    to: user.email,
    webResetUrl,
    appResetUrl,
    expiresMinutes: passwordResetExpiresMinutes,
  });

  if (!emailResult.sent && isDev) {
    console.warn('[auth] Password reset email not sent — use these links for testing:');
    console.warn('Web:', webResetUrl);
    console.warn('App:', appResetUrl);
  }

  notificationsService
    .notifyPasswordReset(user.id)
    .catch((err) => console.warn('[auth] password reset push failed:', err.message));
}

async function resetPassword(token, password) {
  const input = validateResetPassword({ token, password });
  const tokenHash = hashToken(input.token);

  const { rows } = await query(
    `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at, u.password_hash
     FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE prt.token_hash = $1 AND u.deleted_at IS NULL`,
    [tokenHash],
  );

  if (!rows.length) {
    throw badRequest('Invalid or expired reset link');
  }

  const row = rows[0];
  if (row.used_at) {
    throw badRequest('This reset link was already used');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw badRequest('This reset link expired');
  }

  const passwordHash = await hashPassword(input.password);
  const client = await require('../db/pool').pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [passwordHash, row.user_id],
    );
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`,
      [row.id],
    );
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [row.user_id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  register,
  login,
  googleOAuth,
  refresh,
  logout,
  getMe,
  changePassword,
  forgotPassword,
  resetPassword,
  loadInstructorExtras,
  loadInstitutionExtras,
};
