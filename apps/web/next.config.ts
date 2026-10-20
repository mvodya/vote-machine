import type {NextConfig} from 'next';
import {fileURLToPath} from 'node:url';
import {buildCommit} from './lib/server/build-version.mjs';

const config: NextConfig = {
  // Resolve once while building, the runtime image does not need Git
  env: {
    NEXT_PUBLIC_GIT_COMMIT: buildCommit(
      process.env.BUILD_SOURCE_ROOT ??
        fileURLToPath(new URL('../..', import.meta.url)),
      process.env.GIT_COMMIT ?? process.env.GITHUB_SHA,
    ),
  },
  // Build a server for the web container
  output: 'standalone',
  // The cleanup worker shares these server packages
  serverExternalPackages: ['@aws-sdk/client-s3', 'sharp'],
  // Do not send the framework name in replies
  poweredByHeader: false,
  // Add basic privacy headers to every page
  async headers() {
    return [
      {
        source: '/rooms/:path*',
        headers: [{key: 'Cache-Control', value: 'private, no-store'}],
      },
      {
        source: '/vote/:path*',
        headers: [{key: 'Cache-Control', value: 'private, no-store'}],
      },
      {
        source: '/:path*',
        headers: [
          {key: 'Referrer-Policy', value: 'no-referrer'},
          {key: 'X-Content-Type-Options', value: 'nosniff'},
          {key: 'X-Frame-Options', value: 'DENY'},
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default config;
