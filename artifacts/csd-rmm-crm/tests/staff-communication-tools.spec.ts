import { expect, test } from "@playwright/test";

// Staff Access → Communications tools switches (Inbox & SMS, Calls &
// Tracking, Main Line Setup). Server enforcement is covered by
// communication-capabilities.integration.test.ts.

const features = Object.fromEntries([
  "dashboard", "crm", "communications", "scheduling", "operations", "helpdesk", "invoices",
  "reports", "automation", "compliance", "helpdeskAdmin", "dispatchAdmin", "staffAdmin", "billing", "marketplace",
].map((feature) => [feature, ["dashboard", "crm", "communications"].includes(feature)]));

const profile = {
  id: "comms-tech", email: "tech@example.invalid", firstName: "Casey", lastName: "Tech",
  role: "field_technician", approvalStatus: "approved", isOwner: false,
  features, effectiveFeatures: features,
  capabilities: { viewVoicemails: true, smsInbox: true, callTracking: false, mainLineSetup: false },
  assignments: { clientIds: [], jobIds: [], contactAssignments: [] },
  helpdeskAssigneeId: null, updatedAt: "2026-11-11T12:00:00.000Z",
};

test("an administrator turns on Main Line Setup for a technician", async ({ page }) => {
  const saves: any[] = [];
  let current = structuredClone(profile);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === `/api/staff-access/${profile.id}` && method === "PATCH") {
      const body = route.request().postDataJSON();
      saves.push(body);
      current = { ...current, capabilities: body.capabilities, updatedAt: "2026-11-11T12:05:00.000Z" };
      await route.fulfill({ json: { id: profile.id, role: current.role, approvalStatus: "approved", features, effectiveFeatures: features, capabilities: current.capabilities, updatedAt: current.updatedAt } });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/staff-access": [current],
      "/api/staff-access/role-features": Object.fromEntries(
        ["administrator", "field_technician", "software_developer", "accounting", "it_manager", "legal_team", "secretary"]
          .map((name) => [name, features]),
      ),
      "/api/staff-access/accounts": { accounts: [], totalCount: 0, nextOffset: null },
      [`/api/staff-access/${profile.id}/profile`]: {
        email: profile.email, phone: null, jobTitle: null, department: null, updatedAt: null,
        verifiedEmails: [profile.email], emailChangeAvailable: false, emailMessage: "",
      },
    };
    await route.fulfill({ json: responses[url.pathname] ?? [] });
  });

  await page.goto("/tests/staff-access.fixture.html?role=administrator");
  await page.getByText("Casey Tech", { exact: true }).first().click();

  const inbox = page.getByRole("switch", { name: "Inbox & SMS access" });
  const calls = page.getByRole("switch", { name: "Calls & Tracking access" });
  const mainLine = page.getByRole("switch", { name: "Main Line Setup access" });
  await expect(inbox).toBeChecked();
  await expect(calls).not.toBeChecked();
  await expect(mainLine).not.toBeChecked();

  await mainLine.click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].capabilities).toEqual({ viewVoicemails: true, smsInbox: true, callTracking: false, mainLineSetup: true });
  await expect(mainLine).toBeChecked();
});
