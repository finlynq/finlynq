import type { Metadata } from "next";

export const metadata: Metadata = {
  description:
    "Log in or register for Finlynq's free managed cloud. No infrastructure to manage. Same code as the self-hosted edition.",
};

export default function CloudLayout({ children }: { children: React.ReactNode }) {
  return children;
}
