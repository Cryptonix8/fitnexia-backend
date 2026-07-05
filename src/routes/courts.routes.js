const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const courtsService = require('../services/courts.service');

const router = Router();

router.get(
  '/institutions/:institutionId/courts',
  asyncHandler(async (req, res) => {
    const data = await courtsService.listCourtsPublic(req.params.institutionId);
    res.json({ data });
  }),
);

router.get(
  '/institutions/:institutionId/schedule',
  asyncHandler(async (req, res) => {
    const data = await courtsService.getSchedule(req.params.institutionId, {
      courtId: req.query.courtId,
      date: req.query.date,
    });
    res.json({ data });
  }),
);

router.post(
  '/quote',
  requireAuth,
  asyncHandler(async (req, res) => {
    const quote = await courtsService.quotePrice(req.user, req.body);
    res.json(quote);
  }),
);

router.post(
  '/reservations',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const result = await courtsService.createReservation(req.user, req.body);
    res.status(201).json(result);
  }),
);

router.get(
  '/reservations/me',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const data = await courtsService.listMyReservations(req.user);
    res.json({ data });
  }),
);

router.post(
  '/reservations/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const reservation = await courtsService.cancelReservation(req.user, req.params.id);
    res.json(reservation);
  }),
);

router.get(
  '/me/settings',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const settings = await courtsService.getCourtSettings(req.user.id);
    res.json(settings);
  }),
);

router.patch(
  '/me/settings',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const settings = await courtsService.updateCourtSettings(req.user.id, req.body);
    res.json(settings);
  }),
);

router.get(
  '/me/courts',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const data = await courtsService.listCourts(req.user.id);
    res.json({ data });
  }),
);

router.post(
  '/me/courts',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const court = await courtsService.createCourt(req.user.id, req.body);
    res.status(201).json(court);
  }),
);

router.patch(
  '/me/courts/:id',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const court = await courtsService.updateCourt(req.user.id, req.params.id, req.body);
    res.json(court);
  }),
);

router.delete(
  '/me/courts/:id',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    await courtsService.deleteCourt(req.user.id, req.params.id);
    res.status(204).send();
  }),
);

router.get(
  '/me/pricing-rules',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const data = await courtsService.listPricingRules(req.user.id);
    res.json({ data });
  }),
);

router.post(
  '/me/pricing-rules',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const rule = await courtsService.createPricingRule(req.user.id, req.body);
    res.status(201).json(rule);
  }),
);

router.delete(
  '/me/pricing-rules/:id',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    await courtsService.deletePricingRule(req.user.id, req.params.id);
    res.status(204).send();
  }),
);

router.get(
  '/me/schedule',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const institution = await require('../services/institutions.service').getInstitutionByUserId(
      req.user.id,
    );
    const data = await courtsService.getSchedule(institution.id, {
      courtId: req.query.courtId,
      date: req.query.date,
    });
    res.json({ data });
  }),
);

router.get(
  '/me/reservations',
  requireAuth,
  requireRole('institution'),
  asyncHandler(async (req, res) => {
    const data = await courtsService.listInstitutionReservations(req.user.id, {
      date: req.query.date,
      courtId: req.query.courtId,
    });
    res.json({ data });
  }),
);

module.exports = router;
