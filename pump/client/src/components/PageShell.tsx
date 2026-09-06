import type { ReactNode } from "react";
import { MobileTabs, Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { cn } from "@/lib/utils";

/**
 * Standard page frame: sticky Navbar, centered content column, Footer.
 * Leaves room at the bottom for the mobile tab bar.
 */
export function PageShell({
  children,
  className,
  wide = false,
  noFooter = false,
  noHeader = false,
}: {
  children: ReactNode;
  className?: string;
  /** max-w-screen-2xl instead of max-w-7xl (coin page, home grid) */
  wide?: boolean;
  noFooter?: boolean;
  /** Drops the top bar — a screen that is somebody's page, not a section of the app. */
  noHeader?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {!noHeader && <Navbar />}
      {noHeader && <MobileTabs />}
      <main
        className={cn(
          "mx-auto w-full px-4 py-6 pb-24 md:pb-10",
          wide ? "max-w-screen-2xl" : "max-w-7xl",
          className,
        )}
      >
        {children}
      </main>
      {!noFooter && <Footer />}
      {/* Spacer so the fixed mobile tab bar never covers the footer */}
      <div className="pb-nav md:hidden" aria-hidden />
    </div>
  );
}
