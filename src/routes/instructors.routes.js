const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const instructorsService = require('../services/instructors.service');

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await instructorsService.listInstructors();
    res.json({ data });
  }),
);

router.get(
  '/me',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const instructor = await instructorsService.getInstructorMe(req.user.id);
    res.json(instructor);
  }),
);

router.patch(
  '/me',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const instructor = await instructorsService.updateInstructorMe(req.user.id, req.body);
    res.json(instructor);
  }),
);

router.patch(
  '/me/availability-now',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const result = await instructorsService.setAvailableNow(
      req.user.id,
      Boolean(req.body.availableNow),
    );
    res.json(result);
  }),
);

router.get(
  '/me/invites',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const data = await instructorsService.listMyInvites(req.user.id);
    res.json({ data });
  }),
);

router.post(
  '/me/invites/:id/accept',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const result = await instructorsService.acceptInvite(req.user.id, req.params.id);
    res.json(result);
  }),
);

router.get(
  '/me/job-applications',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const jobPostingsService = require('../services/job-postings.service');
    const data = await jobPostingsService.listMyApplications(req.user.id);
    res.json({ data });
  }),
);

router.get(
  '/me/metrics',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const metricsService = require('../services/metrics.service');
    const metrics = await metricsService.getInstructorMetrics(req.user.id, {
      period: req.query.period,
    });
    res.json(metrics);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const instructor = await instructorsService.getInstructorById(req.params.id);
    res.json(instructor);
  }),
);

module.exports = router;
