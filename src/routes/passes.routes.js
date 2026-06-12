const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const passesService = require('../services/passes.service');

const router = Router();

router.get(
  '/me',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const data = await passesService.listMyPasses(req.user.id);
    res.json({ data });
  }),
);

router.get(
  '/me/active',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const data = await passesService.getMyActivePasses(req.user.id);
    res.json({ data });
  }),
);

module.exports = router;
