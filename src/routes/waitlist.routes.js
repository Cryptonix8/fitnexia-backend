const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const waitlistService = require('../services/waitlist.service');

const router = Router();

router.get(
  '/me',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const data = await waitlistService.listMyWaitlist(req.user);
    res.json({ data });
  }),
);

router.post(
  '/:id/confirm',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await waitlistService.confirmWaitlistSpot(req.user, req.params.id);
    res.json(result);
  }),
);

router.delete(
  '/:id',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await waitlistService.cancelWaitlistEntry(req.user, req.params.id);
    res.json(result);
  }),
);

module.exports = router;
