import { expect, test, type Route } from "@playwright/test";

const features = {
  dashboard: true,
  crm: true,
  communications: false,
  scheduling: false,
  operations: false,
  helpdesk: false,
  invoices: false,
  reports: false,
  automation: false,
  compliance: false,
  helpdeskAdmin: false,
  dispatchAdmin: false,
  marketplace: false,
};

const pendingProfile = {
  id: "staff-pending",
  email: "pending@example.com",
  firstName: "Pat",
  lastName: "Pending",
  role: "field_technician",
  approvalStatus: "pending",
  isOwner: false,
  requiresOwnerApproval: true,
  features,
  effectiveFeatures: features,
  capabilities: { viewVoicemails: false },
  assignments: { clientIds: [], jobIds: [], contactAssignments: [] },
  updatedAt: "2026-09-09T12:00:00.000Z",
};
const hiddenLinkedProfile = {
  ...pendingProfile,
  id: "staff-hidden",
  email: "quiet@example.com",
  firstName: "Quiet",
  lastName: "Person",
};

const account = {
  clerkUserId: "user_donard",
  email: "donard@example.com",
  firstName: null,
  lastName: null,
  emailVerified: true,
  staffUserId: null,
  approvalStatus: null,
  invitationStatus: null,
};
const linkedDonardAccount = {
  ...account,
  clerkUserId: "user_linked_donard",
  email: "linked-donard@example.com",
  firstName: "Donard",
  lastName: "Williams",
  staffUserId: "staff-hidden",
  approvalStatus: "pending" as const,
  invitationStatus: "accepted" as const,
};
const emailMatchWithoutIdentityLink = {
  ...account,
  clerkUserId: "user_email_match",
  firstName: "Pat",
  lastName: "Pending",
  email: "pending@example.com",
};
const linkedByStaffUserId = {
  ...account,
  clerkUserId: "user_linked",
  staffUserId: "staff-pending",
  approvalStatus: "pending",
  invitationStatus: "accepted",
};
const linkedByExactClerkId = {
  ...account,
  clerkUserId: "staff-pending",
  email: "different@example.com",
};
const commonResponses: Record<string, unknown> = {
  "/api/staff-access": [pendingProfile, hiddenLinkedProfile],
  "/api/staff-access/role-features": {
    administrator: features,
    field_technician: features,
    software_developer: features,
    accounting: features,
    it_manager: features,
    legal_team: features,
    secretary: features,
  },
  "/api/staff-access/audit": [],
  "/api/alerts/active": [],
  "/api/clients": [],
  "/api/crm/jobs": [],
  "/api/crm/contacts": [],
  "/api/staff-access/invites": [],
};

async function fulfillJson(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}

test("owner searches one unified roster, selects a Clerk-only person, and explicitly invites them", async ({ page }) => {
  const accountQueries: string[] = [];
  let createdInvite: { email: string; role: string } | null = null;
  let donardAccount = { ...account };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/staff-access/accounts") {
      accountQueries.push(url.search);
      const exactId = url.searchParams.get("clerkUserId");
      if (exactId) {
        const exactAccount = [donardAccount, linkedDonardAccount, emailMatchWithoutIdentityLink, linkedByStaffUserId, linkedByExactClerkId]
          .find((candidate) => candidate.clerkUserId === exactId);
        await fulfillJson(route, { accounts: exactAccount ? [exactAccount] : [], totalCount: exactAccount ? 1 : 0, nextOffset: null });
        return;
      }
      const query = new URLSearchParams(url.search).get("q")?.toLowerCase() ?? "";
      const filtered = [donardAccount, linkedDonardAccount, emailMatchWithoutIdentityLink, linkedByStaffUserId, linkedByExactClerkId].filter((candidate) =>
        `${candidate.firstName ?? ""} ${candidate.lastName ?? ""} ${candidate.email ?? ""} ${candidate.clerkUserId} ${candidate.staffUserId ?? ""}`.toLowerCase().includes(query));
      await fulfillJson(route, { accounts: filtered, totalCount: filtered.length, nextOffset: null });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/staff-access/invites") {
      createdInvite = request.postDataJSON() as { email: string; role: string };
      donardAccount = { ...donardAccount, invitationStatus: "pending" };
      await fulfillJson(route, {
        invite: {
          id: "invite-donard",
          email: createdInvite.email,
          role: createdInvite.role,
          status: "pending",
          createdAt: "2026-09-09T12:00:00.000Z",
          expiresAt: "2099-09-16T12:00:00.000Z",
          acceptedAt: null,
          revokedAt: null,
        },
        invitePath: "/staff-invite#one-time-token",
      });
      return;
    }
    if (url.pathname in commonResponses) {
      await fulfillJson(route, commonResponses[url.pathname]);
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html?role=owner");
  await expect(page.getByTestId("input-search-staff-roster")).toBeVisible();
  await page.getByTestId("input-search-staff-roster").fill("Donard");
  await expect(page.getByTestId("list-item-clerk-user_donard")).toBeVisible();
  await expect(page.getByTestId("list-item-staff-staff-hidden")).toBeVisible();
  await expect.poll(() => accountQueries.some((query) => new URLSearchParams(query).get("q")?.toLowerCase() === "donard")).toBe(true);
  await expect(page.getByText("Existing sign-in accounts", { exact: true })).toHaveCount(1);
  await page.getByTestId("list-item-staff-staff-hidden").click();
  await expect(page.getByTestId("card-staff-staff-hidden")).toBeVisible();
  await page.getByTestId("input-search-staff-roster").fill("pending@example.com");
  await expect(page.getByTestId("card-staff-staff-hidden")).toBeVisible();
  await page.getByTestId("input-search-staff-roster").fill("Donard");
  await page.getByTestId("list-item-clerk-user_donard").click();

  await expect(page.getByTestId("text-selected-clerk-account-name")).toHaveText("donard@example.com");
  await expect(page.getByTestId("card-clerk-account-user_donard")).toContainText("donard@example.com");
  await expect(page.getByTestId("status-email-verification-user_donard")).toHaveText("Email verified");
  await expect(page.getByTestId("status-invitation-user_donard")).toHaveText("No invitation");
  await expect(page.getByTestId("notice-clerk-account-no-access")).toContainText("has no app permissions");
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByTestId("input-invite-email")).toHaveValue("donard@example.com");

  await page.getByTestId("select-invite-role").selectOption("accounting");
  await page.getByTestId("button-create-invite").click();
  await expect(page.getByTestId("panel-created-invite")).toBeVisible();
  await expect(page.getByTestId("status-invitation-user_donard")).toHaveText("Invite pending");
  expect(createdInvite).toEqual({ email: "donard@example.com", role: "accounting" });

  await page.getByTestId("input-search-staff-roster").fill("pending@example.com");
  await expect(page.getByTestId("list-item-clerk-user_email_match")).toBeVisible();
  await expect(page.getByTestId("list-item-clerk-user_linked")).toHaveCount(0);
  await expect(page.getByTestId("list-item-clerk-staff-pending")).toHaveCount(0);
  await page.getByTestId("input-search-staff-roster").fill("staff-pending");
  await expect(page.getByTestId("list-item-staff-staff-pending")).toBeVisible();
  await expect(page.getByTestId("list-item-clerk-user_linked")).toHaveCount(0);
  await expect(page.getByTestId("list-item-clerk-staff-pending")).toHaveCount(0);
});

test("non-owner administrators keep the staff roster and approval gate without requesting Clerk accounts", async ({ page }) => {
  let accountRequestCount = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/staff-access/accounts") {
      accountRequestCount += 1;
      await fulfillJson(route, { accounts: [account], totalCount: 1, nextOffset: null });
      return;
    }
    if (url.pathname in commonResponses) {
      await fulfillJson(route, commonResponses[url.pathname]);
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html?role=administrator");
  await expect(page.getByTestId("list-item-staff-staff-pending")).toBeVisible();
  await expect(page.getByTestId("badge-status-pending-staff-pending")).toHaveText("Pending approval");
  await expect(page.getByTestId("button-approve-staff-pending")).toBeDisabled();
  await expect(page.getByText("The owner must approve invited accounts.")).toBeVisible();
  await expect.poll(() => accountRequestCount).toBe(0);
});

test("refreshing a selected Clerk identity promotes an accepted account into staff approval controls", async ({ page }) => {
  const acceptedProfile = {
    ...pendingProfile,
    id: "staff-donard",
    email: "donard@example.com",
    firstName: "Donard",
    lastName: "Williams",
  };
  let accepted = false;
  let staffProfiles = [pendingProfile, hiddenLinkedProfile];
  let accountRequestCount = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/staff-access") {
      await fulfillJson(route, staffProfiles);
      return;
    }
    if (url.pathname === "/api/staff-access/accounts") {
      accountRequestCount += 1;
      const exactId = url.searchParams.get("clerkUserId");
      if (exactId) {
        const selected = exactId === account.clerkUserId
          ? accepted
            ? { ...account, staffUserId: acceptedProfile.id, approvalStatus: "pending" as const, invitationStatus: "accepted" as const }
            : account
          : undefined;
        await fulfillJson(route, { accounts: selected ? [selected] : [], totalCount: selected ? 1 : 0, nextOffset: null });
        return;
      }
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const filtered = [account, linkedDonardAccount].filter((candidate) =>
        `${candidate.firstName ?? ""} ${candidate.lastName ?? ""} ${candidate.email ?? ""} ${candidate.clerkUserId}`.toLowerCase().includes(query));
      await fulfillJson(route, { accounts: filtered, totalCount: filtered.length, nextOffset: null });
      return;
    }
    if (url.pathname in commonResponses) {
      await fulfillJson(route, commonResponses[url.pathname]);
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html?role=owner");
  await page.getByTestId("input-search-staff-roster").fill("Donard");
  await page.getByTestId("list-item-clerk-user_donard").click();
  await expect(page.getByTestId("notice-clerk-account-no-access")).toBeVisible();
  expect(accountRequestCount).toBeGreaterThan(1);

  accepted = true;
  staffProfiles = [...staffProfiles, acceptedProfile];
  await page.getByTestId("button-refresh-selected-clerk-account").click();
  await expect(page.getByTestId("card-staff-staff-donard")).toBeVisible();
  await expect(page.getByTestId("badge-status-pending-staff-donard")).toHaveText("Pending approval");
  await expect(page.getByTestId("button-approve-staff-donard")).toBeEnabled();
});

test("selected account refresh reflects revoked invitation and changed verification, and missing identities lose invite actions", async ({ page }) => {
  let currentAccount = { ...account, invitationStatus: "pending" as const };
  let currentInviteStatus = "pending";
  let accountExists = true;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/staff-access/accounts") {
      const exactId = url.searchParams.get("clerkUserId");
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const selected = accountExists
        && (exactId
          ? exactId === currentAccount.clerkUserId
          : `${currentAccount.firstName ?? ""} ${currentAccount.lastName ?? ""} ${currentAccount.email ?? ""} ${currentAccount.clerkUserId}`.toLowerCase().includes(query))
        ? currentAccount
        : undefined;
      await fulfillJson(route, { accounts: selected ? [selected] : [], totalCount: selected ? 1 : 0, nextOffset: null });
      return;
    }
    if (url.pathname === "/api/staff-access/invites") {
      await fulfillJson(route, [{
        id: "invite-donard",
        email: currentAccount.email,
        role: "field_technician",
        status: currentInviteStatus,
        createdAt: "2026-09-09T12:00:00.000Z",
        expiresAt: "2099-09-16T12:00:00.000Z",
        acceptedAt: null,
        revokedAt: currentInviteStatus === "revoked" ? "2026-09-10T12:00:00.000Z" : null,
      }]);
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/staff-access/invites/invite-donard/revoke") {
      currentAccount = { ...currentAccount, emailVerified: false, invitationStatus: "revoked" };
      currentInviteStatus = "revoked";
      await fulfillJson(route, { revoked: true });
      return;
    }
    if (url.pathname in commonResponses) {
      await fulfillJson(route, commonResponses[url.pathname]);
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html?role=owner");
  await page.getByTestId("input-search-staff-roster").fill("Donard");
  await page.getByTestId("list-item-clerk-user_donard").click();
  await expect(page.getByTestId("status-invitation-user_donard")).toHaveText("Invite pending");
  await page.getByTestId("button-revoke-invite-invite-donard").click();
  await page.getByTestId("button-confirm-revoke-invite-invite-donard").click();
  await expect(page.getByTestId("status-invitation-user_donard")).toHaveText("Invite revoked");
  await expect(page.getByTestId("status-email-verification-user_donard")).toHaveText("Email unverified");
  await expect(page.getByTestId("status-invite-invite-donard")).toHaveText("revoked");

  accountExists = false;
  await page.getByTestId("button-refresh-selected-clerk-account").click();
  await expect(page.getByTestId("notice-selected-clerk-account-missing")).toBeVisible();
  await expect(page.getByTestId("section-staff-invites")).toBeHidden();
});

test("changing selected account during invite creation preserves the created recipient, role, and pending prefill", async ({ page }) => {
  const secondAccount = {
    ...account,
    clerkUserId: "user_reese",
    email: "reese@example.com",
    firstName: "Reese",
    lastName: "Taylor",
  };
  let releaseCreate: (() => void) | undefined;
  let createStarted: (() => void) | undefined;
  const createStartedPromise = new Promise<void>((resolve) => { createStarted = resolve; });
  const createReleasePromise = new Promise<void>((resolve) => { releaseCreate = resolve; });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/staff-access/accounts") {
      const exactId = url.searchParams.get("clerkUserId");
      const candidates = [account, secondAccount];
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const filtered = candidates.filter((candidate) =>
        exactId
          ? candidate.clerkUserId === exactId
          : `${candidate.firstName ?? ""} ${candidate.lastName ?? ""} ${candidate.email ?? ""} ${candidate.clerkUserId}`.toLowerCase().includes(query));
      await fulfillJson(route, { accounts: filtered, totalCount: filtered.length, nextOffset: null });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/staff-access/invites") {
      const submitted = request.postDataJSON() as { email: string; role: string };
      createStarted?.();
      await createReleasePromise;
      await fulfillJson(route, {
        invite: {
          id: "invite-donard",
          email: submitted.email,
          role: submitted.role,
          status: "pending",
          createdAt: "2026-09-09T12:00:00.000Z",
          expiresAt: "2099-09-16T12:00:00.000Z",
          acceptedAt: null,
          revokedAt: null,
        },
        invitePath: "/staff-invite#donard-token",
      });
      return;
    }
    if (url.pathname in commonResponses) {
      await fulfillJson(route, commonResponses[url.pathname]);
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html?role=owner");
  await page.getByTestId("input-search-staff-roster").fill("Donard");
  await page.getByTestId("list-item-clerk-user_donard").click();
  await expect(page.getByTestId("input-invite-email")).toHaveValue("donard@example.com");
  await page.getByTestId("select-invite-role").selectOption("accounting");
  await page.getByTestId("button-create-invite").click();
  await createStartedPromise;
  await expect(page.getByTestId("button-create-invite")).toContainText("Creating");

  await page.getByTestId("input-search-staff-roster").fill("Reese");
  await page.getByTestId("list-item-clerk-user_reese").click();
  await expect(page.getByTestId("text-selected-clerk-account-name")).toHaveText("Reese Taylor");
  await expect(page.getByTestId("input-invite-email")).toHaveValue("donard@example.com");
  await expect(page.getByTestId("notice-pending-invite-prefill")).toContainText("reese@example.com");

  releaseCreate?.();
  await expect(page.getByTestId("panel-created-invite")).toBeVisible();
  await expect(page.getByTestId("text-created-invite-recipient")).toHaveText("donard@example.com");
  await expect(page.getByTestId("notice-pending-invite-prefill")).toContainText("reese@example.com");
  await expect(page.getByTestId("select-invite-role")).toHaveValue("accounting");
  await page.getByTestId("button-apply-invite-prefill").click();
  await expect(page.getByTestId("input-invite-email")).toHaveValue("reese@example.com");
  await expect(page.getByTestId("text-created-invite-recipient")).toHaveText("donard@example.com");
});

test("identity drafts survive changing profiles and refreshing the roster", async ({ page }) => {
  let serverPendingProfile = { ...pendingProfile };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/staff-access") {
      await fulfillJson(route, [serverPendingProfile, hiddenLinkedProfile]);
      return;
    }
    if (url.pathname === "/api/staff-access/accounts") {
      const exactId = url.searchParams.get("clerkUserId");
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const candidates = exactId ? [account] : [account];
      const filtered = candidates.filter((candidate) =>
        exactId
          ? candidate.clerkUserId === exactId
          : `${candidate.firstName ?? ""} ${candidate.lastName ?? ""} ${candidate.email ?? ""} ${candidate.clerkUserId}`.toLowerCase().includes(query));
      await fulfillJson(route, { accounts: filtered, totalCount: filtered.length, nextOffset: null });
      return;
    }
    if (url.pathname in commonResponses) {
      await fulfillJson(route, commonResponses[url.pathname]);
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html?role=owner");
  await expect(page.getByTestId("input-first-name-staff-pending")).toHaveValue("Pat");
  await page.getByTestId("input-first-name-staff-pending").fill("Draft Pat");
  await page.getByTestId("list-item-clerk-user_donard").click();
  await expect(page.getByTestId("card-clerk-account-user_donard")).toBeVisible();
  await page.getByTestId("list-item-staff-staff-hidden").click();
  await expect(page.getByTestId("card-staff-staff-hidden")).toBeVisible();
  await page.getByTestId("list-item-staff-staff-pending").click();
  await expect(page.getByTestId("input-first-name-staff-pending")).toHaveValue("Draft Pat");

  serverPendingProfile = { ...serverPendingProfile, firstName: "Server Pat" };
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect(page.getByRole("heading", { name: "Server Pat Pending" })).toBeVisible();
  await expect(page.getByTestId("input-first-name-staff-pending")).toHaveValue("Draft Pat");
});

test("owner directory pagination loads the next Clerk page inside the roster", async ({ page }) => {
  const firstPage = Array.from({ length: 20 }, (_, index) => ({
    ...account,
    clerkUserId: `user_page${index}`,
    email: `page${index}@example.com`,
    firstName: `Page${index}`,
    lastName: "Person",
  }));
  const secondPage = {
    ...account,
    clerkUserId: "user_page20",
    email: "page20@example.com",
    firstName: "Page20",
    lastName: "Person",
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/staff-access/accounts") {
      const exactId = url.searchParams.get("clerkUserId");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (exactId) {
        const exact = exactId === secondPage.clerkUserId ? [secondPage] : [];
        await fulfillJson(route, { accounts: exact, totalCount: exact.length, nextOffset: null });
      } else if (offset === 0) {
        await fulfillJson(route, { accounts: firstPage, totalCount: 21, nextOffset: 20 });
      } else {
        await fulfillJson(route, { accounts: [secondPage], totalCount: 21, nextOffset: null });
      }
      return;
    }
    if (url.pathname in commonResponses) {
      await fulfillJson(route, commonResponses[url.pathname]);
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html?role=owner");
  await expect(page.getByTestId("list-item-clerk-user_page0")).toBeVisible();
  await expect(page.getByTestId("list-item-clerk-user_page19")).toBeVisible();
  await page.getByTestId("button-next-staff-accounts").click();
  await expect(page.getByTestId("list-item-clerk-user_page20")).toBeVisible();
  await expect(page.getByTestId("text-staff-account-count")).toHaveText("21–21 of 21");
});