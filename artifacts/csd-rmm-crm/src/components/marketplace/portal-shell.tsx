import { useEffect } from "react";
import { useTheme } from "next-themes";
import { Link } from "wouter";
import { ArrowLeft, Cpu, PlusCircle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

type Props = {
  children: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  showSell?: boolean;
  width?: "narrow" | "wide";
  offerMode?: boolean;
};

// Page frame for the public marketplace: deep-black grid canvas, carbon
// panels, laser-red accents — "mission control" rather than the light
// portal look. While mounted it flips <html> to .dark so shadcn popovers and
// selects (which portal to <body>) match the page, then hands the class back
// to whatever the staff theme setting says on the way out.
export default function MarketplaceShell({ children, backHref = "/portal", backLabel = "Back to Portal", showSell = true, width = "wide", offerMode = false }: Props) {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    return () => { if (resolvedTheme !== "dark") root.classList.remove("dark"); };
  }, [resolvedTheme]);

  return (
    <div className="cyber cyber-grid min-h-screen text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/portal" className="shrink-0 rounded bg-white/95 px-1.5 py-1" data-testid="link-portal-logo">
              <img src={csdLogo} alt="Computer Systems Depot" className="h-7" />
            </Link>
            <div className="hidden sm:block h-6 w-px bg-zinc-800" />
            <Link href="/portal/marketplace" className="flex items-center gap-2 min-w-0" data-testid="link-marketplace-home">
              <span className="relative flex h-8 w-8 items-center justify-center rounded-md border border-red-500/40 bg-red-600/10 text-red-500 glow-red">
                <Cpu className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block font-bold tracking-tight text-white truncate leading-tight">Tech-Swap</span>
                <span className="hidden sm:block text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-400 leading-tight">Community Marketplace</span>
              </span>
            </Link>
          </div>
          {showSell && (
            <Button asChild className="bg-red-600 hover:bg-red-500 text-white shrink-0 glow-red font-semibold">
              <Link href="/portal/marketplace/sell" data-testid="button-sell-item">
                <PlusCircle className="h-4 w-4 mr-2" /> List an item
              </Link>
            </Button>
          )}
        </div>
      </header>

      <div className="border-b border-red-900/40 bg-red-950/30">
        <p className="mx-auto max-w-7xl px-4 sm:px-6 py-2 flex items-center gap-2 text-xs text-red-200/90" data-testid="text-p2p-banner">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
          {offerMode ? <span><span className="font-semibold text-red-300">Direct from CSD.</span> This is a first-party offer, not a community listing.</span> : <span><span className="font-semibold text-red-300">Free Peer-to-Peer Community Listing.</span> Verify hardware prior to purchase.</span>}
        </p>
      </div>

      <main className={width === "wide" ? "mx-auto max-w-7xl px-4 sm:px-6 py-6" : "mx-auto max-w-3xl px-4 sm:px-6 py-6"}>
        <Link href={backHref} className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-red-400 mb-5 transition" data-testid="link-back">
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Link>
        {children}
      </main>

      <footer className="mx-auto max-w-7xl px-4 sm:px-6 py-8 text-center text-xs text-zinc-500 font-mono">
        <span className="text-zinc-600">[</span> Computer Systems Depot · 954-637-7300 · {offerMode ? "Offers sold directly by CSD" : "Listings are posted by customers and reviewed by our team"} <span className="text-zinc-600">]</span>
      </footer>
    </div>
  );
}
