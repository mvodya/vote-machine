import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vote Machine',
  description: 'Система голосования',
};

// Set the page language and shared styles
export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="ru">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
