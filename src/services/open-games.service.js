const { query } = require('../db/pool');
const { notFound, forbidden, badRequest, conflict } = require('../utils/errors');
const notificationsService = require('./notifications.service');

const OPEN_GAME_SPORTS = ['padel', 'football_5', 'football_7', 'football_11'];

function countJoinedParticipants(gameId) {
  return query(
    `SELECT COUNT(*)::int AS count FROM open_game_participants
     WHERE game_id = $1 AND status = 'joined'`,
    [gameId],
  );
}

async function serializeGame(row, userId = null) {
  const { rows: countRows } = await countJoinedParticipants(row.id);
  const joinedCount = countRows[0]?.count ?? 0;
  const spotsLeft = Math.max(0, row.capacity - joinedCount);

  let myStatus = null;
  if (userId) {
    const { rows: partRows } = await query(
      `SELECT status FROM open_game_participants WHERE game_id = $1 AND user_id = $2`,
      [row.id, userId],
    );
    myStatus = partRows[0]?.status || null;
  }

  const { rows: participants } = await query(
    `SELECT p.user_id, p.joined_at, ap.first_name, ap.last_name, ap.photo_url
     FROM open_game_participants p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN athlete_profiles ap ON ap.user_id = p.user_id
     WHERE p.game_id = $1 AND p.status = 'joined'
     ORDER BY p.joined_at ASC`,
    [row.id],
  );

  return {
    id: row.id,
    creatorUserId: row.creator_user_id,
    sportType: row.sport_type,
    title: row.title,
    description: row.description,
    startAt: row.start_at.toISOString(),
    durationMinutes: row.duration_minutes,
    locationLabel: row.location_label,
    latitude: row.latitude ?? undefined,
    longitude: row.longitude ?? undefined,
    institutionId: row.institution_id || undefined,
    courtId: row.court_id || undefined,
    institutionName: row.institution_name || undefined,
    capacity: row.capacity,
    spotsLeft,
    joinedCount,
    level: row.level || undefined,
    status: row.status,
    isCreator: userId === row.creator_user_id,
    myStatus,
    participants: participants.map((p) => ({
      userId: p.user_id,
      firstName: p.first_name,
      lastName: p.last_name,
      avatarUri: p.photo_url || undefined,
      joinedAt: p.joined_at.toISOString(),
    })),
    createdAt: row.created_at.toISOString(),
  };
}

async function createGame(user, body) {
  if (user.role !== 'athlete') throw forbidden('Only athletes can create open games');

  const {
    sportType,
    title,
    description,
    startAt,
    durationMinutes = 90,
    locationLabel,
    latitude,
    longitude,
    institutionId,
    courtId,
    capacity,
    level,
  } = body;

  if (!sportType || !title || !startAt || !capacity) {
    throw badRequest('sportType, title, startAt, and capacity are required');
  }
  if (!OPEN_GAME_SPORTS.includes(sportType)) {
    throw badRequest(`sportType must be one of: ${OPEN_GAME_SPORTS.join(', ')}`);
  }
  if (capacity < 2) throw badRequest('capacity must be at least 2');
  if (new Date(startAt) <= new Date()) throw badRequest('startAt must be in the future');

  const { rows } = await query(
    `INSERT INTO open_games (
      creator_user_id, sport_type, title, description, start_at, duration_minutes,
      location_label, latitude, longitude, institution_id, court_id, capacity, level
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *`,
    [
      user.id,
      sportType,
      title.trim(),
      (description || '').trim(),
      startAt,
      durationMinutes,
      (locationLabel || '').trim(),
      latitude ?? null,
      longitude ?? null,
      institutionId || null,
      courtId || null,
      capacity,
      level || null,
    ],
  );

  await query(
    `INSERT INTO open_game_participants (game_id, user_id, status)
     VALUES ($1, $2, 'joined')
     ON CONFLICT (game_id, user_id) DO UPDATE SET status = 'joined', left_at = NULL`,
    [rows[0].id, user.id],
  );

  return serializeGame(rows[0], user.id);
}

async function listGames(user, queryParams = {}) {
  const { sportType, from, to } = queryParams;
  const params = [];
  const conditions = [`og.status = 'open'`, `og.start_at > now()`];

  if (sportType) {
    params.push(sportType);
    conditions.push(`og.sport_type = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`og.start_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`og.start_at <= $${params.length}`);
  }

  const { rows } = await query(
    `SELECT og.*, i.name AS institution_name
     FROM open_games og
     LEFT JOIN institutions i ON i.id = og.institution_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY og.start_at ASC
     LIMIT 100`,
    params,
  );

  const games = [];
  for (const row of rows) {
    games.push(await serializeGame(row, user?.id));
  }
  return games;
}

async function getGame(user, gameId) {
  const { rows } = await query(
    `SELECT og.*, i.name AS institution_name
     FROM open_games og
     LEFT JOIN institutions i ON i.id = og.institution_id
     WHERE og.id = $1`,
    [gameId],
  );
  if (!rows.length) throw notFound('Open game not found');
  return serializeGame(rows[0], user?.id);
}

async function joinGame(user, gameId) {
  if (user.role !== 'athlete') throw forbidden('Only athletes can join open games');

  const { rows } = await query(`SELECT * FROM open_games WHERE id = $1 FOR UPDATE`, [gameId]);
  if (!rows.length) throw notFound('Open game not found');
  const game = rows[0];
  if (game.status !== 'open') throw badRequest('This game is no longer open');
  if (new Date(game.start_at) <= new Date()) throw badRequest('This game has already started');

  const { rows: existing } = await query(
    `SELECT status FROM open_game_participants WHERE game_id = $1 AND user_id = $2`,
    [gameId, user.id],
  );
  if (existing[0]?.status === 'joined') {
    return getGame(user, gameId);
  }

  const { rows: countRows } = await countJoinedParticipants(gameId);
  if (countRows[0].count >= game.capacity) {
    throw conflict('GAME_FULL', 'This game is full');
  }

  await query(
    `INSERT INTO open_game_participants (game_id, user_id, status)
     VALUES ($1, $2, 'joined')
     ON CONFLICT (game_id, user_id)
     DO UPDATE SET status = 'joined', joined_at = now(), left_at = NULL`,
    [gameId, user.id],
  );

  const { rows: updatedCount } = await countJoinedParticipants(gameId);
  if (updatedCount[0].count >= game.capacity) {
    await query(`UPDATE open_games SET status = 'full', updated_at = now() WHERE id = $1`, [gameId]);
  }

  if (game.creator_user_id !== user.id) {
    const { rows: profileRows } = await query(
      `SELECT first_name, last_name FROM athlete_profiles WHERE user_id = $1`,
      [user.id],
    );
    const profile = profileRows[0];
    const playerName = profile
      ? `${profile.first_name} ${profile.last_name}`.trim()
      : 'Un jugador';
    await notificationsService.notifyOpenGamePlayerJoined({
      creatorUserId: game.creator_user_id,
      gameId,
      playerName,
      gameTitle: game.title,
    }).catch(() => {});
  }

  return getGame(user, gameId);
}

async function leaveGame(user, gameId) {
  const { rows } = await query(`SELECT * FROM open_games WHERE id = $1`, [gameId]);
  if (!rows.length) throw notFound('Open game not found');
  const game = rows[0];

  if (game.creator_user_id === user.id) {
    throw badRequest('Creator cannot leave — cancel the game instead');
  }

  const { rowCount } = await query(
    `UPDATE open_game_participants
     SET status = 'left', left_at = now()
     WHERE game_id = $1 AND user_id = $2 AND status = 'joined'`,
    [gameId, user.id],
  );
  if (!rowCount) throw badRequest('You are not in this game');

  if (game.status === 'full') {
    await query(`UPDATE open_games SET status = 'open', updated_at = now() WHERE id = $1`, [gameId]);
  }

  return getGame(user, gameId);
}

async function cancelGame(user, gameId) {
  const { rows } = await query(
    `UPDATE open_games
     SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND creator_user_id = $2 AND status IN ('open', 'full')
     RETURNING *`,
    [gameId, user.id],
  );
  if (!rows.length) throw notFound('Open game not found or cannot be cancelled');

  const { rows: participants } = await query(
    `SELECT user_id FROM open_game_participants
     WHERE game_id = $1 AND status = 'joined' AND user_id != $2`,
    [gameId, user.id],
  );
  for (const p of participants) {
    await notificationsService.notifyOpenGameCancelled({
      userId: p.user_id,
      gameId,
      gameTitle: rows[0].title,
    }).catch(() => {});
  }

  return serializeGame(rows[0], user.id);
}

async function listMyGames(user) {
  if (user.role !== 'athlete') throw forbidden('Only athletes can list their games');
  const { rows } = await query(
    `SELECT DISTINCT og.*, i.name AS institution_name
     FROM open_games og
     LEFT JOIN institutions i ON i.id = og.institution_id
     LEFT JOIN open_game_participants p ON p.game_id = og.id AND p.user_id = $1 AND p.status = 'joined'
     WHERE og.creator_user_id = $1 OR p.user_id IS NOT NULL
     ORDER BY og.start_at DESC
     LIMIT 100`,
    [user.id],
  );
  const games = [];
  for (const row of rows) {
    games.push(await serializeGame(row, user.id));
  }
  return games;
}

module.exports = {
  OPEN_GAME_SPORTS,
  createGame,
  listGames,
  listMyGames,
  getGame,
  joinGame,
  leaveGame,
  cancelGame,
};
