const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const classesService = require('../services/classes.service');
const waitlistService = require('../services/waitlist.service');

const router = Router();

router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const result = await classesService.searchClasses(req.query);
    res.json(result);
  }),
);

router.get(
  '/map',
  asyncHandler(async (req, res) => {
    const data = await classesService.mapMarkers(req.query);
    res.json({ data });
  }),
);

router.get(
  '/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const classes = await classesService.listMine(req.user);
    res.json({ data: classes });
  }),
);

router.post(
  '/',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const cls = await classesService.createClass(req.user, req.body);
    res.status(201).json(cls);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const cls = await classesService.getClassById(req.params.id);
    res.json(cls);
  }),
);

router.patch(
  '/:id',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const cls = await classesService.updateClass(req.user, req.params.id, req.body);
    res.json(cls);
  }),
);

router.post(
  '/:id/cancel',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    await classesService.cancelClass(req.user, req.params.id);
    res.status(204).send();
  }),
);

router.post(
  '/:classId/waitlist',
  requireAuth,
  requireRole('athlete'),
  asyncHandler(async (req, res) => {
    const entry = await waitlistService.joinWaitlist(req.user, req.params.classId);
    res.status(201).json(entry);
  }),
);

module.exports = router;
