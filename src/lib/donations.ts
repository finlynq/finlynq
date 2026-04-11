export const DONATION_LINKS = {
  github: process.env.NEXT_PUBLIC_DONATION_GITHUB ?? "https://github.com/sponsors/finlynq",
  kofi: process.env.NEXT_PUBLIC_DONATION_KOFI ?? "https://ko-fi.com/finlynq",
  repo: process.env.NEXT_PUBLIC_GITHUB_REPO ?? "https://github.com/finlynq/finlynq",
} as const;
