"use client";

/**
 * Consent-safe GA4 event helper for the public marketing pages.
 *
 * `window.gtag` only exists after the user accepts the analytics consent
 * banner (see components/analytics-consent.tsx) — before that, or when the
 * user declined, this is a no-op. Never import from `(app)` routes: analytics
 * deliberately never loads inside the app.
 */
export function trackEvent(
  name: string,
  params?: Record<string, string | number | boolean>,
) {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    gtag?: (...args: unknown[]) => void;
  };
  w.gtag?.("event", name, params);
}

/**
 * Map a clicked anchor's href to a GA4 event name. Centralized so public
 * pages don't need per-link markup: the delegated listener in
 * AnalyticsConsent calls this for every anchor click. An explicit
 * `data-ga-event` attribute on the anchor overrides the inference.
 */
export function inferCtaEvent(href: string): string | null {
  if (href.includes("tab=register")) return "register_click";
  if (href.includes("/try-demo")) return "try_demo_click";
  if (href.includes("github.com/finlynq")) return "github_click";
  if (href.includes("apps.apple.com")) return "app_store_click";
  if (href.includes("play.google.com")) return "play_store_click";
  return null;
}
