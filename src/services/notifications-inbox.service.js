const { query } = require('../db/pool');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

async function createInboxNotification({ userId, type, title, body, data = {} }) {
  const { rows } = await query(
    `INSERT INTO user_notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, type, title, body, read, created_at`,
    [userId, type, title, body || '', JSON.stringify(data)],
  );
  const n = rows[0];
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    read: n.read,
    createdAt: n.created_at.toISOString(),
  };
}

async function listNotifications(userId, queryParams = {}) {
  const { page, limit, offset } = parsePagination(queryParams);
  const unreadOnly = queryParams.unreadOnly === 'true' || queryParams.unreadOnly === true;

  const conditions = ['user_id = $1'];
  const values = [userId];
  if (unreadOnly) {
    conditions.push('read = FALSE');
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM user_notifications ${where}`,
    values,
  );
  const total = countResult.rows[0].total;

  values.push(limit, offset);
  const { rows } = await query(
    `SELECT id, type, title, body, data, read, created_at
     FROM user_notifications ${where}
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    values,
  );

  const data = rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    data: r.data || {},
    read: r.read,
    createdAt: r.created_at.toISOString(),
  }));

  return paginatedResponse(data, total, page, limit);
}

async function getUnreadCount(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS cnt FROM user_notifications WHERE user_id = $1 AND read = FALSE`,
    [userId],
  );
  return { unread: rows[0].cnt };
}

async function markRead(userId, notificationId) {
  await query(
    `UPDATE user_notifications SET read = TRUE, read_at = now()
     WHERE id = $1 AND user_id = $2`,
    [notificationId, userId],
  );
  return { ok: true };
}

async function markAllRead(userId) {
  await query(
    `UPDATE user_notifications SET read = TRUE, read_at = now()
     WHERE user_id = $1 AND read = FALSE`,
    [userId],
  );
  return { ok: true };
}

module.exports = {
  createInboxNotification,
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
};
