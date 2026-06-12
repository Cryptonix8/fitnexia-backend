const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const usersService = require('../services/users.service');

const router = Router();

router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await usersService.updateUserAccount(req.user.id, req.body);
    res.json(user);
  }),
);

router.get(
  '/me/profile',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const profile = await usersService.getAthleteProfile(req.user.id);
    res.json(profile);
  }),
);

router.patch(
  '/me/profile',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const profile = await usersService.updateAthleteProfile(req.user.id, req.body);
    res.json(profile);
  }),
);

module.exports = router;
