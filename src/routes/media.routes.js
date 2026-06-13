const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const asyncHandler = require('../utils/asyncHandler');
const { badRequest } = require('../utils/errors');
const { apiPublicUrl } = require('../config/env');

const router = Router();

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = EXT_BY_TYPE[file.mimetype] || path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('INVALID_IMAGE_TYPE'));
  },
});

function publicApiV1Base(req) {
  const configured = (process.env.MEDIA_PUBLIC_URL || apiPublicUrl || '').replace(/\/$/, '');
  if (configured && !configured.includes('localhost')) {
    if (configured.endsWith('/v1')) return configured;
    return `${configured}/v1`;
  }

  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}/v1`;
}

router.post(
  '/presign',
  asyncHandler(async (req, res) => {
    const { purpose, contentType, fileName } = req.body ?? {};
    const validPurposes = ['avatar', 'gallery', 'document'];

    if (!purpose || !validPurposes.includes(purpose)) {
      throw badRequest('purpose must be avatar, gallery, or document');
    }
    if (!contentType || !ALLOWED_TYPES.has(contentType)) {
      throw badRequest('contentType must be a supported image type');
    }
    if (!fileName?.trim()) {
      throw badRequest('fileName is required');
    }

    const ext = EXT_BY_TYPE[contentType] || path.extname(fileName) || '.jpg';
    const storedName = `${uuidv4()}${ext}`;
    const base = publicApiV1Base(req);

    res.json({
      uploadUrl: `${base}/media/upload`,
      publicUrl: `${base}/media/files/${storedName}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      fileName: storedName,
    });
  }),
);

router.post(
  '/upload',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        next(badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5 MB)' : err.message));
        return;
      }
      if (err?.message === 'INVALID_IMAGE_TYPE') {
        next(badRequest('Only JPEG, PNG, WebP, and GIF images are allowed'));
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
    if (!req.file) {
      throw badRequest('file is required');
    }

    res.status(201).json({
      publicUrl: `${publicApiV1Base(req)}/media/files/${req.file.filename}`,
    });
  }),
);

router.get('/files/:filename', (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    return;
  }

  res.sendFile(filePath, (err) => {
    if (err) next(err);
  });
});

module.exports = router;
