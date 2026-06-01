import { Nav } from "@/components/nav";
import { UnlockGate } from "@/components/unlock-gate";
import { DonationBanner } from "@/components/donation-banner";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { CurrencyProvider } from "@/components/currency-provider";
import { DropdownOrderProvider } from "@/components/dropdown-order-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <UnlockGate>
      <CurrencyProvider>
        <DropdownOrderProvider>
        <div className="relative flex min-h-screen flex-col">
          <DonationBanner />
          <AnnouncementBanner />
          <div className="flex flex-1">
            <Nav />
            <main className="flex-1 overflow-auto pb-16 md:pb-0 bg-dot-pattern ambient-glow">
              {/* FINLYNQ-52: no width cap on the (app) shell — content fills
                  the viewport to the right of the sidebar. Per-page wrappers
                  may still impose their own readability cap (e.g. settings,
                  api-docs); the shell does not. */}
              <div className="relative z-10 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                {children}
              </div>
            </main>
          </div>
        </div>
        </DropdownOrderProvider>
      </CurrencyProvider>
    </UnlockGate>
  );
}
