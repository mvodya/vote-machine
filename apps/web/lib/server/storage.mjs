import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

let client;
// Create one shared client without reading secrets during the web build
function storage() {
  if (client) return client;
  const endpoint = new URL(process.env.S3_ENDPOINT ?? 'http://garage:3900');
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !process.env.S3_ACCESS_KEY ||
    !process.env.S3_SECRET_KEY ||
    !process.env.S3_BUCKET
  )
    throw new Error('Storage is not configured');
  client = new S3Client({
    endpoint: endpoint.toString(),
    region: process.env.S3_REGION ?? 'garage',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
  });
  return client;
}
// Keep uploaded objects private and use only generated keys
export async function putObject(key, body, mime, signal) {
  return storage().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: mime,
      CacheControl: 'no-store',
    }),
    {abortSignal: signal},
  );
}
// Range reads let the browser seek through a video
export async function getObject(key, range, signal) {
  return storage().send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ...(range ? {Range: range} : {}),
    }),
    {abortSignal: signal},
  );
}
// Deleting a missing key is safe to repeat after a worker restart
export async function deleteObject(key, signal) {
  return storage().send(
    new DeleteObjectCommand({Bucket: process.env.S3_BUCKET, Key: key}),
    {abortSignal: signal},
  );
}

// Check an object without reading its bytes
export async function headObject(key, signal) {
  return storage().send(
    new HeadObjectCommand({Bucket: process.env.S3_BUCKET, Key: key}),
    {abortSignal: signal},
  );
}
