const { query } = require('../db/pool');
const { badRequest } = require('../utils/errors');

async function registerDevice(userId, { token, platform }) {
  const normalizedToken = String(token ?? '').trim();
  if (!normalizedToken) throw badRequest('token is required');
  if (!['ios', 'android', 'web'].includes(platform)) {
    throw badRequest('platform must be ios, android, or web');
  }

  await query(
    `INSERT INTO notification_devices (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform`,
    [userId, normalizedToken, platform],
  );
}

async function unregisterDevice(userId, token) {
  const normalizedToken = String(token ?? '').trim();
  if (!normalizedToken) throw badRequest('token is required');

  await query(`DELETE FROM notification_devices WHERE user_id = $1 AND token = $2`, [
    userId,
    normalizedToken,
  ]);
}

async function listDeviceTokens(userId) {
  const { rows } = await query(`SELECT token FROM notification_devices WHERE user_id = $1`, [
    userId,
  ]);
  return rows.map((row) => row.token);
}

async function deleteTokens(tokens) {
  if (!tokens.length) return;
  await query(`DELETE FROM notification_devices WHERE token = ANY($1::text[])`, [tokens]);
}

module.exports = {
  registerDevice,
  unregisterDevice,
  listDeviceTokens,
  deleteTokens,
};
