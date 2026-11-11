import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Link, Router } from "wouter";
import PhoneSettingsPage from "../src/pages/phone-settings";
import DispatchSettingsPage from "../src/pages/dispatch-settings";
import HelpdeskAdmin from "../src/pages/helpdesk-admin";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

const page = new URLSearchParams(window.location.search).get("page") ?? "phone";
let fixtureLocation = `/${page}`;
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

queryClient.setQueryData(["/api/twilio/settings"], { twilioPhoneNumber: "+15550123456", forwardToNumber: "+15550654321" });
queryClient.setQueryData(["/api/helpdesk/settings"], {
  autoresponderEnabled: true, overdueAlertEnabled: false, portalEnabled: true,
  ticketNumberPrefix: "CSD", lockExpiryMinutes: 30, maxAttachmentBytes: 1024, allowedMimeTypes: "image/png",
});
queryClient.setQueryData(["/api/staff-dispatch/settings"], {
  recipients: [{ id: 1, name: "Alex", role: "staff", phone: "+15550123456", enabled: true, onDuty: true, receiveCalls: true, receiveMessages: true, canUseCommands: false, linkedUserId: null, staffAccessApproved: true, updatedAt: "" }],
  routing: { activeCallRecipients: [1], activeMessageRecipients: [1] },
});
queryClient.setQueryData(["/api/staff-dispatch/audit"], []);
queryClient.setQueryData(["/api/staff-dispatch/eligible-assignees"], []);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Router hook={useFixtureLocation}>
      {page === "phone" ? <PhoneSettingsPage defaultTab="numbers" visibleTabs={["numbers"]} /> :
        page === "dispatch" ? <DispatchSettingsPage /> : <HelpdeskAdmin />}
      <Link href="/other-page" data-testid="link-leave-settings">Leave settings</Link>
    </Router>
  </QueryClientProvider>,
);