const { Router } = require('express');
const multer = require('multer');
const asyncHandler = require('../utils/asyncHandler');
const { badRequest } = require('../utils/errors');
const { requireAuth, requireRole } = require('../middleware/auth');
const verificationService = require('../services/verification.service');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (verificationService.ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('INVALID_DOCUMENT_TYPE'));
  },
});

function mapUploadedFiles(files) {
  const map = {};
  for (const field of verificationService.REQUIRED_DOCS) {
    const list = files?.[field];
    if (list?.[0]) map[field] = list[0];
  }
  return map;
}

router.get(
  '/me',
  requireAuth,
  requireRole('instructor', 'institution'),
  asyncHandler(async (req, res) => {
    const status = await verificationService.getVerificationStatusForUser(req.user);
    res.json(status);
  }),
);

router.post(
  '/',
  requireAuth,
  requireRole('instructor', 'institution'),
  (req, res, next) => {
    upload.fields(
      verificationService.REQUIRED_DOCS.map((name) => ({ name, maxCount: 1 })),
    )(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        next(badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10 MB)' : err.message));
        return;
      }
      if (err?.message === 'INVALID_DOCUMENT_TYPE') {
        next(badRequest('Documents must be JPEG, PNG, WebP, or PDF'));
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const result = await verificationService.submitVerification(
      req.user,
      mapUploadedFiles(req.files),
    );
    res.status(201).json(result);
  }),
);

module.exports = router;
