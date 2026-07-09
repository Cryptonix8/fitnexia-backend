const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const liveStreamingService = require('../services/live-streaming.service');

const router = Router({ mergeParams: true });

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = await liveStreamingService.getStreamStatus(req.user, req.params.id);
    res.json(status);
  }),
);

router.post(
  '/join',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await liveStreamingService.joinStream(req.user, req.params.id);
    res.json(result);
  }),
);

router.post(
  '/leave',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await liveStreamingService.leaveStream(req.user, req.params.id);
    res.json(result);
  }),
);

router.post(
  '/end',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await liveStreamingService.endStream(req.user, req.params.id);
    res.json(result);
  }),
);

module.exports = router;
