import {spawn} from 'node:child_process';

const child = spawn(
  process.execPath,
  ['apps/web/scripts/web-server.mjs', '--dev'],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
// Forward shutdown to the development server
function stop(signal) {
  child.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', () => {
  console.error('Web development server could not start');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
