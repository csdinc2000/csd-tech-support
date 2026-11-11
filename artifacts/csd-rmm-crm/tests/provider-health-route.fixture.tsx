import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Link, Router } from "wouter";
import { AdminRouter } from "../src/App";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

let fixtureLocation = "/provider-health";
const useFixtureLocation = () => {
  const location = React.useSyncExternalStore(
    (listener) => {
      window.addEventListener("pushState", listener);
      window.addEventListener("replaceState", listener);
      window.addEventListener("popstate", listener);
      return () => {
        window.removeEventListener("pushState", listener);
        window.removeEventListener("replaceState", listener);
        window.removeEventListener("popstate", listener);
      };
    },
    () => window.history.state?.fixtureLocation ?? fixtureLocation,
    () => fixtureLocation,
  );
  const navigate = (to: string) => {
    fixtureLocation = to;
    window.history.pushState({ fixtureLocation: to }, "", to);
  };
  return [location, navigate] as const;
};

const isOwner = new URLSearchParams(window.location.search).get("owner") === "true";
const balanceState = new URLSearchParams(window.location.search).get("balance");
const loadFromApi = new URLSearchParams(window.location.search).get("loadFromApi") === "true";
const showRefreshControl = new URLSearchParams(window.location.search).get("refreshControl") === "true";
const checkedAt = "2026-09-16T14:30:00.000Z";
const balance = !balanceState || balanceState === "unavailable"
  ? null
  : {
      remaining: 1_250,
      total: 5_000,
      percentage: 25,
      checkedAt,
      stale: balanceState === "stale",
    };

queryClient.setQueryData(["/api/provider-health/email/warning-settings/history"], {
  pages: [{ items: [], nextCursor: null }],
  pageParams: [undefined],
});

if (!loadFromApi) {
  queryClient.setQueryData(["/api/provider-health/email"], {
    provider: "SendGrid",
    proactiveCapacityMonitoring: {
      available: balanceState !== "stale" && balanceState !== "unavailable",
      state: balanceState !== "stale" && balanceState !== "unavailable" ? "available" : "unavailable",
      reason: balanceState !== "stale" && balanceState !== "unavailable" ? null : "provider_unavailable",
      checkedAt: "2026-09-16T00:00:00.000Z",
      balance,
    },
    warningSettings: { mode: "default", value: null },
    safeDefaults: { percentage: 10, remainingCredits: 100 },
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={useFixtureLocation}>
        <AdminRouter ownerAccessOverride={{ isOwner, isLoading: false }} />
        <Link href="/other-page" data-testid="link-leave-provider-health">Leave provider health</Link>
        <Link href="/provider-health" data-testid="link-return-provider-health">Return to provider health</Link>
      </Router>
      {showRefreshControl ? (
        <button
          data-testid="trigger-provider-health-refresh"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/provider-health/email"] })}
        >
          Trigger provider health refresh
        </button>
      ) : null}
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);