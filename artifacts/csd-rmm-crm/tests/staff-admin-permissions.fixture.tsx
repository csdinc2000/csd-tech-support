import React from "react";
import { createRoot } from "react-dom/client";
import { Redirect, Route, Router, Switch } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { StaffAdminView } from "../src/pages/staff-admin";
import DispatchSettingsPage from "../src/pages/dispatch-settings";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

const fixtureParams = new URLSearchParams(window.location.search);
const role = fixtureParams.get("role") ?? "owner";
const target = fixtureParams.get("target") ?? "/staff";
const realDispatch = fixtureParams.get("realDispatch") === "true";
const assigneeHandoff = fixtureParams.get("assigneeHandoff") === "true";

window.history.replaceState(null, "", target);
if (realDispatch && !assigneeHandoff) {
  queryClient.setQueryData(["/api/staff-dispatch/settings"], {
    recipients: [{ id: 1, name: "Alex", role: "staff", phone: "+15550123456", enabled: true, onDuty: true, receiveCalls: true, receiveMessages: true, canUseCommands: false, linkedUserId: null, staffAccessApproved: true, updatedAt: "" }],
    routing: { activeCallRecipients: [1], activeMessageRecipients: [1] },
  });
  queryClient.setQueryData(["/api/staff-dispatch/audit"], []);
  queryClient.setQueryData(["/api/staff-dispatch/eligible-assignees"], []);
}

const access = {
  canAccess: role === "owner" || role === "staff-admin",
  canDispatch: role === "owner",
  isLoading: false,
};

const Roles = () => <main data-testid="roles-access-view">Roles &amp; Access content</main>;
const Dispatch = ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) =>
  <main className="pt-20" data-testid="dispatch-settings-view">
    Dispatch Settings content
    <button onClick={() => onDirtyChange?.(true)} data-testid="fixture-dirty-dispatch">Edit draft</button>
  </main>;

function Fixture() {
  const staffPage = (
    <StaffAdminView
      {...access}
      AccessPage={Roles}
      DispatchPage={realDispatch ? DispatchSettingsPage : Dispatch}
    />
  );

  return (
    <Router>
      <Switch>
        <Route path="/staff">{staffPage}</Route>
        <Route path="/staff-access"><Redirect to="/staff?tab=access" /></Route>
        <Route path="/dispatch-settings"><Redirect to={`/staff?tab=dispatch${new URLSearchParams(window.location.search).has("assigneeId") ? `&assigneeId=${encodeURIComponent(new URLSearchParams(window.location.search).get("assigneeId")!)}` : ""}`} /></Route>
      </Switch>
    </Router>
  );
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);