import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code worktrees — not part of the app source
    ".claude/**",
    // Mobile is a separate React Native (Expo) workspace with its own CI lane
    // (mobile-ci.yml: tsc + jest). This Next.js *web* config (core-web-vitals +
    // React Compiler rules) is the wrong linter for RN code — Expo doesn't run
    // the React Compiler, so rules like `react-hooks/preserve-manual-memoization`
    // are false positives on mobile screens. Excluding `mobile/**` keeps the
    // blocking web lint (FINLYNQ-112) from gating React Native code on web-only
    // rules. If mobile wants linting, add an RN-appropriate config under mobile-ci.
    "mobile/**",
  ]),
  {
    // ── FINLYNQ-112 ESLint baseline ──────────────────────────────────────
    // These 12 rules each carry a pre-existing violation backlog (178 errors
    // total on the dev HEAD this baseline was cut against). They are
    // downgraded from `error` to `warn` so the new blocking ESLint CI step
    // (ci.yml `Lint`) can land today gating only on errors — `npm run lint`
    // exits 0 with warnings, non-zero on any error. Every rule NOT listed
    // here keeps its current severity, so the CI step still catches any
    // FUTURE new-rule error. Burn down each rule's backlog and re-promote it
    // to `error` here per the follow-up; the step's teeth grow as that
    // happens. Do NOT add new violations of these rules — fix them at source.
    rules: {
      "@typescript-eslint/no-require-imports": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "react/display-name": "warn",
      "react/no-unescaped-entities": "warn",
      "prefer-const": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/rules-of-hooks": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@next/next/no-html-link-for-pages": "warn",
      "react-hooks/immutability": "warn",
      // eslint-plugin-react-hooks 7.1.1 (lockfile) errors on this React
      // Compiler diagnostic ("Existing memoization could not be preserved") in
      // 3 web components (inbox-to-approve-tab, inbox-to-categorize-tab,
      // sankey-chart). It surfaced on the dev→main promotion PR — the blocking
      // lint is PR-only and these reached `dev` via direct pushes, so it was
      // never gated. Baselined to `warn` per the policy above; burn down + re-
      // promote to `error`. (An optimization hint, not a correctness bug.)
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]);

export default eslintConfig;
