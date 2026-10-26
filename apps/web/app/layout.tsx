import type {Metadata, Viewport} from 'next';
import type {ReactNode} from 'react';
import './globals.css';
import {themeBootstrap} from '../lib/theme-bootstrap';
import {soundKinds} from '../lib/sounds';
import {Footer} from '../components/footer';

export const metadata: Metadata = {
  title: 'Vote Machine',
  description: 'Система голосования',
};

// Keep the phone layout at one scale as requested by the owner
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: 'resizes-content',
};

// Set the page language and shared styles
export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="ru" className="overscroll-none" suppressHydrationWarning>
      <head>
        {soundKinds.map((kind) => (
          <link
            key={kind}
            rel="preload"
            href={`/sounds/${kind}.mp3`}
            as="fetch"
            crossOrigin="anonymous"
          />
        ))}
        <script dangerouslySetInnerHTML={{__html: themeBootstrap}} />
      </head>
      <body className="relative min-h-svh touch-pan-x touch-pan-y bg-page font-sans text-ink antialiased">
        {children}
        <Footer />
      </body>
    </html>
  );
}
