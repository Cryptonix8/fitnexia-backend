const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const jobPostingsService = require('../services/job-postings.service');

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await jobPostingsService.listOpenJobs(req.query);
    res.json({ data });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const job = await jobPostingsService.getOpenJob(req.params.id);
    res.json(job);
  }),
);

router.post(
  '/:id/apply',
  requireAuth,
  requireRole('instructor'),
  asyncHandler(async (req, res) => {
    const application = await jobPostingsService.applyToJob(req.user, req.params.id, req.body);
    res.status(201).json(application);
  }),
);

module.exports = router;
