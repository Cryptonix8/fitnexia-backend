const { query } = require('../db/pool');
const { getInstitutionByUserId } = require('./institutions.service');
const { getInstructorByUserId } = require('./instructors.service');

function periodToInterval(period) {
  if (period === 'day') return "interval '1 day'";
  if (period === 'month') return "interval '30 days'";
  return "interval '7 days'";
}

async function getInstitutionMetrics(userId, { period = 'week' } = {}) {
  const institution = await getInstitutionByUserId(userId);
  const interval = periodToInterval(period);

  const { rows: bookingStats } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE b.status IN ('confirmed', 'completed')) AS bookings,
       COALESCE(SUM(b.price_cents) FILTER (WHERE b.status IN ('confirmed', 'completed')), 0)::int AS revenue_cents
     FROM bookings b
     JOIN classes c ON c.id = b.class_id
     WHERE c.institution_id = $1
       AND b.created_at >= now() - ${interval}::interval`,
    [institution.id],
  );

  const { rows: occupancyRows } = await query(
    `SELECT
       COALESCE(SUM(c.capacity), 0)::int AS total_capacity,
       COUNT(b.id)::int AS booked
     FROM classes c
     LEFT JOIN bookings b ON b.class_id = c.id AND b.status IN ('confirmed', 'completed')
     WHERE c.institution_id = $1
       AND c.cancelled_at IS NULL
       AND c.start_at >= now() - ${interval}::interval
       AND c.start_at <= now() + ${interval}::interval`,
    [institution.id],
  );

  const totalCapacity = Number(occupancyRows[0].total_capacity) || 0;
  const booked = Number(occupancyRows[0].booked) || 0;
  const occupancyRate = totalCapacity > 0 ? booked / totalCapacity : 0;

  const { rows: topClasses } = await query(
    `SELECT c.title, COUNT(b.id)::int AS bookings,
            COALESCE(SUM(b.price_cents), 0)::int AS revenue_cents,
            c.capacity
     FROM classes c
     LEFT JOIN bookings b ON b.class_id = c.id AND b.status IN ('confirmed', 'completed')
     WHERE c.institution_id = $1
       AND c.cancelled_at IS NULL
       AND c.start_at >= now() - ${interval}::interval
     GROUP BY c.id, c.title, c.capacity
     ORDER BY bookings DESC
     LIMIT 5`,
    [institution.id],
  );

  const { rows: instructorRows } = await query(
    `SELECT i.display_name, COUNT(b.id)::int AS bookings,
            COALESCE(SUM(b.price_cents), 0)::int AS revenue_cents
     FROM instructors i
     JOIN classes c ON c.instructor_id = i.id
     LEFT JOIN bookings b ON b.class_id = c.id AND b.status IN ('confirmed', 'completed')
     WHERE c.institution_id = $1
       AND c.start_at >= now() - ${interval}::interval
     GROUP BY i.id, i.display_name
     ORDER BY revenue_cents DESC
     LIMIT 5`,
    [institution.id],
  );

  const { rows: dailyRows } = await query(
    `SELECT DATE(b.created_at) AS day,
            COUNT(*)::int AS bookings,
            COALESCE(SUM(b.price_cents), 0)::int AS revenue_cents
     FROM bookings b
     JOIN classes c ON c.id = b.class_id
     WHERE c.institution_id = $1
       AND b.status IN ('confirmed', 'completed')
       AND b.created_at >= now() - ${interval}::interval
     GROUP BY DATE(b.created_at)
     ORDER BY day ASC`,
    [institution.id],
  );

  const { rows: retentionRows } = await query(
    `WITH period_bookings AS (
       SELECT DISTINCT b.athlete_user_id
       FROM bookings b
       JOIN classes c ON c.id = b.class_id
       WHERE c.institution_id = $1
         AND b.status IN ('confirmed', 'completed')
         AND b.created_at >= now() - ${interval}::interval
     ),
     prior_bookings AS (
       SELECT DISTINCT b.athlete_user_id
       FROM bookings b
       JOIN classes c ON c.id = b.class_id
       WHERE c.institution_id = $1
         AND b.status IN ('confirmed', 'completed')
         AND b.created_at < now() - ${interval}::interval
         AND b.created_at >= now() - (${interval}::interval * 2)
     )
     SELECT
       (SELECT COUNT(*) FROM period_bookings)::int AS current_athletes,
       (SELECT COUNT(*) FROM prior_bookings pb
        WHERE pb.athlete_user_id IN (SELECT athlete_user_id FROM period_bookings))::int AS returning_athletes`,
    [institution.id],
  );

  const currentAthletes = Number(retentionRows[0]?.current_athletes) || 0;
  const returningAthletes = Number(retentionRows[0]?.returning_athletes) || 0;
  const retentionRate = currentAthletes > 0 ? returningAthletes / currentAthletes : 0;

  return {
    period,
    bookings: Number(bookingStats[0].bookings),
    revenue: {
      amount: Number(bookingStats[0].revenue_cents),
      currency: 'UYU',
    },
    occupancyRate,
    retentionRate,
    daily: dailyRows.map((d) => ({
      date: d.day.toISOString().slice(0, 10),
      bookings: d.bookings,
      revenueCents: d.revenue_cents,
    })),
    topClasses: topClasses.map((c) => ({
      title: c.title,
      bookings: c.bookings,
      revenueCents: c.revenue_cents,
      occupancyRate: c.capacity ? c.bookings / c.capacity : 0,
    })),
    topInstructors: instructorRows.map((i) => ({
      name: i.display_name,
      bookings: i.bookings,
      revenueCents: i.revenue_cents,
    })),
  };
}

async function getInstructorMetrics(userId, { period = 'week' } = {}) {
  const instructor = await getInstructorByUserId(userId);
  const interval = periodToInterval(period);

  const { rows: bookingStats } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE b.status IN ('confirmed', 'completed')) AS bookings,
       COALESCE(SUM(b.price_cents) FILTER (WHERE b.status IN ('confirmed', 'completed')), 0)::int AS revenue_cents
     FROM bookings b
     JOIN classes c ON c.id = b.class_id
     WHERE c.instructor_id = $1
       AND b.created_at >= now() - ${interval}::interval`,
    [instructor.id],
  );

  const { rows: occupancyRows } = await query(
    `SELECT
       COALESCE(SUM(c.capacity), 0)::int AS total_capacity,
       COUNT(b.id)::int AS booked
     FROM classes c
     LEFT JOIN bookings b ON b.class_id = c.id AND b.status IN ('confirmed', 'completed')
     WHERE c.instructor_id = $1
       AND c.cancelled_at IS NULL
       AND c.start_at >= now() - ${interval}::interval`,
    [instructor.id],
  );

  const totalCapacity = Number(occupancyRows[0].total_capacity) || 0;
  const booked = Number(occupancyRows[0].booked) || 0;

  const { rows: topClasses } = await query(
    `SELECT c.title, COUNT(b.id)::int AS bookings,
            COALESCE(SUM(b.price_cents), 0)::int AS revenue_cents,
            c.capacity
     FROM classes c
     LEFT JOIN bookings b ON b.class_id = c.id AND b.status IN ('confirmed', 'completed')
     WHERE c.instructor_id = $1
       AND c.cancelled_at IS NULL
       AND c.start_at >= now() - ${interval}::interval
     GROUP BY c.id, c.title, c.capacity
     ORDER BY bookings DESC
     LIMIT 5`,
    [instructor.id],
  );

  return {
    period,
    bookings: Number(bookingStats[0].bookings),
    revenue: {
      amount: Number(bookingStats[0].revenue_cents),
      currency: 'UYU',
    },
    occupancyRate: totalCapacity > 0 ? booked / totalCapacity : 0,
    topClasses: topClasses.map((c) => ({
      title: c.title,
      bookings: c.bookings,
      revenueCents: c.revenue_cents,
      occupancyRate: c.capacity ? c.bookings / c.capacity : 0,
    })),
  };
}

module.exports = {
  getInstitutionMetrics,
  getInstructorMetrics,
};
