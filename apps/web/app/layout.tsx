import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import './globals.css';
import {themeBootstrap} from '../lib/theme-bootstrap';
import {soundKinds} from '../lib/sounds';
import {Footer} from '../components/footer';

export const metadata: Metadata = {
  title: 'Vote Machine',
  description: 'Система голосования',
};

// Set the page language and shared styles
export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="ru" suppressHydrationWarning>
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
      <body className="relative min-h-svh bg-page font-sans text-ink antialiased">
        {children}
        <Footer />
      </body>
    </html>
  );
}
