import {DotWaves} from './dot-waves';
import styles from './hero-background.module.css';

// Share the same waves, glow and orbits on both public pages
export function HeroBackground() {
  return (
    <div
      data-hero-background
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-70"
    >
      <DotWaves />
      <div className={styles.glow} />
      <div className={styles.orbit} />
      <div className={styles.orbitTwo} />
    </div>
  );
}
