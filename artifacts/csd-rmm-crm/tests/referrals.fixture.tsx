import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Router, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import PortalReferralsPage, { PortalReferralDashboard } from "../src/pages/portal-referrals";
import PortalHome from "../src/pages/portal-home";
import { ReferralBanner } from "../src/components/referrals/referral-banner";
import { MarketingReferrals } from "../src/components/marketing/marketing-referrals";
import { captureUtmCampaign } from "../src/lib/utm-capture";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

// `?path=` picks the screen; `?ref=` is captured exactly like the real app does on load.
const params = new URLSearchParams(window.location.search);
captureUtmCampaign();
const { hook, searchHook } = memoryLocation({ path: params.get("path") ?? "/portal/referrals" });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={hook} searchHook={searchHook}>
        <Switch>
          <Route path="/portal" component={PortalHome} />
          <Route path="/portal/referrals" component={PortalReferralsPage} />
          <Route path="/portal/referrals/r/:token" component={PortalReferralDashboard} />
          <Route path="/intake"><div className="p-6"><ReferralBanner /></div></Route>
          <Route path="/staff"><div className="p-4"><MarketingReferrals isAdmin={params.get("admin") !== "0"} /></div></Route>
        </Switch>
      </Router>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
