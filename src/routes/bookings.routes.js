const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const bookingsService = require('../services/bookings.service');

const router = Router();

router.post(
  '/',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await bookingsService.createBooking(req.user, req.body);
    res.status(201).json(result);
  }),
);

router.get(
  '/me',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const data = await bookingsService.listMyBookings(req.user);
    res.json({ data });
  }),
);

router.get(
  '/:id/review-eligibility',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await bookingsService.reviewEligibility(req.user, req.params.id);
    res.json(result);
  }),
);

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const booking = await bookingsService.getBooking(req.user, req.params.id);
    res.json(booking);
  }),
);

router.post(
  '/:id/cancel',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const booking = await bookingsService.cancelBooking(req.user, req.params.id);
    res.json(booking);
  }),
);

router.post(
  '/:id/sync-payment',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await bookingsService.syncBookingPayment(req.user, req.params.id);
    res.json(result);
  }),
);

module.exports = router;
