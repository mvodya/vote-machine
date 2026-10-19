import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import './globals.css';
import {themeBootstrap} from '../lib/theme-bootstrap';

export const metadata: Metadata = {
  title: 'Vote Machine',
  description: 'Система голосования',
};

// Set the page language and shared styles
export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{__html: themeBootstrap}} />
      </head>
      <body className="bg-page font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
