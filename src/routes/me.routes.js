const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const authService = require('../services/auth.service');

const router = Router();

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.getMe(req.user.id);
    res.json(result);
  }),
);

module.exports = router;
