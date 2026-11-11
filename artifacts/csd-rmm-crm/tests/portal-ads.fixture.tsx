import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import PortalAdPopup from "../src/components/portal/portal-ad-popup";
import { MarketingPortalAds } from "../src/components/marketing/marketing-portal-ads";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

declare global {
  interface Window { adEvents: Array<{ type: string; adId: number; reason?: string }> }
}
window.adEvents = [];

const view = new URLSearchParams(window.location.search).get("view");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {view === "manager" ? (
        <div className="p-4"><MarketingPortalAds /></div>
      ) : (
        <main className="p-6">
          <h1 className="text-xl font-semibold">Customer portal</h1>
          <button type="button" data-testid="page-button">Check my ticket</button>
          <PortalAdPopup
            onImpression={(ad) => window.adEvents.push({ type: "impression", adId: ad.id })}
            onDismiss={(ad, reason) => window.adEvents.push({ type: "dismiss", adId: ad.id, reason })}
            onAdClick={(ad) => window.adEvents.push({ type: "click", adId: ad.id })}
          />
        </main>
      )}
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
