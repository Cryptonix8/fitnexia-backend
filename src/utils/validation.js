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
  } = body ?? {};

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
  const errors = collectErrors([
    () => (updates.displayName !== undefined ? validateDisplayName(updates.displayName, { required: true }) : null),
    () => validateOptionalText(updates.bio, 'bio', LIMITS.bio),
    () => validateOptionalUrl(updates.photoUrl, 'photoUrl'),
    () => validateDisciplineList(updates.disciplines, 'disciplines'),
    () => validateHourlyRate(updates.hourlyRate),
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

function validateInstitutionProfile(updates) {
  const errors = collectErrors([
    () => (updates.name !== undefined ? validateInstitutionName(updates.name, { required: true }) : null),
    () => validateOptionalText(updates.description, 'description', LIMITS.description),
    () => validateOptionalUrl(updates.logoUrl, 'logoUrl'),
    () => validateOptionalText(updates.address, 'address', LIMITS.address),
    () => validateOptionalText(updates.city, 'city', LIMITS.city),
    () => validateCountry(updates.country),
    () => validateGallery(updates.gallery),
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
  return normalized;
}

function validateUserAccountUpdate(body) {
  const { email } = body ?? {};
  const errors = collectErrors([() => validateEmailField(email)]);
  failIfErrors(errors);
  return { email: trim(email).toLowerCase() };
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
};
