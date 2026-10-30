import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  canUseIncomingCallAlerts,
  IncomingCallAlertsSession,
} from "../src/components/notifications/incoming-call-alerts";
import "../src/index.css";

const params = new URLSearchParams(window.location.search);
const initialUserId = params.get("user") ?? "signed-in-staff";
const isSignedIn = params.get("signedIn") !== "false";
const initialApprovalStatus = params.get("approval") ?? "approved";
const initialCanCommunicate = params.get("communications") !== "false";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function Fixture() {
  const [userId, setUserId] = useState<string | null>(initialUserId);
  const [approvalStatus, setApprovalStatus] = useState(initialApprovalStatus);
  const [canCommunicate, setCanCommunicate] = useState(initialCanCommunicate);
  const allowed = canUseIncomingCallAlerts({
    userId,
    isSignedIn,
    approvalStatus,
    canCommunicate,
  });

  useEffect(() => {
    (window as any).__incomingCallFixture = {
      setUserId: (nextUserId: string | null) => setUserId(nextUserId),
      setAccessProfile: (profile: { approvalStatus?: string; canCommunicate?: boolean }) => {
        if (profile.approvalStatus !== undefined) setApprovalStatus(profile.approvalStatus);
        if (profile.canCommunicate !== undefined) setCanCommunicate(profile.canCommunicate);
      },
    };
  }, []);

  return (
    <main className="min-h-screen bg-gray-50">
      <IncomingCallAlertsSession userId={userId} allowed={allowed} />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
);
