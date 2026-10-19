import type {NextConfig} from 'next';

const config: NextConfig = {
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
