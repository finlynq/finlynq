import { APP_STORE_URL, PLAY_STORE_URL } from "@/lib/app-stores";

/**
 * Official-style "Download on the App Store" / "Get it on Google Play" badge
 * links. Logos are inline SVG (CSP-safe — no external images, no inline
 * styles; SVG `fill` is a presentation attribute, not `style`). Black badges
 * read correctly on both light and dark themes, per Apple/Google brand guidance.
 */
export function StoreBadges({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <a
        href={APP_STORE_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="Download Finlynq on the App Store"
        className="inline-flex items-center gap-2.5 rounded-xl border border-white/15 bg-black px-4 py-2.5 text-white no-underline transition hover:border-white/40"
      >
        <AppleLogo />
        <span className="flex flex-col leading-none">
          <span className="text-[10px] font-medium opacity-80">
            Download on the
          </span>
          <span className="text-[17px] font-semibold tracking-tight">
            App Store
          </span>
        </span>
      </a>
      <a
        href={PLAY_STORE_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="Get Finlynq on Google Play"
        className="inline-flex items-center gap-2.5 rounded-xl border border-white/15 bg-black px-4 py-2.5 text-white no-underline transition hover:border-white/40"
      >
        <GooglePlayLogo />
        <span className="flex flex-col leading-none">
          <span className="text-[10px] font-medium uppercase tracking-wide opacity-80">
            Get it on
          </span>
          <span className="text-[17px] font-semibold tracking-tight">
            Google Play
          </span>
        </span>
      </a>
    </div>
  );
}

function AppleLogo() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 384 512"
      className="h-7 w-7 shrink-0"
      fill="currentColor"
    >
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM262.1 104.5c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

function GooglePlayLogo() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 512 512"
      className="h-6 w-6 shrink-0"
    >
      <path
        d="M48 59.49v393a4.33 4.33 0 0 0 7.37 3.07L260 256 55.37 56.42A4.33 4.33 0 0 0 48 59.49z"
        fill="#00e0ff"
      />
      <path
        d="M345.8 174 89.22 28.16l-.06 0c-5-2.85-9.93-3.18-14.5-.95L260 256z"
        fill="#00f076"
      />
      <path
        d="M345.8 338 260 256 74.66 441.74c4.57 2.23 9.49 1.9 14.5-.95l.07 0L345.8 338z"
        fill="#ff3a44"
      />
      <path
        d="M412.06 221.91 345.81 174 260 256l85.81 82 66.25-47.91c14.58-10.55 14.58-46.63 0-57.18z"
        fill="#ffc900"
      />
    </svg>
  );
}
