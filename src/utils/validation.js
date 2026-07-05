const { badRequest } = require('./errors');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_REGEX = /^[\p{L}\p{M}'\-\s.]{1,50}$/u;
const INSTITUTION_NAME_REGEX = /^[\p{L}\p{M}0-9'\-\s.&]{2,100}$/u;
const DISPLAY_NAME_REGEX = /^[\p{L}\p{M}0-9'\-\s.]{2,100}$/u;
const COUNTRY_REGEX = /^[A-Z]{2}$/;
const URL_REGEX = /^https?:\/\/.+/i;

const LIMITS = {
  email: 254,
  passwordMin: 8,
  passwordMax: 128,
  bio: 2000,
  description: 2000,
  address: 200,
  city: 100,
  hourlyRateMax: 10000,
  galleryMax: 20,
};

const VALID_ROLES = ['athlete', 'instructor', 'institution'];

const { DISCIPLINES } = require('../config/disciplines');

function trim(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function collectErrors(checks) {
  const errors = [];
  for (const check of checks) {
    const result = check();
    if (result) errors.push(result);
  }
  return errors;
}

function failIfErrors(errors, message = 'Validation failed') {
  if (errors.length) {
    throw badRequest(message, { errors });
  }
}

function validateEmailField(email, { required = true } = {}) {
  const value = trim(email);
  if (!value) {
    if (required) return { field: 'email', message: 'Email is required' };
    return null;
  }
  if (value.length > LIMITS.email) {
    return { field: 'email', message: 'Email is too long' };
  }
  if (!EMAIL_REGEX.test(value)) {
    return { field: 'email', message: 'Enter a valid email address' };
  }
  return null;
}

function validatePasswordField(password, { required = true } = {}) {
  if (password === undefined || password === null || password === '') {
    if (required) return { field: 'password', message: 'Password is required' };
    return null;
  }
  if (typeof password !== 'string') {
    return { field: 'password', message: 'Password must be a string' };
  }
  if (password.length < LIMITS.passwordMin) {
    return { field: 'password', message: `Password must be at least ${LIMITS.passwordMin} characters` };
  }
  if (password.length > LIMITS.passwordMax) {
    return { field: 'password', message: `Password must be at most ${LIMITS.passwordMax} characters` };
  }
  return null;
}

function validateNameField(name, field, { required = true } = {}) {
  const value = trim(name);
  if (!value) {
    if (required) return { field, message: `${field === 'firstName' ? 'First name' : 'Last name'} is required` };
    return null;
  }
  if (!NAME_REGEX.test(value)) {
    return {
      field,
      message: `${field === 'firstName' ? 'First name' : 'Last name'} must be 1–50 letters`,
    };
  }
  return null;
}

function validateInstitutionName(name, { required = false } = {}) {
  const value = trim(name);
  if (!value) {
    if (required) return { field: 'institutionName', message: 'Gym / school name is required' };
    return null;
  }
  if (!INSTITUTION_NAME_REGEX.test(value)) {
    return { field: 'institutionName', message: 'Gym / school name must be 2–100 characters' };
  }
  return null;
}

function validateDisplayName(name, { required = false } = {}) {
  const value = trim(name);
  if (!value) {
    if (required) return { field: 'displayName', message: 'Display name is required' };
    return null;
  }
  if (!DISPLAY_NAME_REGEX.test(value)) {
    return { field: 'displayName', message: 'Display name must be 2–100 characters' };
  }
  return null;
}

function validateOptionalUrl(url, field) {
  if (url === undefined || url === null || url === '') return null;
  if (typeof url !== 'string' || !URL_REGEX.test(url)) {
    return { field, message: 'Photo URL must be a valid http(s) address' };
  }
  return null;
}

function validateOptionalText(value, field, maxLen) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    return { field, message: `${field} must be a string` };
  }
  if (value.length > maxLen) {
    return { field, message: `${field} must be at most ${maxLen} characters` };
  }
  return null;
}

function validateCountry(country) {
  if (country === undefined || country === null || country === '') return null;
  const value = trim(country).toUpperCase();
  if (!COUNTRY_REGEX.test(value)) {
    return { field: 'country', message: 'Country must be a 2-letter code (e.g. AR)' };
  }
  return null;
}

function validateDisciplineList(list, field) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) {
    return { field, message: `${field} must be an array` };
  }
  const invalid = list.filter((item) => typeof item !== 'string' || !DISCIPLINES.includes(item));
  if (invalid.length) {
    return { field, message: `${field} contains invalid values` };
  }
  return null;
}

function validateHourlyRate(hourlyRate) {
  if (hourlyRate === undefined || hourlyRate === null || hourlyRate === '') return null;
  const amount = typeof hourlyRate === 'object' ? hourlyRate.amount : Number(hourlyRate);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { field: 'hourlyRate', message: 'Hourly rate must be a positive number' };
  }
  if (amount / 100 > LIMITS.hourlyRateMax) {
    return { field: 'hourlyRate', message: `Hourly rate must be at most ${LIMITS.hourlyRateMax}` };
  }
  return null;
}

function validateGallery(gallery) {
  if (gallery === undefined || gallery === null) return null;
  if (!Array.isArray(gallery)) {
    return { field: 'gallery', message: 'Gallery must be an array' };
  }
  if (gallery.length > LIMITS.galleryMax) {
    return { field: 'gallery', message: `Gallery can have at most ${LIMITS.galleryMax} photos` };
  }
  for (const url of gallery) {
    const err = validateOptionalUrl(url, 'gallery');
    if (err) return err;
  }
  return null;
}

function validateRegister(body) {
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
    acceptTerms = true,
    gender,
  } = body ?? {};

  const GENDER_VALUES = ['male', 'female', 'other', 'prefer_not_to_say'];

  const errors = collectErrors([
    () => validateEmailField(email),
    () => validatePasswordField(password),
    () => {
      if (!role) return { field: 'role', message: 'Role is required' };
      if (!VALID_ROLES.includes(role)) {
        return { field: 'role', message: 'Role must be athlete, instructor, or institution' };
      }
      return null;
    },
    () => (role === 'institution' ? null : validateNameField(firstName, 'firstName')),
    () => (role === 'institution' ? null : validateNameField(lastName, 'lastName')),
    () => validateOptionalUrl(photoUrl, 'photoUrl'),
    () => validateDisciplineList(favoriteSports, 'favoriteSports'),
    () => validateDisciplineList(disciplines, 'disciplines'),
    () => {
      if (acceptTerms !== true) {
        return { field: 'acceptTerms', message: 'You must accept the terms' };
      }
      return null;
    },
    () => (role === 'institution' ? validateInstitutionName(institutionName, { required: true }) : null),
    () => {
      if (role !== 'instructor') return null;
      if (!gender) {
        return { field: 'gender', message: 'Gender is required for instructor registration' };
      }
      if (!GENDER_VALUES.includes(gender)) {
        return { field: 'gender', message: 'gender must be male, female, other, or prefer_not_to_say' };
      }
      return null;
    },
  ]);

  failIfErrors(errors);

  return {
    email: trim(email).toLowerCase(),
    password,
    role,
    firstName: role === 'institution' ? '' : trim(firstName),
    lastName: role === 'institution' ? '' : trim(lastName),
    favoriteSports: favoriteSports ?? [],
    disciplines: disciplines ?? [],
    institutionName: trim(institutionName),
    photoUrl: photoUrl || null,
    acceptTerms: true,
    gender: role === 'instructor' ? gender : null,
  };
}

function validateLogin(body) {
  const { email, password } = body ?? {};
  const errors = collectErrors([
    () => validateEmailField(email),
    () => {
      if (!password) return { field: 'password', message: 'Password is required' };
      return null;
    },
  ]);
  failIfErrors(errors);
  return { email: trim(email).toLowerCase(), password };
}

function validateAthleteProfile(updates) {
  const errors = collectErrors([
    () => (updates.firstName !== undefined ? validateNameField(updates.firstName, 'firstName', { required: true }) : null),
    () => (updates.lastName !== undefined ? validateNameField(updates.lastName, 'lastName', { required: true }) : null),
    () => validateOptionalUrl(updates.photoUrl, 'photoUrl'),
    () => validateDisciplineList(updates.favoriteSports, 'favoriteSports'),
    () => validateOptionalText(updates.locale, 'locale', 10),
  ]);

  if (!Object.keys(updates ?? {}).some((k) => updates[k] !== undefined)) {
    throw badRequest('No valid fields to update');
  }

  failIfErrors(errors);

  return {
    ...updates,
    firstName: updates.firstName !== undefined ? trim(updates.firstName) : undefined,
    lastName: updates.lastName !== undefined ? trim(updates.lastName) : undefined,
  };
}

function validateInstructorProfile(updates) {
  const GENDER_VALUES = ['male', 'female', 'other', 'prefer_not_to_say'];
  const errors = collectErrors([
    () => (updates.displayName !== undefined ? validateDisplayName(updates.displayName, { required: true }) : null),
    () => validateOptionalText(updates.bio, 'bio', LIMITS.bio),
    () => validateOptionalUrl(updates.photoUrl, 'photoUrl'),
    () => validateDisciplineList(updates.disciplines, 'disciplines'),
    () => validateHourlyRate(updates.hourlyRate),
    () => {
      if (updates.gender === undefined || updates.gender === null) return null;
      if (!GENDER_VALUES.includes(updates.gender)) {
        return { field: 'gender', message: 'gender must be male, female, other, or prefer_not_to_say' };
      }
      return null;
    },
  ]);

  if (updates.certifications !== undefined) {
    if (!Array.isArray(updates.certifications)) {
      errors.push({ field: 'certifications', message: 'Certifications must be an array' });
    } else {
      for (const cert of updates.certifications) {
        if (!cert?.name?.trim() || !cert?.issuer?.trim() || !Number.isInteger(cert?.year)) {
          errors.push({ field: 'certifications', message: 'Each certification needs name, issuer, and year' });
          break;
        }
      }
    }
  }

  if (!Object.keys(updates ?? {}).some((k) => updates[k] !== undefined)) {
    throw badRequest('No valid fields to update');
  }

  failIfErrors(errors);

  return {
    ...updates,
    displayName: updates.displayName !== undefined ? trim(updates.displayName) : undefined,
    bio: updates.bio !== undefined ? trim(updates.bio) : undefined,
  };
}

const OPENING_HOUR_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateOpeningHours(openingHours) {
  if (openingHours === undefined || openingHours === null) return null;
  if (typeof openingHours !== 'object' || Array.isArray(openingHours)) {
    return { field: 'openingHours', message: 'openingHours must be an object' };
  }
  for (const [day, value] of Object.entries(openingHours)) {
    if (!OPENING_HOUR_DAYS.includes(day)) {
      return { field: 'openingHours', message: `Invalid day: ${day}` };
    }
    if (value == null || typeof value !== 'object') {
      return { field: 'openingHours', message: `Invalid hours for ${day}` };
    }
    if (value.closed === true) continue;
    if (value.open && !TIME_RE.test(String(value.open))) {
      return { field: 'openingHours', message: `Invalid open time for ${day}` };
    }
    if (value.close && !TIME_RE.test(String(value.close))) {
      return { field: 'openingHours', message: `Invalid close time for ${day}` };
    }
  }
  return null;
}

function validateInstitutionProfile(updates) {
  const errors = collectErrors([
    () => (updates.name !== undefined ? validateInstitutionName(updates.name, { required: true }) : null),
    () => validateOptionalText(updates.description, 'description', LIMITS.description),
    () => validateOptionalUrl(updates.logoUrl, 'logoUrl'),
    () => validateOptionalText(updates.address, 'address', LIMITS.address),
    () => validateOptionalText(updates.city, 'city', LIMITS.city),
    () => validateCountry(updates.country),
    () => validateGallery(updates.gallery),
    () => validateOptionalText(updates.contactPhone, 'contactPhone', 30),
    () => (updates.contactEmail !== undefined && updates.contactEmail !== ''
      ? validateEmailField(updates.contactEmail)
      : null),
    () => validateOptionalUrl(updates.website, 'website'),
    () => validateOpeningHours(updates.openingHours),
  ]);

  if (updates.location) {
    errors.push(
      validateOptionalText(updates.location.address, 'address', LIMITS.address),
      validateOptionalText(updates.location.city, 'city', LIMITS.city),
      validateCountry(updates.location.country),
    );
  }

  if (!Object.keys(updates ?? {}).some((k) => updates[k] !== undefined)) {
    throw badRequest('No valid fields to update');
  }

  failIfErrors(errors.filter(Boolean));

  const normalized = { ...updates };
  if (updates.name !== undefined) normalized.name = trim(updates.name);
  if (updates.description !== undefined) normalized.description = trim(updates.description);
  if (updates.address !== undefined) normalized.address = trim(updates.address);
  if (updates.city !== undefined) normalized.city = trim(updates.city);
  if (updates.country !== undefined) normalized.country = trim(updates.country).toUpperCase();
  if (updates.location?.country !== undefined) {
    normalized.location = {
      ...updates.location,
      country: trim(updates.location.country).toUpperCase(),
    };
  }
  if (updates.contactPhone !== undefined) normalized.contactPhone = trim(updates.contactPhone) || null;
  if (updates.contactEmail !== undefined) {
    normalized.contactEmail = trim(updates.contactEmail).toLowerCase() || null;
  }
  if (updates.website !== undefined) normalized.website = trim(updates.website) || null;
  if (updates.openingHours !== undefined) normalized.openingHours = updates.openingHours;
  return normalized;
}

const JOB_ROLE_TYPES = ['instructor', 'trainer', 'staff'];
const JOB_STATUSES = ['draft', 'open', 'closed'];

function validateJobPosting(body, { partial = false } = {}) {
  const { title, roleType, description, disciplines, status, expiresAt } = body ?? {};
  const errors = collectErrors([
    () => {
      if (partial && title === undefined) return null;
      if (!title || typeof title !== 'string' || !trim(title)) {
        return { field: 'title', message: 'title is required' };
      }
      if (trim(title).length > 120) {
        return { field: 'title', message: 'title is too long' };
      }
      return null;
    },
    () => {
      if (roleType === undefined) return null;
      if (!JOB_ROLE_TYPES.includes(roleType)) {
        return { field: 'roleType', message: 'Invalid roleType' };
      }
      return null;
    },
    () => validateOptionalText(description, 'description', LIMITS.description),
    () => {
      if (disciplines === undefined) return null;
      if (!Array.isArray(disciplines)) {
        return { field: 'disciplines', message: 'disciplines must be an array' };
      }
      return null;
    },
    () => {
      if (status === undefined) return null;
      if (!JOB_STATUSES.includes(status)) {
        return { field: 'status', message: 'Invalid status' };
      }
      return null;
    },
    () => {
      if (expiresAt === undefined || expiresAt === null || expiresAt === '') return null;
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) {
        return { field: 'expiresAt', message: 'expiresAt must be a valid date' };
      }
      return null;
    },
  ]);

  if (!partial && !title) {
    throw badRequest('title is required');
  }

  failIfErrors(errors.filter(Boolean));

  const normalized = {};
  if (title !== undefined) normalized.title = trim(title);
  if (roleType !== undefined) normalized.roleType = roleType;
  if (description !== undefined) normalized.description = trim(description) || '';
  if (disciplines !== undefined) {
    normalized.disciplines = disciplines.map((d) => trim(String(d))).filter(Boolean);
  }
  if (status !== undefined) normalized.status = status;
  if (expiresAt !== undefined) {
    normalized.expiresAt = expiresAt ? new Date(expiresAt) : null;
  }
  if (!partial) {
    normalized.roleType = normalized.roleType || 'instructor';
    normalized.description = normalized.description ?? '';
    normalized.disciplines = normalized.disciplines ?? [];
    normalized.status = normalized.status || 'open';
  }
  return normalized;
}

function validateJobApplication(body) {
  const { message } = body ?? {};
  const errors = collectErrors([
    () => validateOptionalText(message, 'message', LIMITS.description),
  ]);
  failIfErrors(errors.filter(Boolean));
  return { message: message ? trim(message) : '' };
}

function validateUserAccountUpdate(body) {
  const { email, currentPassword, newPassword } = body ?? {};
  const hasEmail = email !== undefined && email !== null && String(email).trim() !== '';
  const hasPassword =
    newPassword !== undefined && newPassword !== null && String(newPassword).trim() !== '';

  if (!hasEmail && !hasPassword) {
    failIfErrors([{ field: 'body', message: 'Nothing to update' }]);
  }

  const errors = collectErrors([
    () => (hasEmail ? validateEmailField(email) : null),
    () => (hasPassword ? validatePasswordField(newPassword) : null),
    () => {
      if (hasPassword && (!currentPassword || typeof currentPassword !== 'string')) {
        return { field: 'currentPassword', message: 'Current password is required' };
      }
      return null;
    },
  ]);
  failIfErrors(errors);

  return {
    email: hasEmail ? trim(email).toLowerCase() : undefined,
    currentPassword: hasPassword ? currentPassword : undefined,
    newPassword: hasPassword ? newPassword : undefined,
  };
}

function validateResetPassword(body) {
  const { token, password } = body ?? {};
  const errors = collectErrors([
    () => {
      if (!token || typeof token !== 'string' || !token.trim()) {
        return { field: 'token', message: 'Reset token is required' };
      }
      return null;
    },
    () => validatePasswordField(password),
  ]);
  failIfErrors(errors);
  return { token: token.trim(), password };
}

const VALID_BILLING_FREQUENCIES = ['monthly', 'quarterly', 'annual'];
const VALID_PLAN_TYPES = ['individual', 'family'];

function validateMembershipPlan(body, { partial = false } = {}) {
  const { name, description, priceCents, priceCurrency, billingFrequency, planType, maxMembers, active } =
    body ?? {};

  const errors = collectErrors([
    () => {
      if (name === undefined && partial) return null;
      if (!isNonEmptyString(name) || name.trim().length < 2 || name.trim().length > 100) {
        return { field: 'name', message: 'Plan name must be 2–100 characters' };
      }
      return null;
    },
    () => validateOptionalText(description, 'description', LIMITS.description),
    () => {
      if (priceCents === undefined && partial) return null;
      if (!Number.isInteger(priceCents) || priceCents < 0) {
        return { field: 'priceCents', message: 'priceCents must be a non-negative integer' };
      }
      return null;
    },
    () => {
      if (billingFrequency === undefined && partial) return null;
      if (!VALID_BILLING_FREQUENCIES.includes(billingFrequency)) {
        return {
          field: 'billingFrequency',
          message: `billingFrequency must be one of: ${VALID_BILLING_FREQUENCIES.join(', ')}`,
        };
      }
      return null;
    },
    () => {
      if (planType === undefined) return null;
      if (!VALID_PLAN_TYPES.includes(planType)) {
        return { field: 'planType', message: `planType must be one of: ${VALID_PLAN_TYPES.join(', ')}` };
      }
      return null;
    },
    () => {
      if (maxMembers === undefined || maxMembers === null) return null;
      if (!Number.isInteger(maxMembers) || maxMembers < 1) {
        return { field: 'maxMembers', message: 'maxMembers must be a positive integer' };
      }
      return null;
    },
    () => {
      const effectivePlanType = planType ?? (partial ? undefined : 'individual');
      if (effectivePlanType === 'family' && (maxMembers === undefined || maxMembers === null)) {
        return { field: 'maxMembers', message: 'maxMembers is required for family plans' };
      }
      return null;
    },
  ]);

  if (!partial && !Object.keys(body ?? {}).length) {
    throw badRequest('No valid fields provided');
  }

  failIfErrors(errors.filter(Boolean));

  const normalized = {};
  if (name !== undefined) normalized.name = trim(name);
  if (description !== undefined) normalized.description = trim(description) || '';
  if (priceCents !== undefined) normalized.priceCents = priceCents;
  if (priceCurrency !== undefined) normalized.priceCurrency = trim(priceCurrency).toUpperCase();
  if (billingFrequency !== undefined) normalized.billingFrequency = billingFrequency;
  if (planType !== undefined) normalized.planType = planType;
  if (maxMembers !== undefined) normalized.maxMembers = maxMembers;
  if (active !== undefined) normalized.active = Boolean(active);
  return normalized;
}

function validateMembershipSettings(body) {
  const { graceDays, dueReminderDays } = body ?? {};
  const errors = collectErrors([
    () => {
      if (graceDays === undefined) return null;
      if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 90) {
        return { field: 'graceDays', message: 'graceDays must be between 0 and 90' };
      }
      return null;
    },
    () => {
      if (dueReminderDays === undefined) return null;
      if (!Number.isInteger(dueReminderDays) || dueReminderDays < 1 || dueReminderDays > 30) {
        return { field: 'dueReminderDays', message: 'dueReminderDays must be between 1 and 30' };
      }
      return null;
    },
  ]);
  failIfErrors(errors.filter(Boolean));
  const normalized = {};
  if (graceDays !== undefined) normalized.graceDays = graceDays;
  if (dueReminderDays !== undefined) normalized.dueReminderDays = dueReminderDays;
  return normalized;
}

function validateMembershipInvite(body) {
  const { planId, email, invitedName, invitedPhone, expiresInDays } = body ?? {};
  const errors = collectErrors([
    () => {
      if (!planId || typeof planId !== 'string') {
        return { field: 'planId', message: 'planId is required' };
      }
      return null;
    },
    () => {
      if (!email) return null;
      return validateEmailField(email);
    },
    () => validateOptionalText(invitedName, 'invitedName', 100),
    () => validateOptionalText(invitedPhone, 'invitedPhone', 30),
  ]);
  failIfErrors(errors.filter(Boolean));
  return {
    planId: trim(planId),
    email: email ? trim(email).toLowerCase() : undefined,
    invitedName: invitedName ? trim(invitedName) : undefined,
    invitedPhone: invitedPhone ? trim(invitedPhone) : undefined,
    expiresInDays: expiresInDays ?? 30,
  };
}

function validateAddMember(body) {
  const { planId, contactName, contactEmail, contactPhone, userId } = body ?? {};
  const errors = collectErrors([
    () => {
      if (!planId) return { field: 'planId', message: 'planId is required' };
      return null;
    },
    () => {
      if (!contactName && !contactEmail && !userId) {
        return { field: 'contact', message: 'contactName, contactEmail, or userId is required' };
      }
      return null;
    },
    () => (contactEmail ? validateEmailField(contactEmail) : null),
    () => validateOptionalText(contactName, 'contactName', 100),
    () => validateOptionalText(contactPhone, 'contactPhone', 30),
  ]);
  failIfErrors(errors.filter(Boolean));
  return {
    planId: trim(planId),
    contactName: contactName ? trim(contactName) : undefined,
    contactEmail: contactEmail ? trim(contactEmail).toLowerCase() : undefined,
    contactPhone: contactPhone ? trim(contactPhone) : undefined,
    userId: userId || undefined,
  };
}

function validateUpdateMember(body) {
  const { planId, contactName, contactEmail, contactPhone } = body ?? {};
  const errors = collectErrors([
    () =>
      contactEmail !== undefined && contactEmail !== '' ? validateEmailField(contactEmail) : null,
    () => validateOptionalText(contactName, 'contactName', 100),
    () => validateOptionalText(contactPhone, 'contactPhone', 30),
    () => {
      if (planId !== undefined && (typeof planId !== 'string' || !planId.trim())) {
        return { field: 'planId', message: 'planId must be a non-empty string' };
      }
      return null;
    },
  ]);

  if (!Object.keys(body ?? {}).some((k) => body[k] !== undefined)) {
    throw badRequest('No valid fields to update');
  }

  failIfErrors(errors.filter(Boolean));

  const normalized = {};
  if (planId !== undefined) normalized.planId = trim(planId);
  if (contactName !== undefined) normalized.contactName = trim(contactName) || null;
  if (contactEmail !== undefined) normalized.contactEmail = trim(contactEmail).toLowerCase() || null;
  if (contactPhone !== undefined) normalized.contactPhone = trim(contactPhone) || null;
  return normalized;
}

module.exports = {
  LIMITS,
  DISCIPLINES,
  validateRegister,
  validateLogin,
  validateResetPassword,
  validateAthleteProfile,
  validateInstructorProfile,
  validateInstitutionProfile,
  validateUserAccountUpdate,
  validateEmailField,
  validatePasswordField,
  validateMembershipPlan,
  validateMembershipSettings,
  validateMembershipInvite,
  validateAddMember,
  validateUpdateMember,
  validateJobPosting,
  validateJobApplication,
};
