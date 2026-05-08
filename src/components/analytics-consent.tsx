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
  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Analytics cookies"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: "#0e1116",
        borderTop: "1px solid #2a3139",
        color: "#e8eaed",
        padding: "14px 18px",
        boxShadow: "0 -8px 24px rgba(0,0,0,0.35)",
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          display: "flex",
          gap: 18,
          alignItems: "center",
          flexWrap: "wrap",
          fontSize: 13,
          lineHeight: 1.45,
        }}
      >
        <p style={{ flex: "1 1 320px", margin: 0, color: "#cdd2d8" }}>
          We use Google Analytics on our public marketing pages to understand
          which posts bring people here. We don&apos;t use any analytics inside
          the app itself, and we never sell your data. You can decline below
          and the page works fine.{" "}
          <a
            href="/privacy"
            style={{ color: "#f5a623", textDecoration: "underline" }}
          >
            Privacy policy
          </a>
          .
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => onChoice("declined")}
            style={{
              background: "transparent",
              color: "#9aa3ad",
              border: "1px solid #2a3139",
              padding: "8px 14px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => onChoice("accepted")}
            style={{
              background: "#f5a623",
              color: "#0e1116",
              border: "1px solid #f5a623",
              padding: "8px 14px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
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
