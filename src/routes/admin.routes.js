const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const adminService = require('../services/admin.service');

const router = Router();

router.use(requireAuth, requireRole('admin'));

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const result = await adminService.listUsers(req.query);
    res.json(result);
  }),
);

router.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const user = await adminService.getUser(req.params.id);
    res.json(user);
  }),
);

router.get(
  '/verification-requests',
  asyncHandler(async (req, res) => {
    const data = await adminService.listVerificationRequests();
    res.json({ data });
  }),
);

router.post(
  '/verification-requests/:id/approve',
  asyncHandler(async (req, res) => {
    const result = await adminService.approveVerification(req.user.id, req.params.id);
    res.json(result);
  }),
);

router.post(
  '/verification-requests/:id/reject',
  asyncHandler(async (req, res) => {
    const result = await adminService.rejectVerification(
      req.user.id,
      req.params.id,
      req.body.notes,
    );
    res.json(result);
  }),
);

router.get(
  '/metrics/overview',
  asyncHandler(async (req, res) => {
    const metrics = await adminService.metricsOverview();
    res.json(metrics);
  }),
);

module.exports = router;
