import { Nav } from "@/components/nav";
import { UnlockGate } from "@/components/unlock-gate";
import { DonationBanner } from "@/components/donation-banner";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <UnlockGate>
      <div className="relative flex min-h-screen flex-col">
        <DonationBanner />
        <div className="flex flex-1">
          <Nav />
          <main className="flex-1 overflow-auto pb-16 md:pb-0 bg-dot-pattern ambient-glow">
            <div className="relative z-10 mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </UnlockGate>
  );
}
