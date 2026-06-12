const { OAuth2Client } = require('google-auth-library');
const { badRequest, unauthorized } = require('./errors');
const { googleClientIds } = require('../config/env');

const client = new OAuth2Client();

async function verifyGoogleIdToken(idToken) {
  if (!googleClientIds.length) {
    throw badRequest('Google Sign-In is not configured on the server');
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: googleClientIds,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      throw unauthorized('Invalid Google token');
    }
    return payload;
  } catch (err) {
    if (err.status) throw err;
    throw unauthorized('Invalid Google token');
  }
}

function parseGoogleProfile(payload) {
  const email = payload.email?.trim().toLowerCase();
  if (!email) {
    throw badRequest('Google account does not include an email address');
  }
  if (payload.email_verified === false) {
    throw badRequest('Google email address is not verified');
  }

  const firstName = payload.given_name?.trim() || payload.name?.trim().split(/\s+/)[0] || 'User';
  const lastName =
    payload.family_name?.trim() ||
    payload.name?.trim().split(/\s+/).slice(1).join(' ') ||
    'Account';
  const photoUrl = payload.picture || null;

  return { email, firstName, lastName, photoUrl };
}

module.exports = { verifyGoogleIdToken, parseGoogleProfile };
