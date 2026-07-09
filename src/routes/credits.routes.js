const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const creditsService = require('../services/credits.service');

const router = Router();

router.get(
  '/me',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const balance = await creditsService.getMyBalance(req.user);
    res.json(balance);
  }),
);

router.get(
  '/me/transactions',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const data = await creditsService.listMyTransactions(req.user);
    res.json({ data });
  }),
);

module.exports = router;
