const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const { query } = require('../db/pool');
const { notFound, forbidden, badRequest } = require('../utils/errors');
const {
  livekitUrl,
  livekitApiKey,
  livekitApiSecret,
  livekitConfigured,
} = require('../config/env');
const { getClassRow, assertCanManageClass } = require('./classes.service');
const { getInstructorByUserId } = require('./instructors.service');

const JOIN_WINDOW_BEFORE_MS = 15 * 60 * 1000;
const JOIN_WINDOW_AFTER_MS = 30 * 60 * 1000;
const TOKEN_TTL_SECONDS = 60 * 60 * 4;

function assertLiveKitConfigured() {
  if (!livekitConfigured) {
    throw badRequest(
      'Live streaming is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.',
    );
  }
}

function roomNameForClass(classId) {
  return `class-${classId}`;
}

function getRoomService() {
  assertLiveKitConfigured();
  return new RoomServiceClient(livekitUrl, livekitApiKey, livekitApiSecret);
}

function serializeStream(row, extras = {}) {
  return {
    id: row.id,
    classId: row.class_id,
    roomName: row.room_name,
    status: row.status,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    hostUserId: row.host_user_id || undefined,
    ...extras,
  };
}

function isWithinJoinWindow(classRow) {
  const start = new Date(classRow.start_at).getTime();
  const end =
    start + (classRow.duration_minutes || 60) * 60 * 1000 + JOIN_WINDOW_AFTER_MS;
  const now = Date.now();
  return now >= start - JOIN_WINDOW_BEFORE_MS && now <= end;
}

async function ensureStreamRow(classRow) {
  const roomName = roomNameForClass(classRow.id);
  const { rows } = await query(
    `INSERT INTO class_streams (class_id, room_name, status)
     VALUES ($1, $2, 'scheduled')
     ON CONFLICT (class_id) DO UPDATE SET updated_at = class_streams.updated_at
     RETURNING *`,
    [classRow.id, roomName],
  );
  return rows[0];
}

async function getAthleteDisplayName(userId) {
  const { rows } = await query(
    `SELECT first_name, last_name FROM athlete_profiles WHERE user_id = $1`,
    [userId],
  );
  if (!rows.length) return 'Atleta';
  return `${rows[0].first_name} ${rows[0].last_name}`.trim();
}

async function resolveParticipantAccess(user, classRow) {
  if (user.role === 'instructor' || user.role === 'institution') {
    try {
      await assertCanManageClass(user, classRow);
      return { role: 'host', canPublish: true };
    } catch {
      /* fall through */
    }
  }

  if (user.role === 'athlete') {
    const { rows } = await query(
      `SELECT id FROM bookings
       WHERE class_id = $1 AND athlete_user_id = $2 AND status = 'confirmed'`,
      [classRow.id, user.id],
    );
    if (!rows.length) {
      throw forbidden('You need a confirmed booking to join this live class');
    }
    return { role: 'participant', canPublish: false };
  }

  throw forbidden('You cannot join this live class');
}

async function createToken({ identity, name, roomName, canPublish, metadata }) {
  assertLiveKitConfigured();
  const at = new AccessToken(livekitApiKey, livekitApiSecret, {
    identity,
    name,
    ttl: TOKEN_TTL_SECONDS,
    metadata: metadata ? JSON.stringify(metadata) : undefined,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
  });
  return await at.toJwt();
}

async function getStreamStatus(user, classId) {
  const classRow = await getClassRow(classId);
  if (classRow.modality !== 'online') {
    throw badRequest('This class is not an online class');
  }

  const stream = await ensureStreamRow(classRow);
  let access = null;
  try {
    access = await resolveParticipantAccess(user, classRow);
  } catch {
    access = null;
  }

  const withinWindow = isWithinJoinWindow(classRow);
  const canJoin =
    Boolean(access) &&
    withinWindow &&
    stream.status !== 'cancelled' &&
    stream.status !== 'ended' &&
    livekitConfigured;

  return {
    ...serializeStream(stream),
    livekitConfigured,
    withinJoinWindow: withinWindow,
    canJoin,
    role: access?.role || null,
    classTitle: classRow.title,
    classStartAt: classRow.start_at.toISOString(),
    classDurationMinutes: classRow.duration_minutes,
  };
}

async function joinStream(user, classId) {
  assertLiveKitConfigured();
  const classRow = await getClassRow(classId);
  if (classRow.modality !== 'online') {
    throw badRequest('This class is not an online class');
  }
  if (classRow.cancelled_at) {
    throw badRequest('This class was cancelled');
  }

  const access = await resolveParticipantAccess(user, classRow);
  if (!isWithinJoinWindow(classRow)) {
    throw badRequest(
      'Live room opens 15 minutes before the class and closes shortly after it ends',
    );
  }

  let stream = await ensureStreamRow(classRow);
  if (stream.status === 'cancelled' || stream.status === 'ended') {
    throw badRequest('This live session has ended');
  }

  const roomService = getRoomService();
  try {
    await roomService.createRoom({
      name: stream.room_name,
      emptyTimeout: 60 * 30,
      maxParticipants: Math.max(classRow.capacity || 20, 20) + 5,
      metadata: JSON.stringify({
        classId: classRow.id,
        title: classRow.title,
      }),
    });
  } catch (err) {
    // Room may already exist — that's fine
    if (!String(err?.message || err).toLowerCase().includes('already')) {
      console.warn('[live] createRoom:', err.message || err);
    }
  }

  if (access.role === 'host' && stream.status === 'scheduled') {
    const { rows } = await query(
      `UPDATE class_streams
       SET status = 'live',
           started_at = COALESCE(started_at, now()),
           host_user_id = $2,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [stream.id, user.id],
    );
    stream = rows[0];

    notifyStreamStarted(classRow, stream).catch((e) =>
      console.warn('[live] notify start failed:', e.message),
    );
  }

  let displayName = user.email;
  if (user.role === 'athlete') {
    displayName = await getAthleteDisplayName(user.id);
  } else if (user.role === 'instructor') {
    try {
      const instructor = await getInstructorByUserId(user.id);
      displayName = instructor.display_name || displayName;
    } catch {
      /* keep email */
    }
  } else if (user.role === 'institution') {
    displayName = 'Host del club';
  }

  const token = await createToken({
    identity: user.id,
    name: displayName,
    roomName: stream.room_name,
    canPublish: access.canPublish,
    metadata: { role: access.role, classId },
  });

  await query(
    `INSERT INTO class_stream_participants (stream_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (stream_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, left_at = NULL, joined_at = now()`,
    [stream.id, user.id, access.role],
  );

  return {
    ...serializeStream(stream),
    token,
    url: livekitUrl,
    role: access.role,
    canPublish: access.canPublish,
    identity: user.id,
    displayName,
    classTitle: classRow.title,
  };
}

async function endStream(user, classId) {
  const classRow = await getClassRow(classId);
  await assertCanManageClass(user, classRow);

  const { rows } = await query(`SELECT * FROM class_streams WHERE class_id = $1`, [classId]);
  if (!rows.length) throw notFound('Stream not found');
  const stream = rows[0];

  if (livekitConfigured) {
    try {
      const roomService = getRoomService();
      await roomService.deleteRoom(stream.room_name);
    } catch (err) {
      console.warn('[live] deleteRoom:', err.message || err);
    }
  }

  const { rows: updated } = await query(
    `UPDATE class_streams
     SET status = 'ended', ended_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [stream.id],
  );

  return serializeStream(updated[0]);
}

async function leaveStream(user, classId) {
  const { rows } = await query(
    `UPDATE class_stream_participants p
     SET left_at = now()
     FROM class_streams s
     WHERE p.stream_id = s.id
       AND s.class_id = $1
       AND p.user_id = $2
       AND p.left_at IS NULL
     RETURNING p.id`,
    [classId, user.id],
  );
  return { left: rows.length > 0 };
}

async function notifyStreamStarted(classRow, stream) {
  const notificationsService = require('./notifications.service');
  const { rows } = await query(
    `SELECT athlete_user_id FROM bookings
     WHERE class_id = $1 AND status = 'confirmed'`,
    [classRow.id],
  );
  for (const row of rows) {
    await notificationsService.notifyLiveClassStarted({
      userId: row.athlete_user_id,
      classId: classRow.id,
      classTitle: classRow.title,
      streamId: stream.id,
    });
  }
}

function isLiveStreamingEnabled() {
  return livekitConfigured;
}

module.exports = {
  getStreamStatus,
  joinStream,
  endStream,
  leaveStream,
  isLiveStreamingEnabled,
  ensureStreamRow,
  isWithinJoinWindow,
};
