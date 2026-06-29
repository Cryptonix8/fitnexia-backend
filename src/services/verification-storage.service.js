const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const LOCAL_ROOT = path.join(__dirname, '../../private-uploads/verification');
const STORAGE_MODE = (process.env.VERIFICATION_STORAGE || 'local').toLowerCase();

function ensureLocalRoot() {
  if (!fs.existsSync(LOCAL_ROOT)) {
    fs.mkdirSync(LOCAL_ROOT, { recursive: true });
  }
}

function buildStorageKey(subjectType, subjectId, documentType, ext) {
  return `${subjectType}/${subjectId}/${documentType}-${uuidv4()}${ext}`;
}

function extForMime(mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
  };
  return map[mime] || '.bin';
}

async function getS3Client() {
  const region = process.env.AWS_REGION || process.env.S3_REGION;
  const bucket = process.env.VERIFICATION_S3_BUCKET || process.env.S3_BUCKET;
  if (!region || !bucket) {
    throw new Error('S3 storage requires AWS_REGION and VERIFICATION_S3_BUCKET');
  }
  let S3Client;
  let PutObjectCommand;
  let GetObjectCommand;
  try {
    ({ S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3'));
  } catch {
    throw new Error('Install @aws-sdk/client-s3 for VERIFICATION_STORAGE=s3');
  }
  const client = new S3Client({ region });
  return { client, bucket, PutObjectCommand, GetObjectCommand };
}

async function saveDocument({ subjectType, subjectId, documentType, buffer, mimeType }) {
  const ext = extForMime(mimeType);
  const storageKey = buildStorageKey(subjectType, subjectId, documentType, ext);

  if (STORAGE_MODE === 's3') {
    const { client, bucket, PutObjectCommand } = await getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
    return storageKey;
  }

  ensureLocalRoot();
  const fullPath = path.join(LOCAL_ROOT, storageKey);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, buffer);
  return storageKey;
}

async function readDocument(storageKey) {
  if (STORAGE_MODE === 's3') {
    const { client, bucket, GetObjectCommand } = await getS3Client();
    const res = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: storageKey,
      }),
    );
    const chunks = [];
    for await (const chunk of res.Body) {
      chunks.push(chunk);
    }
    return {
      buffer: Buffer.concat(chunks),
      mimeType: res.ContentType || 'application/octet-stream',
    };
  }

  const fullPath = path.join(LOCAL_ROOT, storageKey);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return {
    buffer: fs.readFileSync(fullPath),
    mimeType: undefined,
  };
}

module.exports = {
  saveDocument,
  readDocument,
  LOCAL_ROOT,
};
