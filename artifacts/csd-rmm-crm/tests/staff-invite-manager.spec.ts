import { expect, test } from "@playwright/test";

test("owner can prefill the invitation email from an existing sign-in account", async ({ page }) => {
  await page.route("**/api/staff-access/invites", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/staff-access/accounts**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [{
          clerkUserId: "clerk-account-without-names",
          email: "newstaff@example.invalid",
          firstName: null,
          lastName: null,
          emailVerified: true,
          staffUserId: null,
          approvalStatus: null,
          invitationStatus: null,
        }],
        totalCount: 1,
        nextOffset: null,
      }),
    }));

  await page.goto("/tests/staff-invite-manager.fixture.html");
  await page.getByTestId("button-prefill-staff-invite-clerk-account-without-names").click();
  await expect(page.getByTestId("input-invite-email")).toHaveValue("newstaff@example.invalid");
});