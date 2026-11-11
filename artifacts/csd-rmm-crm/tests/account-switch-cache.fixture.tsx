import React, { useCallback, useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient } from "../src/lib/queryClient";
import { QueryCacheUserSynchronizer } from "../src/App";

type UserId = "staff-a" | "staff-b";
type PageName = "dashboard" | "customers" | "alerts";

declare global {
  interface Window {
    __accountSwitchRenderHistory: string[];
  }
}

window.__accountSwitchRenderHistory = [];

function DataPage({ page, userId }: { page: PageName; userId: UserId }) {
  const metrics = useQuery<{ label: string }>({ queryKey: ["/api/dashboard/metrics"] });
  const customers = useQuery<Array<{ name: string }>>({ queryKey: ["/api/clients"] });
  const alerts = useQuery<Array<{ title: string }>>({ queryKey: ["/api/alerts/active"] });

  if (metrics.isPending || customers.isPending || alerts.isPending) {
    return <p data-testid="loading">Loading account data…</p>;
  }

  if (metrics.isError || customers.isError || alerts.isError) {
    return <p data-testid="error">Account data failed to load</p>;
  }

  const renderedValues = [metrics.data?.label, customers.data?.[0]?.name, alerts.data?.[0]?.title]
    .filter((value): value is string => Boolean(value));
  window.__accountSwitchRenderHistory.push(...renderedValues.map((value) => `${userId}:${value}`));

  return (
    <section data-testid={`${page}-page`}>
      <h2>{page}</h2>
      <p data-testid="dashboard-data">{metrics.data?.label}</p>
      <p data-testid="customer-data">{customers.data?.[0]?.name}</p>
      <p data-testid="alert-data">{alerts.data?.[0]?.title}</p>
    </section>
  );
}

function Fixture() {
  const [userId, setUserId] = useState<UserId | null>(null);
  const [page, setPage] = useState<PageName>("dashboard");
  const [identityListener, setIdentityListener] = useState<(userId: string | null) => void>(() => () => undefined);
  const subscribe = useCallback((listener: (nextUserId: string | null) => void) => {
    setIdentityListener(() => listener);
    return () => setIdentityListener(() => () => undefined);
  }, []);

  const signIn = (nextUserId: UserId) => {
    identityListener(nextUserId);
    setUserId(nextUserId);
    setPage("dashboard");
  };

  const signOut = () => {
    identityListener(null);
    setUserId(null);
  };

  return (
    <main>
      <QueryCacheUserSynchronizer subscribe={subscribe} />
      <div>
        <button onClick={() => signIn("staff-a")}>Sign in Staff A</button>
        <button onClick={() => signIn("staff-b")}>Sign in Staff B</button>
        <button onClick={signOut}>Sign out</button>
      </div>
      <div>
        <button onClick={() => setPage("dashboard")}>Dashboard</button>
        <button onClick={() => setPage("customers")}>Customers</button>
        <button onClick={() => setPage("alerts")}>Alerts</button>
      </div>

      <p data-testid="current-user">{userId ?? "signed-out"}</p>
      {userId ? <DataPage key={page} page={page} userId={userId} /> : <p data-testid="signed-out">Signed out</p>}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Fixture />
    </QueryClientProvider>
  </React.StrictMode>,
);