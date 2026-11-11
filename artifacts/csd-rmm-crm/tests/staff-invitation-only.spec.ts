import { expect, test } from "@playwright/test";

const features = Object.fromEntries([
  "dashboard", "crm", "communications", "scheduling", "operations", "helpdesk", "invoices",
  "reports", "automation", "compliance", "helpdeskAdmin", "dispatchAdmin", "staffAdmin", "billing", "marketplace",
].map((feature) => [feature, feature === "dashboard"]));
const profile = {
  id: "invitation-only-staff", email: null, firstName: "Invitation Only", lastName: "Technician",
  role: "field_technician", approvalStatus: "approved", isOwner: false,
  features, effectiveFeatures: features, capabilities: { viewVoicemails: false },
  assignments: { clientIds: [], jobIds: [], contactAssignments: [] },
  helpdeskAssigneeId: null, updatedAt: "2026-10-05T12:00:00.000Z",
};

for (const role of ["owner", "administrator"]) {
  test(`${role}: missing staff email never offers direct sign-in linking`, async ({ page }) => {
    const issued: Array<{ email: string; role: string }> = [];
    const responses: Record<string, unknown> = {
      "/api/staff-access": [profile],
      "/api/staff-access/role-features": Object.fromEntries(
        ["administrator", "field_technician", "software_developer", "accounting", "it_manager", "legal_team", "secretary"]
          .map((name) => [name, features]),
      ),
      "/api/staff-access/accounts": { accounts: [], totalCount: 0, nextOffset: null },
      "/api/staff-access/audit": [], "/api/staff-access/invites": [],
      [`/api/staff-access/${profile.id}/profile`]: {
        email: null, phone: null, jobTitle: null, department: null, updatedAt: null,
        verifiedEmails: [], emailChangeAvailable: false, emailMessage: "No verified sign-in email yet.",
      },
    };
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/staff-access/invites" && route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { email: string; role: string };
        issued.push(body);
        await route.fulfill({
          status: 201, contentType: "application/json", body: JSON.stringify({
            invite: { id: "fixture-invite", ...body, createdAt: profile.updatedAt,
              expiresAt: "2099-01-01T00:00:00Z", acceptedAt: null, revokedAt: null },
            invitePath: "/staff-invite#fixture-private-invitation",
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[url.pathname] ?? []) });
    });
    await page.goto(`/tests/staff-access.fixture.html?role=${role}`);
    await page.getByText("Invitation Only Technician", { exact: true }).first().click();
    await expect(page.getByTestId("text-helpdesk-email-required-invitation-only-staff")).toBeVisible();
    await expect(page.getByText(/Staff enrollment is invitation-only/).first()).toBeVisible();
    await expect(page.getByTestId("button-repair-helpdesk-identity")).toHaveCount(0);
    await expect(page.getByTestId("input-helpdesk-identity-email")).toHaveCount(0);
    if (role === "owner") {
      await page.getByTestId("link-helpdesk-staff-invitation").click();
      await page.getByTestId("input-invite-email").fill("invited@example.invalid");
      await page.getByTestId("button-create-invite").click();
      await expect.poll(() => issued.length).toBe(1);
      expect(issued[0]).toMatchObject({ email: "invited@example.invalid", role: "field_technician" });
    } else {
      await expect(page.getByTestId("link-helpdesk-staff-invitation")).toHaveCount(0);
      await expect(page.getByText("Ask an active owner to send the invitation.")).toBeVisible();
    }
  });
}
