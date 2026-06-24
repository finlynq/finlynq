import { ImageResponse } from "next/og";

// Sitewide default Open Graph image. Next.js automatically attaches this to the
// OG/Twitter metadata of every route that doesn't define its own. Rendered to
// PNG server-side (not subject to the page CSP). Uses the bundled default font
// so there's no font-fetch step.
export const alt =
  "Finlynq: open-source personal finance with a first-party MCP server";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0b0e11",
          padding: "72px 80px",
          color: "#e8eaed",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 26,
            letterSpacing: 4,
            color: "#f5a623",
            fontWeight: 700,
          }}
        >
          OPEN SOURCE · MCP-FIRST · ENCRYPTED
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 116,
              fontWeight: 800,
              letterSpacing: -2,
              color: "#ffffff",
            }}
          >
            Finlynq
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 44,
              marginTop: 18,
              color: "#9aa3ad",
              maxWidth: 940,
            }}
          >
            Track your money here, analyze it anywhere.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            fontSize: 28,
            color: "#6b737d",
          }}
        >
          AGPL v3 · self-host with Docker or free cloud · finlynq.com
        </div>
      </div>
    ),
    { ...size }
  );
}
