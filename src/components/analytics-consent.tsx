"use client";

/**
 * Analytics consent banner + consent-gated Google Analytics loader.
 *
 * Replaces the unconditional <GoogleAnalytics /> on public marketing pages.
 * Required for ePrivacy / GDPR compliance: GA cookies are non-essential, so
 * they cannot load until the user explicitly opts in.
 *
 * Persistence: localStorage key "finlynq:analytics-consent" in
 * {"accepted", "declined"}. Absence = banner is shown. Choice persists
 * across sessions on the same browser; user can change it from /privacy.
 */

import { useEffect, useState } from "react";
import Script from "next/script";

const GA_MEASUREMENT_ID = "G-ZDQJXS0C3Z";
const STORAGE_KEY = "finlynq:analytics-consent";

type Consent = "accepted" | "declined" | "unset";

function readConsent(): Consent {
  if (typeof window === "undefined") return "unset";
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === "accepted" || v === "declined") return v;
  return "unset";
}

function writeConsent(value: "accepted" | "declined") {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, value);
  window.dispatchEvent(new Event("finlynq:analytics-consent"));
}

function useConsent() {
  const [consent, setConsent] = useState<Consent>("unset");

  useEffect(() => {
    setConsent(readConsent());
    const onChange = () => setConsent(readConsent());
    window.addEventListener("finlynq:analytics-consent", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("finlynq:analytics-consent", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return consent;
}

function GoogleAnalyticsScripts() {
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

function ConsentBanner({ onChoice }: { onChoice: (v: "accepted" | "declined") => void }) {
  // All-static styles migrated to Tailwind atomic classes (FINLYNQ-83 phase 2).
  // Arbitrary-color values are kept literal (the banner is intentionally dark
  // theme regardless of route) — they would otherwise pull in the (app)
  // theme palette and clash with the public marketing pages.
  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Analytics cookies"
      className="fixed left-0 right-0 bottom-0 z-[9999] bg-[#0e1116] border-t border-[#2a3139] text-[#e8eaed] px-[18px] py-[14px] shadow-[0_-8px_24px_rgba(0,0,0,0.35)]"
    >
      <div className="max-w-[1100px] mx-auto flex gap-[18px] items-center flex-wrap text-[13px] leading-[1.45]">
        <p className="flex-[1_1_320px] m-0 text-[#cdd2d8]">
          We use Google Analytics on our public marketing pages to understand
          which posts bring people here. We don&apos;t use any analytics inside
          the app itself, and we never sell your data. You can decline below
          and the page works fine.{" "}
          <a href="/privacy" className="text-[#f5a623] underline">
            Privacy policy
          </a>
          .
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChoice("declined")}
            className="bg-transparent text-[#9aa3ad] border border-[#2a3139] px-[14px] py-2 rounded-md cursor-pointer text-[13px]"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => onChoice("accepted")}
            className="bg-[#f5a623] text-[#0e1116] border border-[#f5a623] px-[14px] py-2 rounded-md cursor-pointer text-[13px] font-semibold"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

export function AnalyticsConsent() {
  const consent = useConsent();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  if (!hydrated) return null;

  return (
    <>
      {consent === "accepted" && <GoogleAnalyticsScripts />}
      {consent === "unset" && (
        <ConsentBanner onChoice={(v) => writeConsent(v)} />
      )}
    </>
  );
}

export function setAnalyticsConsent(value: "accepted" | "declined") {
  writeConsent(value);
}

export function getAnalyticsConsent(): Consent {
  return readConsent();
}
