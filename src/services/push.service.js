const fs = require('fs');
const path = require('path');
const { getMessaging } = require('firebase-admin/messaging');
const {
  firebaseEnabled,
  firebaseServiceAccountPath,
  firebaseServiceAccountJson,
} = require('../config/env');

let admin;
let initialized = false;

function resolveServiceAccountPath() {
  if (!firebaseServiceAccountPath) return null;
  if (path.isAbsolute(firebaseServiceAccountPath)) {
    return firebaseServiceAccountPath;
  }
  return path.resolve(__dirname, '../../', firebaseServiceAccountPath);
}

function initFirebase() {
  if (initialized) return admin;
  if (!firebaseEnabled) return null;

  try {
    admin = require('firebase-admin');
    if (admin.getApps().length) {
      initialized = true;
      return admin;
    }

    let credential;
    if (firebaseServiceAccountJson) {
      credential = admin.cert(JSON.parse(firebaseServiceAccountJson));
    } else {
      const resolvedPath = resolveServiceAccountPath();
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        credential = admin.cert(require(resolvedPath));
      } else {
        console.warn('[push] Firebase service account not found — push disabled');
        return null;
      }
    }

    admin.initializeApp({ credential });
    initialized = true;
    return admin;
  } catch (err) {
    console.warn('[push] Firebase init failed:', err.message);
    return null;
  }
}

function isPushEnabled() {
  return Boolean(initFirebase());
}

async function sendPushToTokens(tokens, { title, body, data = {} }) {
  const firebase = initFirebase();
  if (!firebase || !tokens.length) {
    return { sent: 0, invalidTokens: [] };
  }

  const stringData = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, value == null ? '' : String(value)]),
  );

  const messaging = getMessaging();
  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: stringData,
    android: { priority: 'high', notification: { channelId: 'fitnexia_default' } },
    apns: { payload: { aps: { sound: 'default' } } },
  });

  const invalidTokens = [];
  response.responses.forEach((result, index) => {
    if (result.success) return;
    const code = result.error?.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      invalidTokens.push(tokens[index]);
    } else {
      console.warn('[push] Send failed:', code, result.error?.message);
    }
  });

  return { sent: response.successCount, invalidTokens };
}

module.exports = {
  isPushEnabled,
  sendPushToTokens,
};
