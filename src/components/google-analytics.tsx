"use client";

import Script from "next/script";

const GA_MEASUREMENT_ID = "G-ZDQJXS0C3Z";

/**
 * Google Analytics loader for the public marketing pages.
 *
 * CSP nonce: Next.js auto-extracts the per-request nonce from the
 * `Content-Security-Policy` header (set by middleware — B10 / finding C-8)
 * and applies it to framework-emitted scripts including those rendered
 * via `next/script`. We rely on that auto-propagation rather than reading
 * `headers()` here, because this component is rendered inside `"use client"`
 * marketing pages where async server components can't be imported.
 *
 * The 'strict-dynamic' source in `script-src` then propagates trust from
 * the nonce'd inline gtag bootstrap to the gtag.js loader and beyond.
 */
export function GoogleAnalytics() {
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_MEASUREMENT_ID}');
        `}
      </Script>
    </>
  );
}
