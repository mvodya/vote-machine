import http from 'node:http';
import {spawn} from 'node:child_process';

// Keep a real loopback origin so secure browser APIs match local development
const server = http.createServer((request, response) => {
  const upstream = http.request(
    {
      hostname: 'web',
      port: 3000,
      path: request.url,
      method: request.method,
      headers: request.headers,
      agent: false,
    },
    (reply) => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(503);
      response.end();
    } else response.destroy();
  });
  response.on('close', () => upstream.destroy());
  request.on('error', () => upstream.destroy());
  request.pipe(upstream);
});
await new Promise((resolve) => server.listen(3000, '127.0.0.1', resolve));
const child = spawn(
  process.execPath,
  [
    'apps/web/node_modules/@playwright/test/cli.js',
    'test',
    '--config=apps/web/playwright.config.ts',
    '--project=firefox',
    '--output=/results/firefox-linux',
  ],
  {
    stdio: 'inherit',
    env: {...process.env, TEST_BASE_URL: 'http://127.0.0.1:3000'},
  },
);
child.on('error', () => {
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
  server.closeAllConnections();
  server.close();
});
