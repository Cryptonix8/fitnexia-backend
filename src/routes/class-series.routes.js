const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const classSeriesService = require('../services/class-series.service');

const router = Router();

router.get(
  '/:id',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const series = await classSeriesService.getSeriesForUser(req.user, req.params.id);
    res.json(series);
  }),
);

router.get(
  '/:id/instances',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const instances = await classSeriesService.listSeriesInstances(req.user, req.params.id);
    res.json({ data: instances });
  }),
);

router.post(
  '/:id/pause',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const series = await classSeriesService.pauseSeries(req.user, req.params.id);
    res.json(series);
  }),
);

router.post(
  '/:id/resume',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const series = await classSeriesService.resumeSeries(req.user, req.params.id);
    res.json(series);
  }),
);

router.post(
  '/:id/delete',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const series = await classSeriesService.deleteSeries(req.user, req.params.id);
    res.json(series);
  }),
);

module.exports = router;
