import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import StaffInviteManager from "../src/pages/staff-invite-manager";
import { getQueryFn } from "../src/lib/queryClient";
import "../src/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false } },
});

const useOwnerAccess = () => ({ isAdmin: true, role: "owner" as const, isLoading: false });

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <StaffInviteManager useAccess={useOwnerAccess} />
  </QueryClientProvider>,
);