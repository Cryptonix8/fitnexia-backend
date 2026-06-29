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

router.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const user = await adminService.updateUser(req.params.id, req.body);
    res.json(user);
  }),
);

router.delete(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const result = await adminService.deleteUser(req.user.id, req.params.id);
    res.json(result);
  }),
);

router.get(
  '/verification-requests',
  asyncHandler(async (req, res) => {
    const data = await adminService.listVerificationRequests();
    res.json({ data });
  }),
);

router.get(
  '/reviews/reported',
  asyncHandler(async (req, res) => {
    const data = await adminService.listReportedReviews();
    res.json({ data });
  }),
);

router.post(
  '/reviews/:id/remove',
  asyncHandler(async (req, res) => {
    const result = await adminService.removeReview(req.user.id, req.params.id, req.body);
    res.json(result);
  }),
);

router.get(
  '/verification-requests/:id',
  asyncHandler(async (req, res) => {
    const data = await adminService.getVerificationRequest(req.params.id);
    res.json(data);
  }),
);

router.get(
  '/verification-requests/:requestId/documents/:documentId',
  asyncHandler(async (req, res) => {
    const verificationService = require('../services/verification.service');
    const doc = await verificationService.getDocumentForAdmin(
      req.params.requestId,
      req.params.documentId,
    );
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(doc.originalName)}"`,
    );
    res.send(doc.buffer);
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
      req.body.reason ?? req.body.notes,
    );
    res.json(result);
  }),
);

router.get(
  '/institutions',
  asyncHandler(async (req, res) => {
    const result = await adminService.listInstitutions(req.query);
    res.json(result);
  }),
);

router.patch(
  '/institutions/:id/tier',
  asyncHandler(async (req, res) => {
    const subscription = await adminService.updateInstitutionTier(
      req.params.id,
      req.body.saasTier,
    );
    res.json(subscription);
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
