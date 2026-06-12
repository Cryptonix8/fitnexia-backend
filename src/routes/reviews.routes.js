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

module.exports = router;
