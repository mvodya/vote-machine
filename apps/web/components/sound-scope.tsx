'use client';
import {createContext, useContext, type ReactNode} from 'react';

const Muted = createContext(false);

// Silence local examples without changing the saved sound preference
export function SoundScope({
  muted,
  children,
}: {
  muted: boolean;
  children: ReactNode;
}) {
  return <Muted value={muted}>{children}</Muted>;
}

// Real room widgets stay audible outside a muted scope
export function useSoundsMuted() {
  return useContext(Muted);
}
