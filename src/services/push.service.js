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
let credentialFailed = false;

function credentialErrorMessage(err) {
  const message = err?.message || String(err);
  if (message.includes('invalid_grant') || message.includes('Invalid JWT Signature')) {
    return (
      '[push] Firebase service account is invalid or revoked. ' +
      'Regenerate the key in Firebase Console → Project settings → Service accounts, ' +
      'update FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON, then restart the API.'
    );
  }
  return `[push] Firebase init failed: ${message}`;
}

function resolveServiceAccountPath() {
  if (!firebaseServiceAccountPath) return null;
  if (path.isAbsolute(firebaseServiceAccountPath)) {
    return firebaseServiceAccountPath;
  }
  return path.resolve(__dirname, '../../', firebaseServiceAccountPath);
}

function initFirebase() {
  if (initialized) return admin;
  if (!firebaseEnabled || credentialFailed) return null;

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
    if (err?.message?.includes('invalid_grant') || err?.message?.includes('Invalid JWT Signature')) {
      credentialFailed = true;
    }
    console.warn(credentialErrorMessage(err));
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
  let credentialError = false;
  response.responses.forEach((result, index) => {
    if (result.success) return;
    const code = result.error?.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      invalidTokens.push(tokens[index]);
    } else if (code === 'app/invalid-credential') {
      credentialError = true;
      console.warn(credentialErrorMessage(result.error));
    } else {
      console.warn('[push] Send failed:', code, result.error?.message);
    }
  });

  if (credentialError) {
    credentialFailed = true;
    return { sent: 0, invalidTokens: [] };
  }

  return { sent: response.successCount, invalidTokens };
}

module.exports = {
  isPushEnabled,
  sendPushToTokens,
};
