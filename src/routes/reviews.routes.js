const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const reviewsService = require('../services/reviews.service');

const router = Router();

router.post(
  '/',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const review = await reviewsService.createReview(req.user, req.body);
    res.status(201).json(review);
  }),
);

router.get(
  '/instructors/:id/reviews',
  asyncHandler(async (req, res) => {
    const data = await reviewsService.listInstructorReviews(req.params.id);
    res.json({ data });
  }),
);

router.get(
  '/instructors/:id/staff-reviews',
  asyncHandler(async (req, res) => {
    const data = await reviewsService.listStaffReviewsForInstructor(req.params.id);
    res.json({ data });
  }),
);

router.post(
  '/:id/report',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await reviewsService.reportReview(req.user, req.params.id, req.body);
    res.status(201).json(result);
  }),
);

module.exports = router;
