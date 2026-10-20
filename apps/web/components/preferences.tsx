'use client';
import {useEffect, useState} from 'react';
import {Moon, Sun, Volume2, VolumeX} from 'lucide-react';
import {Button} from './ui/button';
import {prepareSounds, setSoundEnabled, unlockSound} from '../lib/audio';
let themeTimer: ReturnType<typeof setTimeout> | undefined;
// Only changes after the first paint need a transition
function applyTheme(next: 'light' | 'dark') {
  const root = document.documentElement;
  if (root.dataset.theme === next) return;
  if (root.dataset.theme) {
    root.classList.add('theme-changing');
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => root.classList.remove('theme-changing'), 350);
  }
  root.dataset.theme = next;
}
// Keep theme personal, the room palette is managed separately
export function Preferences() {
  const [sound, setSound] = useState(false);
  useEffect(() => {
    void prepareSounds();
    window.addEventListener('pointerdown', unlockSound);
    window.addEventListener('keydown', unlockSound);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      try {
        const stored = localStorage.getItem('vm-theme');
        applyTheme(
          stored === 'light' || stored === 'dark'
            ? stored
            : media.matches
              ? 'dark'
              : 'light',
        );
      } catch {
        applyTheme(media.matches ? 'dark' : 'light');
      }
    };
    void Promise.resolve().then(() => {
      try {
        const value = localStorage.getItem('vm-sounds') === 'on';
        setSound(value);
        setSoundEnabled(value);
      } catch {}
    });
    sync();
    media.addEventListener('change', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('pointerdown', unlockSound);
      window.removeEventListener('keydown', unlockSound);
      media.removeEventListener('change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  // Animate only deliberate changes, never initial page loading
  function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem('vm-theme', next);
    } catch {}
  }
  return (
    <div
      className="inline-flex shrink-0 items-center gap-1"
      aria-label="Вид и звук"
    >
      <Button
        variant="ghost"
        aria-label={sound ? 'Выключить звуки' : 'Включить звуки'}
        aria-pressed={sound}
        title={sound ? 'Выключить звуки' : 'Включить звуки'}
        onClick={() => {
          setSoundEnabled(!sound, true);
          setSound(!sound);
          try {
            localStorage.setItem('vm-sounds', sound ? 'off' : 'on');
          } catch {}
        }}
      >
        {sound ? <Volume2 /> : <VolumeX />}
      </Button>
      <Button
        variant="ghost"
        aria-label="Переключить тему"
        title="Переключить светлую и темную тему"
        onClick={toggleTheme}
      >
        <Sun className="theme-sun" />
        <Moon className="theme-moon" />
      </Button>
    </div>
  );
}
