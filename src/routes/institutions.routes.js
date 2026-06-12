const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const institutionsService = require('../services/institutions.service');
const classesService = require('../services/classes.service');

const router = Router();

router.get(
  '/me',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const institution = await institutionsService.getInstitutionMe(req.user.id);
    res.json(institution);
  }),
);

router.patch(
  '/me',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const institution = await institutionsService.updateInstitutionMe(req.user.id, req.body);
    res.json(institution);
  }),
);

router.get(
  '/me/classes',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const classes = await classesService.listMine(req.user);
    res.json({ data: classes });
  }),
);

router.get(
  '/me/instructors/roster',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const data = await institutionsService.getStaffRoster(req.user.id);
    res.json({ data });
  }),
);

router.get(
  '/me/instructors',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const instructors = await institutionsService.listLinkedInstructors(req.user.id);
    res.json({ data: instructors });
  }),
);

router.post(
  '/me/instructors',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const data = await institutionsService.linkInstructor(req.user.id, req.body.instructorId);
    res.status(201).json({ data });
  }),
);

router.delete(
  '/me/instructors/:id',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    await institutionsService.unlinkInstructor(req.user.id, req.params.id);
    res.status(204).send();
  }),
);

router.post(
  '/me/instructors/invite',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const invite = await institutionsService.inviteInstructor(req.user.id, {
      email: req.body.email,
      instructorId: req.body.instructorId,
      message: req.body.message,
    });
    res.status(201).json(invite);
  }),
);

router.get(
  '/me/instructors/invites',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const data = await institutionsService.listInvites(req.user.id);
    res.json({ data });
  }),
);

router.delete(
  '/me/instructors/invites/:id',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    await institutionsService.cancelInvite(req.user.id, req.params.id);
    res.status(204).send();
  }),
);

router.get(
  '/me/instructors/:id/review-eligibility',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const result = await institutionsService.getStaffReviewEligibility(
      req.user.id,
      req.params.id,
    );
    res.json(result);
  }),
);

router.post(
  '/me/staff-reviews',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const reviewsService = require('../services/reviews.service');
    const review = await reviewsService.createStaffReview(req.user, req.body);
    res.status(201).json(review);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const institution = await institutionsService.getInstitutionById(req.params.id);
    res.json(institution);
  }),
);

module.exports = router;
