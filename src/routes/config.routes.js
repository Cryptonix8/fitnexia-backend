const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { isDev } = require('../config/env');
const usersService = require('../services/users.service');
const devicesService = require('../services/notifications-devices.service');
const notificationsService = require('../services/notifications.service');
const configService = require('../services/config.service');
const passesService = require('../services/passes.service');
const inboxService = require('../services/notifications-inbox.service');

const router = Router();

router.get(
  '/preferences',
  requireAuth,
  asyncHandler(async (req, res) => {
    const prefs = await usersService.getNotificationPreferences(req.user.id);
    res.json(prefs);
  }),
);

router.patch(
  '/preferences',
  requireAuth,
  asyncHandler(async (req, res) => {
    const prefs = await usersService.updateNotificationPreferences(req.user.id, req.body);
    res.json(prefs);
  }),
);

router.post(
  '/devices',
  requireAuth,
  asyncHandler(async (req, res) => {
    await devicesService.registerDevice(req.user.id, req.body);
    res.status(201).json({ registered: true });
  }),
);

router.delete(
  '/devices/:token',
  requireAuth,
  asyncHandler(async (req, res) => {
    await devicesService.unregisterDevice(req.user.id, decodeURIComponent(req.params.token));
    res.status(204).send();
  }),
);

router.post(
  '/test-push',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isDev) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const result = await notificationsService.dispatchPush({
      userId: req.user.id,
      type: 'password_reset',
      title: req.body?.title || 'Fitnexia test',
      body: req.body?.body || 'Push notification test',
      data: { screen: '/(athlete)/(tabs)/bookings' },
      skipDedupe: true,
    });
    res.json(result);
  }),
);

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await inboxService.listNotifications(req.user.id, req.query);
    res.json(result);
  }),
);

router.get(
  '/unread-count',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await inboxService.getUnreadCount(req.user.id);
    res.json(result);
  }),
);

router.patch(
  '/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await inboxService.markRead(req.user.id, req.params.id);
    res.json(result);
  }),
);

router.post(
  '/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await inboxService.markAllRead(req.user.id);
    res.json(result);
  }),
);

module.exports = router;

const configRouter = Router();

configRouter.get(
  '/disciplines',
  asyncHandler(async (req, res) => {
    res.json({ data: configService.getDisciplines() });
  }),
);

configRouter.get(
  '/plans',
  asyncHandler(async (req, res) => {
    res.json({ data: configService.getPlans() });
  }),
);

configRouter.get(
  '/app',
  asyncHandler(async (req, res) => {
    res.json(configService.getAppConfig());
  }),
);

configRouter.get(
  '/payments',
  asyncHandler(async (req, res) => {
    res.json(configService.getPaymentsConfig());
  }),
);

configRouter.get(
  '/gym-tiers',
  asyncHandler(async (req, res) => {
    res.json({ data: configService.getGymTiers() });
  }),
);

configRouter.get(
  '/pass-products',
  asyncHandler(async (req, res) => {
    res.json({ data: passesService.getPassProducts() });
  }),
);

module.exports.notificationsRouter = router;
module.exports.configRouter = configRouter;
