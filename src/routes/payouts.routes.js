const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const payoutsService = require('../services/payouts.service');
const mpOAuthService = require('../services/mp-oauth.service');
const marketplaceService = require('../services/marketplace.service');
const { getMarketplacePublicConfig } = require('../config/marketplace.config');

const router = Router();

router.get(
  '/me',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const result = await payoutsService.listPayouts(req.user, req.query);
    res.json(result);
  }),
);

router.get(
  '/me/summary',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const summary = await payoutsService.getSummary(req.user, req.query.period || 'month');
    res.json({
      ...summary,
      marketplace: getMarketplacePublicConfig(),
    });
  }),
);

router.get(
  '/me/export.csv',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const csv = await payoutsService.exportCsv(req.user, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payouts.csv"');
    res.send(csv);
  }),
);

router.get(
  '/mp/status',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const connection = await marketplaceService.getSellerConnectionForUser(req.user);
    res.json({
      marketplace: getMarketplacePublicConfig(),
      connection,
      oauth: mpOAuthService.getMarketplaceStatus(),
    });
  }),
);

router.get(
  '/mp/connect',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const result = mpOAuthService.getConnectUrl(req.user);
    res.json(result);
  }),
);

router.get(
  '/mp/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      const { appDeepLinkScheme } = require('../config/env');
      res.redirect(`${appDeepLinkScheme}://profile/payout-connected?status=error`);
      return;
    }
    if (!code || !state) {
      res.status(400).send('Missing OAuth code or state');
      return;
    }
    const result = await mpOAuthService.handleOAuthCallback(String(code), String(state));
    res.redirect(result.deepLink);
  }),
);

router.delete(
  '/mp/disconnect',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    await mpOAuthService.disconnectSeller(req.user);
    const connection = await marketplaceService.getSellerConnectionForUser(req.user);
    res.json({ connection });
  }),
);

module.exports = router;
