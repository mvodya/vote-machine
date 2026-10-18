import {setTimeout as delay} from 'node:timers/promises';
import {deleteObject} from '../lib/server/storage.mjs';

const controller = new AbortController();
// Stop between jobs and release leases through their normal retry period
function stop() {
  controller.abort();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// Only the server worker key may claim and acknowledge deletion jobs
async function request(body) {
  const response = await fetch(
    new URL(
      '/internal/assets/cleanup',
      process.env.API_ORIGIN ?? 'http://api:8080',
    ),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Media-Worker': process.env.MEDIA_WORKER_KEY ?? '',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    },
  );
  if (!response.ok) throw new Error('Cleanup unavailable');
  return response.json();
}
// Delete outside database transactions and acknowledge only after S3 succeeds
export async function cleanOnce() {
  const body = await request({action: 'claim'});
  if (!Array.isArray(body.jobs)) throw new Error('Invalid jobs');
  for (const job of body.jobs) {
    if (controller.signal.aborted) break;
    try {
      await deleteObject(
        job.objectKey,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      );
      await request({action: 'ack', id: job.id, token: job.token});
    } catch {
      if (!controller.signal.aborted)
        console.error('Asset cleanup job will retry');
    }
  }
}
// Imports from integration tests must not start an endless worker
if (import.meta.main) {
  while (!controller.signal.aborted) {
    try {
      await cleanOnce();
    } catch {
      if (!controller.signal.aborted) console.error('Asset cleanup will retry');
    }
    try {
      await delay(60000, undefined, {signal: controller.signal});
    } catch {
      break;
    }
  }
}
