const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const port = Number(process.env.PORT || 3001);

module.exports = {
  port,
  databaseUrl: required('DATABASE_URL'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  jwtAccessExpiresIn: Number(process.env.JWT_ACCESS_EXPIRES_IN || 3600),
  frontendUrl: process.env.FRONTEND_URL || '*',
  isDev: process.env.NODE_ENV !== 'production',
  googleClientIds: (process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_WEB_CLIENT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  mercadopagoAccessToken:
    process.env.MERCADOPAGO_PLATFORM_ACCESS_TOKEN ||
    process.env.MERCADOPAGO_ACCESS_TOKEN ||
    '',
  mercadopagoAppId: process.env.MERCADOPAGO_APP_ID || '',
  mercadopagoClientSecret: process.env.MERCADOPAGO_CLIENT_SECRET || '',
  mercadopagoMarketplaceEnabled: process.env.MERCADOPAGO_MARKETPLACE_ENABLED === 'true',
  marketplaceGymPayee: process.env.MARKETPLACE_GYM_PAYEE || 'institution',
  marketplacePassRevenue: process.env.MARKETPLACE_PASS_REVENUE || 'platform_ledger',
  marketplaceRequireSellerConnect:
    process.env.MARKETPLACE_REQUIRE_SELLER_CONNECT === 'true',
  apiPublicUrl: (process.env.API_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  appDeepLinkScheme: process.env.APP_DEEP_LINK_SCHEME || 'fitnexia',
  androidAppPackage: process.env.ANDROID_APP_PACKAGE || 'com.fitnexia.app',
  paymentPendingMinutes: Number(process.env.PAYMENT_PENDING_MINUTES || 30),
  paymentsEnabled: process.env.PAYMENTS_ENABLED !== 'false',
  defaultCurrency: (process.env.DEFAULT_CURRENCY || 'UYU').trim().toUpperCase(),
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || 'Fitnexia <noreply@fitnexia.com>',
  emailEnabled: Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS,
  ),
  passwordResetExpiresMinutes: Number(process.env.PASSWORD_RESET_EXPIRES_MINUTES || 60),
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
  firebaseEnabled: Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  ),
  notificationsSchedulerEnabled: process.env.NOTIFICATIONS_SCHEDULER_ENABLED !== 'false',
  livekitUrl: (process.env.LIVEKIT_URL || '').replace(/\/$/, ''),
  livekitApiKey: process.env.LIVEKIT_API_KEY || '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || '',
  livekitConfigured: Boolean(
    process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET,
  ),
};
