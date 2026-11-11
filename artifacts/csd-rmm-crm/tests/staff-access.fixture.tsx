import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import StaffAccessPage from "../src/pages/staff-access";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import type { StaffRole } from "../src/hooks/use-admin-access";
import "../src/index.css";

const fixtureRole = (new URLSearchParams(window.location.search).get("role") ?? "administrator") as StaffRole;

function useFixtureAccess() {
  return {
    isAdmin: fixtureRole === "owner" || fixtureRole === "administrator",
    role: fixtureRole,
    isLoading: false,
  };
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <StaffAccessPage useAccess={useFixtureAccess} />
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);