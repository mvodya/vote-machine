import styles from './hero-brand.module.css';

// Share the flying logo and wordmark across both public pages
export function HeroBrand({
  heading = false,
}: {
  // The landing owns the page heading, home already has a form heading
  heading?: boolean;
}) {
  const Name = heading ? 'h1' : 'div';
  return (
    <div data-hero-brand className="@container w-full min-w-0">
      <div className="relative flex items-center gap-[clamp(1rem,2.5cqw,2rem)]">
        {/* Keep the supplied artwork as a normal static asset */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/votemachine-icon.svg"
          width={160}
          height={160}
          alt=""
          className={`${styles.icon} size-[clamp(3rem,12cqw,10rem)] shrink-0`}
        />
        <Name className="text-[clamp(2rem,12cqw,10rem)] leading-[0.95] font-semibold tracking-[-0.085em]">
          vote<span className="font-light text-primary">machine</span>
        </Name>
      </div>
    </div>
  );
}
