const { query } = require('../db/pool');
const { normalizeDiscipline, normalizeDisciplineList } = require('../config/disciplines');
const { normalizeLocationLabel } = require('../config/locations');

async function getBookingCount(classId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM bookings
     WHERE class_id = $1 AND status IN ('pending_payment', 'confirmed')`,
    [classId],
  );
  return rows[0].count;
}

function serializeMoney(cents, currency) {
  return { amount: cents, currency: currency || 'UYU' };
}

function serializeInstructor(row) {
  if (!row) return null;
  return {
    id: row.instructor_id || row.id,
    displayName: row.instructor_display_name || row.display_name,
    photoUrl: row.instructor_photo_url || row.photo_url || undefined,
  };
}

function serializeInstitution(row) {
  if (!row.institution_id && !row.id) return null;
  return {
    id: row.institution_id || row.id,
    name: row.institution_name || row.name,
  };
}

async function serializeClassRow(row, bookedCount) {
  const capacity = row.capacity ?? null;
  const booked = bookedCount ?? (await getBookingCount(row.id));
  const spotsLeft = capacity != null ? Math.max(0, capacity - booked) : undefined;

  const item = {
    id: row.id,
    title: row.title,
    discipline: normalizeDiscipline(row.discipline),
    modality: row.modality,
    startAt: row.start_at.toISOString(),
    durationMinutes: row.duration_minutes,
    price: serializeMoney(row.price_cents, row.price_currency),
    instructor: {
      id: row.instructor_id,
      displayName: row.instructor_display_name,
      photoUrl: row.instructor_photo_url || undefined,
      verified: row.instructor_verified === true,
    },
    classFormat: row.class_format,
  };

  if (capacity != null) {
    item.capacity = capacity;
    item.spotsLeft = spotsLeft;
  }

  if (row.institution_id) {
    item.institution = {
      id: row.institution_id,
      name: row.institution_name,
      logoUrl: row.institution_logo_url || undefined,
      verified: row.institution_verified === true,
    };
  }

  if (row.location_lat != null && row.location_lng != null) {
    item.location = {
      lat: row.location_lat,
      lng: row.location_lng,
      label: normalizeLocationLabel(row.location_label || ''),
    };
  }

  if (row.average_rating != null) {
    item.averageRating = Number(row.average_rating);
  }

  if (row.description != null) item.description = row.description;
  if (row.level) item.level = row.level;
  if (row.language) item.language = row.language;
  if (row.cancellation_policy_hours != null) {
    item.cancellationPolicyHours = row.cancellation_policy_hours;
  }
  if (row.recurrence) item.recurrence = row.recurrence;

  return item;
}

function serializeAthleteProfile(row) {
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    photoUrl: row.photo_url || undefined,
    favoriteSports: row.favorite_sports || [],
    locale: row.locale || 'es',
  };
}

async function serializeInstructorFull(row, certifications = [], schedule = []) {
  const result = {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    photoUrl: row.photo_url || undefined,
    bio: row.bio || '',
    disciplines: normalizeDisciplineList(row.disciplines || []),
    certifications,
    verified: row.verified,
    verificationStatus: row.verification_status || (row.verified ? 'verified' : 'unverified'),
    availableNow: row.available_now,
    averageRating: Number(row.average_rating),
    reviewCount: row.review_count,
    plan: row.plan,
  };

  if (row.hourly_rate_cents != null) {
    result.hourlyRate = serializeMoney(row.hourly_rate_cents, row.hourly_rate_currency);
  }

  if (schedule.length) {
    result.weeklySchedule = schedule;
  }

  return result;
}

async function serializeInstitutionFull(row, gallery = [], instructors = []) {
  const result = {
    id: row.id,
    name: row.name,
    logoUrl: row.logo_url || undefined,
    description: row.description || '',
    verified: row.verified,
    verificationStatus: row.verification_status || (row.verified ? 'verified' : 'unverified'),
    plan: row.plan,
    saasTier: row.saas_tier || 'basic',
    gallery,
    instructors,
    contactPhone: row.contact_phone || undefined,
    contactEmail: row.contact_email || undefined,
    website: row.website || undefined,
    openingHours: row.opening_hours || {},
  };

  if (row.address || row.city || row.country || row.lat != null) {
    result.location = {
      address: row.address || '',
      city: row.city || '',
      country: row.country || '',
      lat: row.lat,
      lng: row.lng,
    };
  }

  return result;
}

function serializeBooking(row, cls) {
  return {
    id: row.id,
    status: row.status,
    classId: row.class_id,
    userId: row.athlete_user_id,
    price: serializeMoney(row.price_cents, row.price_currency),
    createdAt: row.created_at.toISOString(),
    class: cls || undefined,
  };
}

function serializeUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
  };
}

module.exports = {
  serializeMoney,
  serializeClassRow,
  serializeAthleteProfile,
  serializeInstructorFull,
  serializeInstitutionFull,
  serializeBooking,
  serializeUser,
  getBookingCount,
};
