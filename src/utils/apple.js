const appleSignin = require('apple-signin-auth');
const { badRequest, unauthorized } = require('./errors');
const { appleClientId } = require('../config/env');

async function verifyAppleIdToken(identityToken) {
  if (!appleClientId) {
    throw badRequest('Sign in with Apple is not configured on the server');
  }

  try {
    return await appleSignin.verifyIdToken(identityToken, {
      audience: appleClientId,
    });
  } catch (err) {
    if (err.status) throw err;
    throw unauthorized('Invalid Apple token');
  }
}

function parseAppleProfile(payload, body = {}) {
  const email = (payload.email || body.email || '').trim().toLowerCase();
  if (!email) {
    throw badRequest('Apple account did not provide an email address');
  }

  const firstName =
    body.firstName?.trim() ||
    payload.given_name?.trim() ||
    payload.name?.trim?.()?.split(/\s+/)[0] ||
    'User';
  const lastName =
    body.lastName?.trim() ||
    payload.family_name?.trim() ||
    payload.name?.trim?.()?.split(/\s+/).slice(1).join(' ') ||
    'Account';

  return { email, firstName, lastName, photoUrl: null };
}

module.exports = { verifyAppleIdToken, parseAppleProfile };
