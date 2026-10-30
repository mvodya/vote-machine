'use client';
import type {CSSProperties} from 'react';
import {Sparkle} from 'lucide-react';
import styles from './landing.module.css';

// Seeded values keep the server and browser markup identical
const sparks = Array.from({length: 48}, (_, index) => {
  let seed = Math.imul(index + 73, 2654435761) >>> 0;
  seed ^= seed >>> 16;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const angle = random() * Math.PI * 2;
  const start = 138 + random() * 12;
  const end = 195 + random() * 65;
  const size = `${(7 + random() * 6).toFixed(2)}px`;
  // Round coordinates because math engines can differ in the last decimal
  return {
    '--spark-x': `${(Math.cos(angle) * start).toFixed(2)}px`,
    '--spark-y': `${(Math.sin(angle) * start).toFixed(2)}px`,
    '--spark-end-x': `${(Math.cos(angle) * end).toFixed(2)}px`,
    '--spark-end-y': `${(Math.sin(angle) * end).toFixed(2)}px`,
    animationDelay: `${(-random() * 6).toFixed(2)}s`,
    animationDuration: `${(1.8 + random() * 2).toFixed(2)}s`,
    width: size,
    height: size,
  } as CSSProperties;
});

// Scatter small white stars without adding moving parts to the QR image
export function QrSparks() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {sparks.map((style, index) => (
        <Sparkle key={index} className={styles.qrSpark} style={style} />
      ))}
    </div>
  );
}
