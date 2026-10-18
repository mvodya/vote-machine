import {randomBytes} from 'node:crypto';
import {readFile, writeFile, chmod} from 'node:fs/promises';

const path = new URL('../.env', import.meta.url);
let source = await readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
// Keep existing keys so saved links remain usable
function ensure(name, value, allowEmpty = false) {
  const pattern = new RegExp(`^${name}=(.*)$`, 'm');
  const match = source.match(pattern);
  if (match && (match[1].trim() || allowEmpty)) return;
  const line = `${name}=${value}`;
  source = match
    ? source.replace(pattern, line)
    : `${source}${source.endsWith('\n') || !source ? '' : '\n'}${line}\n`;
}
ensure('COMPOSE_PROFILES', 'local-storage', true);
ensure('ADMIN_LINK_KEY', randomBytes(32).toString('hex'));
ensure('MEDIA_WORKER_KEY', randomBytes(32).toString('hex'));
ensure('GARAGE_RPC_SECRET', randomBytes(32).toString('hex'));
ensure('S3_ACCESS_KEY', `GK${randomBytes(16).toString('hex')}`);
ensure('S3_SECRET_KEY', randomBytes(32).toString('hex'));
ensure('S3_ENDPOINT', 'http://garage:3900');
ensure('S3_REGION', 'garage');
ensure('S3_BUCKET', 'votebox-assets');
await writeFile(path, source, {mode: 0o600});
await chmod(path, 0o600);
console.log('Local environment is ready');
