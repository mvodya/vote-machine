import {spawn} from 'node:child_process';
import {createIngress, gatewayKey} from '../lib/server/ingress.mjs';
const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT ?? 3000);
const targetPort = Number(process.env.NEXT_INTERNAL_PORT ?? 3002);
if (
  !Number.isInteger(port) ||
  !Number.isInteger(targetPort) ||
  port < 1 ||
  targetPort < 1 ||
  port > 65535 ||
  targetPort > 65535 ||
  port === targetPort
)
  throw new Error('Invalid web ports');
let stopping = false;
const ingress = createIngress({
  targetPort,
  apiOrigin: process.env.API_ORIGIN ?? 'http://api:8080',
  gatewayKey: gatewayKey(process.env),
  publicOrigin: process.env.PUBLIC_ORIGIN,
});
// The framework listens only inside this process namespace
const child = spawn(
  dev ? 'pnpm' : process.execPath,
  dev
    ? [
        '--filter',
        '@vote-machine/web',
        'exec',
        'next',
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(targetPort),
      ]
    : ['apps/web/server.js'],
  {
    stdio: 'inherit',
    detached: dev,
    env: {...process.env, PORT: String(targetPort), HOSTNAME: '127.0.0.1'},
  },
);
ingress.listen(port, '0.0.0.0');
// Stop streaming connections and the framework child together
function stop(signal) {
  stopping = true;
  ingress.closeAllConnections();
  ingress.close();
  if (dev) {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  } else child.kill(signal);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('error', () => {
  console.error('Web server could not start');
  process.exitCode = 1;
  ingress.close();
});
child.on('exit', (code) => {
  ingress.closeAllConnections();
  ingress.close();
  process.exitCode = stopping ? 0 : (code ?? 1);
});
