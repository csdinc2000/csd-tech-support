import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { Route, Router, Switch } from "wouter";
import { getQueryFn } from "../src/lib/queryClient";
import StaffAria from "../src/components/aria/staff-aria";
import Tickets from "../src/pages/tickets";
import CrmContacts from "../src/pages/crm-contacts";
import Invoices from "../src/pages/invoices";
import Scheduling from "../src/pages/scheduling";
import Dispatch from "../src/pages/ptt-dispatch";
import "../src/index.css";

// Exercise the approved staff branch with deterministic API responses. Clerk is
// present for page hooks; this fixture does not test the Clerk sign-in flow.
const queryClient = new QueryClient({
  defaultOptions: { queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false } },
});
window.history.replaceState(null, "", new URLSearchParams(location.search).get("target") ?? "/tickets");

function ApprovedStaffRoutes() {
  const { data: access, isLoading } = useQuery<{ approvalStatus: string; features: Record<string, boolean> }>({
    queryKey: ["/api/auth/access"],
  });
  if (isLoading) return <div>Checking staff access…</div>;
  if (access?.approvalStatus !== "approved") return <div>Staff access required</div>;
  return (
    <Router>
      <main className="min-w-0">
        <StaffAria />
        <Switch>
          <Route path="/tickets">{access.features.helpdesk && <Tickets />}</Route>
          <Route path="/crm/contacts">{access.features.crm && <CrmContacts />}</Route>
          <Route path="/invoices">{access.features.invoices && <Invoices />}</Route>
          <Route path="/scheduling">{access.features.scheduling && <Scheduling />}</Route>
          <Route path="/ptt">{access.features.communications && <Dispatch />}</Route>
        </Switch>
      </main>
    </Router>
  );
}

createRoot(document.getElementById("root")!).render(
  <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
    <QueryClientProvider client={queryClient}>
      <ApprovedStaffRoutes />
    </QueryClientProvider>
  </ClerkProvider>,
);