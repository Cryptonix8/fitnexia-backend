const { createApp } = require('./app');
const { pool } = require('./db/pool');
const {
  port,
  paymentsEnabled,
  apiPublicUrl,
  mercadopagoAccessToken,
  defaultCurrency,
  notificationsSchedulerEnabled,
} = require('./config/env');
const { startNotificationScheduler } = require('./services/notifications-scheduler.service');
const { isPushEnabled } = require('./services/push.service');

async function start() {
  await pool.query('SELECT 1');
  console.log('PostgreSQL connected');

  const app = createApp();
  app.listen(port, () => {
    console.log(`Fitnexia API listening on http://localhost:${port}/v1`);
    console.log(`Swagger docs at http://localhost:${port}/docs`);
    if (paymentsEnabled) {
      const mode = mercadopagoAccessToken ? 'Mercado Pago' : 'mock checkout';
      console.log(`Payments: ${mode} (${defaultCurrency})`);
      console.log(`MP webhook URL: ${apiPublicUrl}/v1/webhooks/mercadopago`);
    }
    console.log(`Push notifications: ${isPushEnabled() ? 'FCM enabled' : 'disabled (set FIREBASE_SERVICE_ACCOUNT_*)'}`);
    if (notificationsSchedulerEnabled) {
      startNotificationScheduler();
    }
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
