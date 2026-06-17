const { Router } = require('express');
const authRoutes = require('./auth.routes');
const meRoutes = require('./me.routes');
const usersRoutes = require('./users.routes');
const instructorsRoutes = require('./instructors.routes');
const institutionsRoutes = require('./institutions.routes');
const classesRoutes = require('./classes.routes');
const bookingsRoutes = require('./bookings.routes');
const reviewsRoutes = require('./reviews.routes');
const feedRoutes = require('./feed.routes');
const { notificationsRouter, configRouter } = require('./config.routes');
const mediaRoutes = require('./media.routes');
const payoutsRoutes = require('./payouts.routes');
const paymentsRoutes = require('./payments.routes');
const passesRoutes = require('./passes.routes');
const membershipsRoutes = require('./memberships.routes');
const webhooksRoutes = require('./webhooks.routes');
const adminRoutes = require('./admin.routes');
const reviewsService = require('../services/reviews.service');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'fitnexia-api' });
});

router.use('/auth', authRoutes);
router.use('/auth', meRoutes);
router.use('/users', usersRoutes);
router.use('/instructors', instructorsRoutes);
router.use('/institutions', institutionsRoutes);
router.use('/classes', classesRoutes);
router.use('/bookings', bookingsRoutes);
router.use('/reviews', reviewsRoutes);
router.use('/feed', feedRoutes);
router.use('/notifications', notificationsRouter);
router.use('/config', configRouter);
router.use('/media', mediaRoutes);
router.use('/payouts', payoutsRoutes);
router.use('/payments', paymentsRoutes);
router.use('/passes', passesRoutes);
router.use('/memberships', membershipsRoutes);
router.use('/webhooks', webhooksRoutes);
router.use('/admin', adminRoutes);

// Convenience aliases matching API.md
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

router.get('/plans', (req, res) => {
  const configService = require('../services/config.service');
  res.json({ data: configService.getPlans() });
});

module.exports = router;
