import type {NextConfig} from 'next';

const config: NextConfig = {
  // Build a server for the web container
  output: 'standalone',
  // Do not send the framework name in replies
  poweredByHeader: false,
  // Add basic privacy headers to every page
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {key: 'Referrer-Policy', value: 'no-referrer'},
          {key: 'X-Content-Type-Options', value: 'nosniff'},
          {key: 'X-Frame-Options', value: 'DENY'},
        ],
      },
    ];
  },
};

export default config;
