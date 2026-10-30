import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";

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

const profile = {
  id: "staff-1",
  email: "test.staff@example.com",
  firstName: "Test",
  lastName: "Staff",
  role: "field_technician",
  approvalStatus: "approved",
  isOwner: false,
  features,
  effectiveFeatures: features,
  capabilities: { viewVoicemails: false },
  assignments: { clientIds: [1], jobIds: [10], contactAssignments: [] },
  updatedAt: "2026-09-09T12:00:00.000Z",
};

// The roster and selected detail both show email. Use the stable profile ID,
// and explicitly select a person before checking their mounted detail panel.
async function selectStaff(page: Page, id = profile.id) {
  await page.getByTestId(`list-item-staff-${id}`).click();
  const card = page.getByTestId(`card-staff-${id}`);
  await expect(card).toBeVisible();
  return card;
}

async function expectStaffLoaded(page: Page) {
  await expect(page.getByTestId(`list-item-staff-${profile.id}`)).toBeVisible();
  await selectStaff(page);
}

async function exerciseCrossTypeRace(
  browser: Browser,
  winningMutation: "assignments" | "access",
) {
  let currentProfile = structuredClone(profile);
  const accountingFeatures = { ...features, invoices: true, reports: true };

  const handleApi = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() === "PUT" && path === "/api/staff-access/staff-1/assignments") {
      const body = request.postDataJSON() as {
        clientIds: number[];
        jobIds: number[];
        expectedUpdatedAt: string;
      };
      if (body.expectedUpdatedAt !== currentProfile.updatedAt) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            message: "This staff member's assignments changed since you loaded them. Review the latest assignments and try again.",
            latestAccess: currentProfile,
          }),
        });
        return;
      }
      currentProfile = {
        ...currentProfile,
        assignments: { ...currentProfile.assignments, clientIds: body.clientIds, jobIds: body.jobIds },
        updatedAt: "2026-09-09T12:01:00.000Z",
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentProfile) });
      return;
    }

    if (request.method() === "PATCH" && path === "/api/staff-access/staff-1") {
      const body = request.postDataJSON() as {
        role: string;
        approvalStatus: string;
        features: typeof features;
        capabilities: { viewVoicemails: boolean };
        expectedUpdatedAt: string;
      };
      if (body.expectedUpdatedAt !== currentProfile.updatedAt) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            message: "This staff member's access changed since you loaded it. Review the latest settings and try again.",
            latestAccess: currentProfile,
          }),
        });
        return;
      }
      currentProfile = {
        ...currentProfile,
        role: body.role as typeof currentProfile.role,
        approvalStatus: body.approvalStatus as typeof currentProfile.approvalStatus,
        features: body.features,
        effectiveFeatures: body.features,
        capabilities: body.capabilities,
        updatedAt: "2026-09-09T12:01:00.000Z",
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentProfile) });
      return;
    }

    const responses: Record<string, unknown> = {
      "/api/staff-access": [currentProfile],
      "/api/staff-access/role-features": {
        administrator: features,
        field_technician: features,
        software_developer: features,
        accounting: accountingFeatures,
        it_manager: features,
        legal_team: features,
        secretary: features,
      },
      "/api/staff-access/audit": [],
      "/api/clients": [
        { id: 1, name: "Alpha Customer" },
        { id: 2, name: "Beta Customer" },
      ],
      "/api/crm/jobs": [
        { id: 10, jobNumber: "JOB-100", clientName: "Alpha Customer" },
        { id: 20, jobNumber: "JOB-200", clientName: "Beta Customer" },
      ],
    };
    if (path in responses) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path]) });
      return;
    }
    await route.abort();
  };

  const createAdministratorSession = async () => {
    const context = await browser.newContext();
    await context.route("**/api/**", handleApi);
    return context;
  };
  const winnerContext = await createAdministratorSession();
  const staleContext = await createAdministratorSession();
  const winnerPage = await winnerContext.newPage();
  const stalePage = await staleContext.newPage();

  try {
    await Promise.all([
      winnerPage.goto("/tests/staff-access.fixture.html"),
      stalePage.goto("/tests/staff-access.fixture.html"),
    ]);
    await Promise.all([
      expectStaffLoaded(winnerPage),
      expectStaffLoaded(stalePage),
    ]);

    if (winningMutation === "assignments") {
      await winnerPage.getByRole("checkbox", { name: "Beta Customer", exact: true }).click();
      await expect(winnerPage.getByText("Assignments updated", { exact: true })).toBeVisible();

      await stalePage.getByRole("combobox").selectOption("accounting");
      await expect(stalePage.getByText("Access could not be updated", { exact: true })).toBeVisible();
    } else {
      await winnerPage.getByRole("combobox").selectOption("accounting");
      await expect(winnerPage.getByText("Access status updated", { exact: true })).toBeVisible();

      await stalePage.getByRole("checkbox", { name: "Beta Customer", exact: true }).click();
      await expect(stalePage.getByText("Assignments could not be updated", { exact: true })).toBeVisible();
    }

    await expect(stalePage.getByText("Access changed while this page was open")).toBeVisible();
    await stalePage.getByRole("button", { name: "Reload current settings" }).click();
    await expect(stalePage.getByText("Access changed while this page was open")).toBeHidden();

    await expect(stalePage.getByRole("combobox")).toHaveValue(winningMutation === "access" ? "accounting" : "field_technician");
    await expect(stalePage.locator("label").filter({ hasText: "Invoices" }).getByRole("switch"))
      .toBeChecked({ checked: winningMutation === "access" });
    await expect(stalePage.locator("label").filter({ hasText: "Reports" }).getByRole("switch"))
      .toBeChecked({ checked: winningMutation === "access" });
    await expect(stalePage.getByRole("checkbox", { name: "Alpha Customer", exact: true })).toBeChecked();
    await expect(stalePage.getByRole("checkbox", { name: "Beta Customer", exact: true }))
      .toBeChecked({ checked: winningMutation === "assignments" });
    await expect(stalePage.getByTestId("assignment-job-staff-1-10").getByRole("checkbox")).toBeChecked();
    await expect(stalePage.getByTestId("assignment-job-staff-1-20").getByRole("checkbox")).not.toBeChecked();
  } finally {
    await Promise.all([winnerContext.close(), staleContext.close()]);
  }
}

test("an assignment save wins over a stale role and feature save", async ({ browser }) => {
  await exerciseCrossTypeRace(browser, "assignments");
});

test("a role and feature save wins over a stale assignment save", async ({ browser }) => {
  await exerciseCrossTypeRace(browser, "access");
});

test("a stale administrator reloads the winning customer and job assignments", async ({ browser }) => {
  let currentProfile = structuredClone(profile);

  const handleApi = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() === "PUT" && path === "/api/staff-access/staff-1/assignments") {
      const body = request.postDataJSON() as {
        clientIds: number[];
        jobIds: number[];
        expectedUpdatedAt: string;
      };

      if (body.expectedUpdatedAt !== currentProfile.updatedAt) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            message: "This staff member's assignments changed since you loaded them. Review the latest assignments and try again.",
            latestAccess: currentProfile,
          }),
        });
        return;
      }

      currentProfile = {
        ...currentProfile,
        assignments: { ...currentProfile.assignments, clientIds: body.clientIds, jobIds: body.jobIds },
        updatedAt: "2026-09-09T12:01:00.000Z",
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentProfile) });
      return;
    }

    const responses: Record<string, unknown> = {
      "/api/staff-access": [currentProfile],
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
      "/api/clients": [
        { id: 1, name: "Alpha Customer" },
        { id: 2, name: "Beta Customer" },
      ],
      "/api/crm/jobs": [
        { id: 10, jobNumber: "JOB-100", clientName: "Alpha Customer" },
        { id: 20, jobNumber: "JOB-200", clientName: "Beta Customer" },
      ],
    };

    if (path in responses) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path]) });
      return;
    }
    await route.abort();
  };

  const createAdministratorSession = async (): Promise<BrowserContext> => {
    const context = await browser.newContext();
    await context.route("**/api/**", handleApi);
    return context;
  };

  const winnerContext = await createAdministratorSession();
  const staleContext = await createAdministratorSession();
  const winnerPage = await winnerContext.newPage();
  const stalePage = await staleContext.newPage();

  await Promise.all([
    winnerPage.goto("/tests/staff-access.fixture.html"),
    stalePage.goto("/tests/staff-access.fixture.html"),
  ]);
  await Promise.all([
    expectStaffLoaded(winnerPage),
    expectStaffLoaded(stalePage),
  ]);

  await winnerPage.getByRole("checkbox", { name: "Beta Customer", exact: true }).click();
  await expect(winnerPage.getByText("Assignments updated", { exact: true })).toBeVisible();

  await stalePage.getByTestId("assignment-job-staff-1-20").getByRole("checkbox").click();
  await expect(stalePage.getByText("Access changed while this page was open")).toBeVisible();
  await expect(stalePage.getByText("Assignments could not be updated", { exact: true })).toBeVisible();

  await stalePage.getByRole("button", { name: "Reload current settings" }).click();
  await expect(stalePage.getByText("Access changed while this page was open")).toBeHidden();
  await expect(stalePage.getByRole("checkbox", { name: "Alpha Customer", exact: true })).toBeChecked();
  await expect(stalePage.getByRole("checkbox", { name: "Beta Customer", exact: true })).toBeChecked();
  await expect(stalePage.getByTestId("assignment-job-staff-1-10").getByRole("checkbox")).toBeChecked();
  await expect(stalePage.getByTestId("assignment-job-staff-1-20").getByRole("checkbox")).not.toBeChecked();

  await Promise.all([winnerContext.close(), staleContext.close()]);
});

test("a stale administrator reloads the winning role, features, approval, and voicemail access", async ({ browser }) => {
  let currentProfile = {
    ...structuredClone(profile),
    approvalStatus: "pending" as const,
  };
  const accountingFeatures = {
    ...features,
    invoices: true,
    reports: true,
  };
  const updatedVersions = [
    "2026-09-09T12:01:00.000Z",
    "2026-09-09T12:02:00.000Z",
    "2026-09-09T12:03:00.000Z",
  ];
  let updateCount = 0;

  const handleApi = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() === "PATCH" && path === "/api/staff-access/staff-1") {
      const body = request.postDataJSON() as {
        role: string;
        approvalStatus: string;
        features: typeof features;
        capabilities: { viewVoicemails: boolean };
        expectedUpdatedAt: string;
      };

      if (body.expectedUpdatedAt !== currentProfile.updatedAt) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            message: "This staff member's access changed since you loaded it. Review the latest settings and try again.",
            latestAccess: currentProfile,
          }),
        });
        return;
      }

      currentProfile = {
        ...currentProfile,
        role: body.role as typeof currentProfile.role,
        approvalStatus: body.approvalStatus as typeof currentProfile.approvalStatus,
        features: body.features,
        effectiveFeatures: body.features,
        capabilities: body.capabilities,
        updatedAt: updatedVersions[updateCount++] ?? updatedVersions[updatedVersions.length - 1],
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentProfile) });
      return;
    }

    const responses: Record<string, unknown> = {
      "/api/staff-access": [currentProfile],
      "/api/staff-access/role-features": {
        administrator: features,
        field_technician: features,
        software_developer: features,
        accounting: accountingFeatures,
        it_manager: features,
        legal_team: features,
        secretary: features,
      },
      "/api/staff-access/audit": [],
      "/api/clients": [
        { id: 1, name: "Alpha Customer" },
        { id: 2, name: "Beta Customer" },
      ],
      "/api/crm/jobs": [
        { id: 10, jobNumber: "JOB-100", clientName: "Alpha Customer" },
        { id: 20, jobNumber: "JOB-200", clientName: "Beta Customer" },
      ],
    };

    if (path in responses) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path]) });
      return;
    }
    await route.abort();
  };

  const createAdministratorSession = async (): Promise<BrowserContext> => {
    const context = await browser.newContext();
    await context.route("**/api/**", handleApi);
    return context;
  };

  const winnerContext = await createAdministratorSession();
  const staleContext = await createAdministratorSession();
  const winnerPage = await winnerContext.newPage();
  const stalePage = await staleContext.newPage();

  await Promise.all([
    winnerPage.goto("/tests/staff-access.fixture.html"),
    stalePage.goto("/tests/staff-access.fixture.html"),
  ]);
  await Promise.all([
    expectStaffLoaded(winnerPage),
    expectStaffLoaded(stalePage),
  ]);

  await winnerPage.getByRole("combobox").selectOption("accounting");
  await expect(winnerPage.getByText("Access status updated", { exact: true })).toBeVisible();
  await winnerPage.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(winnerPage.getByTestId("badge-status-approved-staff-1")).toBeVisible();
  const winnerVoicemailSwitch = winnerPage.locator("label").filter({ hasText: "View voicemails" }).getByRole("switch");
  await winnerVoicemailSwitch.click();
  await expect(winnerVoicemailSwitch).toBeChecked();
  await expect(winnerVoicemailSwitch).toBeEnabled();

  await stalePage.locator("label").filter({ hasText: "Invoices" }).getByRole("switch").click();
  await expect(stalePage.getByText("Access changed while this page was open")).toBeVisible();
  await expect(stalePage.getByText("Access could not be updated", { exact: true })).toBeVisible();

  await stalePage.getByRole("button", { name: "Reload current settings" }).click();
  await expect(stalePage.getByText("Access changed while this page was open")).toBeHidden();
  await expect(stalePage.getByRole("combobox")).toHaveValue("accounting");
  await expect(stalePage.getByText("Approved", { exact: true })).toBeVisible();
  await expect(stalePage.locator("label").filter({ hasText: "Invoices" }).getByRole("switch")).toBeChecked();
  await expect(stalePage.locator("label").filter({ hasText: "Reports" }).getByRole("switch")).toBeChecked();
  await expect(stalePage.locator("label").filter({ hasText: "Communications" }).getByRole("switch")).not.toBeChecked();
  await expect(stalePage.locator("label").filter({ hasText: "View voicemails" }).getByRole("switch")).toBeChecked();

  await Promise.all([winnerContext.close(), staleContext.close()]);
});

test("a failed conflict reload keeps the warning visible", async ({ page }) => {
  let currentProfile = structuredClone(profile);
  let reloadFailure: "http" | "unusable" | null = null;
  const recoveryEvents: Array<Record<string, unknown>> = [];
  const recoveryAudit: Array<Record<string, unknown>> = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/staff-access/staff-1/recovery-audit") {
      const body = request.postDataJSON() as Record<string, unknown>;
      recoveryEvents.push(body);
      const outcome = body.outcome === "failed" ? "failed" : "succeeded";
      recoveryAudit.unshift({
        id: `recovery-${recoveryEvents.length}`,
        action: `conflict_recovery_${outcome}`,
        previousAccess: { recovery: "conflict" },
        newAccess: { outcome },
        createdAt: `2026-09-09T12:0${recoveryEvents.length}:00.000Z`,
        targetEmail: profile.email,
        actorEmail: "administrator@example.com",
      });
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === "PUT" && path === "/api/staff-access/staff-1/assignments") {
      currentProfile = {
        ...currentProfile,
        assignments: { ...profile.assignments, clientIds: [1, 2], jobIds: [10] },
        updatedAt: "2026-09-09T12:01:00.000Z",
      };
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          message: "This staff member's assignments changed since you loaded them. Review the latest assignments and try again.",
          latestAccess: currentProfile,
        }),
      });
      return;
    }
    if (path === "/api/staff-access" && reloadFailure === "http") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Unavailable" }) });
      return;
    }
    if (path === "/api/staff-access" && reloadFailure === "unusable") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unexpected: true }) });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/staff-access": [currentProfile],
      "/api/staff-access/role-features": {
        administrator: features,
        field_technician: features,
        software_developer: features,
        accounting: features,
        it_manager: features,
        legal_team: features,
        secretary: features,
      },
      "/api/staff-access/audit": recoveryAudit,
      "/api/clients": [{ id: 1, name: "Alpha Customer" }, { id: 2, name: "Beta Customer" }],
      "/api/crm/jobs": [{ id: 10, jobNumber: "JOB-100", clientName: "Alpha Customer" }],
    };
    if (path in responses) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path]) });
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html");
  await expectStaffLoaded(page);
  await page.getByRole("checkbox", { name: "Beta Customer", exact: true }).click();
  await expect(page.getByText("Access changed while this page was open")).toBeVisible();

  reloadFailure = "http";
  await page.getByRole("button", { name: "Reload current settings" }).click();
  await expect(page.getByText("Current settings could not be reloaded", { exact: true })).toBeVisible();
  await expect(page.getByText("Access changed while this page was open")).toBeVisible();
  await expect.poll(() => recoveryEvents.length).toBe(1);
  expect(recoveryEvents[0]).toEqual({ outcome: "failed" });
  await expect(page.getByText("Recovery failed", { exact: true })).toBeVisible();

  reloadFailure = "unusable";
  await page.getByRole("button", { name: "Reload current settings" }).click();
  await expect(page.getByText("Current settings could not be reloaded", { exact: true })).toBeVisible();
  await expect(page.getByText("Access changed while this page was open")).toBeVisible();
  await expect.poll(() => recoveryEvents.length).toBe(2);
  expect(recoveryEvents[1]).toEqual({ outcome: "failed" });

  reloadFailure = null;
  await page.getByRole("button", { name: "Reload current settings" }).click();
  await expect(page.getByText("Access changed while this page was open")).toBeHidden();
  await expect(page.getByRole("checkbox", { name: "Beta Customer", exact: true })).toBeChecked();
  await expect.poll(() => recoveryEvents.length).toBe(3);
  expect(recoveryEvents[2]).toEqual({ outcome: "succeeded" });
  await expect(page.getByText("Recovery succeeded", { exact: true })).toBeVisible();
});

async function exerciseOverlappingConflictReloads(
  page: import("@playwright/test").Page,
  responseOrder: "older-success-newer-failure" | "older-failure-newer-success",
) {
  let currentProfile = structuredClone(profile);
  let reloadGateEnabled = false;
  let reloadCount = 0;
  const pendingReloads: Record<number, (outcome: "success" | "failure") => void> = {};
  const latestProfile = {
    ...structuredClone(profile),
    role: "accounting" as const,
    features: { ...features, invoices: true, reports: true },
    effectiveFeatures: { ...features, invoices: true, reports: true },
    updatedAt: "2026-09-09T12:02:00.000Z",
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() === "PUT" && path === "/api/staff-access/staff-1/assignments") {
      currentProfile = {
        ...currentProfile,
        assignments: { ...profile.assignments, clientIds: [1, 2], jobIds: [10] },
        updatedAt: "2026-09-09T12:01:00.000Z",
      };
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          message: "This staff member's assignments changed since you loaded them. Review the latest assignments and try again.",
          latestAccess: currentProfile,
        }),
      });
      return;
    }

    if (request.method() === "GET" && path === "/api/staff-access" && reloadGateEnabled) {
      const requestNumber = ++reloadCount;
      await new Promise<"success" | "failure">((resolve) => {
        pendingReloads[requestNumber] = resolve;
      }).then(async (outcome) => {
        if (outcome === "failure") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Unavailable" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([requestNumber === 2 ? latestProfile : profile]),
        });
      });
      return;
    }

    const responses: Record<string, unknown> = {
      "/api/staff-access": [currentProfile],
      "/api/staff-access/role-features": {
        administrator: features,
        field_technician: features,
        software_developer: features,
        accounting: latestProfile.features,
        it_manager: features,
        legal_team: features,
        secretary: features,
      },
      "/api/staff-access/audit": [],
      "/api/clients": [{ id: 1, name: "Alpha Customer" }, { id: 2, name: "Beta Customer" }],
      "/api/crm/jobs": [{ id: 10, jobNumber: "JOB-100", clientName: "Alpha Customer" }],
    };
    if (path in responses) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path]) });
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html");
  await expectStaffLoaded(page);
  await page.getByRole("checkbox", { name: "Beta Customer", exact: true }).click();
  await expect(page.getByText("Access changed while this page was open")).toBeVisible();

  reloadGateEnabled = true;
  const reloadButton = page.getByRole("button", { name: "Reload current settings" });
  await reloadButton.click();
  await expect.poll(() => reloadCount).toBe(1);
  await expect(reloadButton).toBeDisabled();
  // The current UI prevents duplicate reloads. Cancel the pending request
  // before retrying, then deliver its late response in either order.
  await page.getByRole("button", { name: "Cancel reload" }).click();
  await reloadButton.click();
  await expect.poll(() => reloadCount).toBe(2);
  const reloadStatus = page.getByText("Reloading current settings…", { exact: true });
  await expect(reloadStatus).toBeVisible();

  if (responseOrder === "older-success-newer-failure") {
    pendingReloads[2]("failure");
    await expect(reloadStatus).toBeHidden();
    await expect(page.getByText("Current settings could not be reloaded", { exact: true })).toBeVisible();
    await expect(page.getByText("Access changed while this page was open")).toBeVisible();
    pendingReloads[1]("success");
    await expect(reloadStatus).toBeHidden();
    await expect(page.getByText("Access changed while this page was open")).toBeVisible();
    return;
  }

  pendingReloads[1]("failure");
  await expect(reloadStatus).toBeVisible();
  pendingReloads[2]("success");
  await expect(page.getByText("Access changed while this page was open")).toBeHidden();
  await expect(reloadStatus).toBeHidden();
  await expect(page.getByRole("combobox")).toHaveValue("accounting");
  await expect(page.locator("label").filter({ hasText: "Invoices" }).getByRole("switch")).toBeChecked();
  await expect(page.locator("label").filter({ hasText: "Reports" }).getByRole("switch")).toBeChecked();
}

test("an older successful reload cannot hide a newer reload failure", async ({ page }) => {
  await exerciseOverlappingConflictReloads(page, "older-success-newer-failure");
});

test("the newest successful reload clears only its matching conflict", async ({ page }) => {
  await exerciseOverlappingConflictReloads(page, "older-failure-newer-success");
});

test("cancelling a stuck staff reload ignores its late response and leaves another reload pending", async ({ page }) => {
  const secondProfile = {
    ...structuredClone(profile),
    id: "staff-2",
    email: "second.staff@example.com",
    firstName: "Second",
    assignments: { ...profile.assignments, clientIds: [2], jobIds: [20] },
  };
  const initialProfiles = [structuredClone(profile), secondProfile];
  const conflictedProfiles = {
    "staff-1": {
      ...structuredClone(profile),
      assignments: { ...profile.assignments, clientIds: [1, 2], jobIds: [10] },
      updatedAt: "2026-09-09T12:01:00.000Z",
    },
    "staff-2": {
      ...secondProfile,
      assignments: { ...profile.assignments, clientIds: [1, 2], jobIds: [20] },
      updatedAt: "2026-09-09T12:01:00.000Z",
    },
  };
  const lateProfiles = [
    {
      ...conflictedProfiles["staff-1"],
      role: "accounting" as const,
      features: { ...features, invoices: true, reports: true },
      effectiveFeatures: { ...features, invoices: true, reports: true },
      updatedAt: "2026-09-09T12:02:00.000Z",
    },
    {
      ...conflictedProfiles["staff-2"],
      role: "it_manager" as const,
      features: { ...features, operations: true, helpdesk: true },
      effectiveFeatures: { ...features, operations: true, helpdesk: true },
      updatedAt: "2026-09-09T12:03:00.000Z",
    },
  ];
  let reloadsEnabled = false;
  let reloadCount = 0;
  const pendingReloads: Record<string, () => void> = {};
  const recoveryEvents: Array<{ profileId: string; outcome: unknown }> = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const assignmentMatch = path.match(/^\/api\/staff-access\/(staff-[12])\/assignments$/);
    if (request.method() === "PUT" && assignmentMatch) {
      const profileId = assignmentMatch[1] as keyof typeof conflictedProfiles;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          message: "This staff member's assignments changed since you loaded them.",
          latestAccess: conflictedProfiles[profileId],
        }),
      });
      return;
    }
    if (request.method() === "GET" && path === "/api/staff-access" && reloadsEnabled) {
      const requestKey = ["staff-1-cancelled", "staff-2", "staff-1-new"][reloadCount++];
      await new Promise<void>((resolve) => {
        pendingReloads[requestKey] = resolve;
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(lateProfiles),
      });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/recovery-audit")) {
      recoveryEvents.push({
        profileId: path.split("/").at(-2) ?? "",
        outcome: (request.postDataJSON() as { outcome?: unknown }).outcome,
      });
      await route.fulfill({ status: 204 });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/staff-access": initialProfiles,
      "/api/staff-access/role-features": {
        administrator: features,
        field_technician: features,
        software_developer: features,
        accounting: lateProfiles[0].features,
        it_manager: lateProfiles[1].features,
        legal_team: features,
        secretary: features,
      },
      "/api/staff-access/audit": [],
      "/api/clients": [{ id: 1, name: "Alpha Customer" }, { id: 2, name: "Beta Customer" }],
      "/api/crm/jobs": [
        { id: 10, jobNumber: "JOB-100", clientName: "Alpha Customer" },
        { id: 20, jobNumber: "JOB-200", clientName: "Beta Customer" },
      ],
    };
    if (path in responses) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path]) });
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/staff-access.fixture.html");
  const firstCard = await selectStaff(page);
  const secondCard = page.getByTestId("card-staff-staff-2");

  await firstCard.getByRole("checkbox", { name: "Beta Customer", exact: true }).click();
  await expect(firstCard.getByText("Access changed while this page was open")).toBeVisible();
  await selectStaff(page, "staff-2");
  await secondCard.getByRole("checkbox", { name: "Alpha Customer", exact: true }).click();
  await expect(secondCard.getByText("Access changed while this page was open")).toBeVisible();
  await selectStaff(page);
  reloadsEnabled = true;
  await firstCard.getByRole("button", { name: "Reload current settings" }).click();
  await expect.poll(() => Object.keys(pendingReloads)).toEqual(["staff-1-cancelled"]);
  await selectStaff(page, "staff-2");
  await secondCard.getByRole("button", { name: "Reload current settings" }).click();
  await expect.poll(() => Object.keys(pendingReloads).length).toBe(2);

  await selectStaff(page);
  await firstCard.getByRole("button", { name: "Cancel reload" }).click();
  await expect(firstCard.getByText("Reloading current settings…", { exact: true })).toBeHidden();
  await expect(firstCard.getByText("Access changed while this page was open")).toBeVisible();
  await selectStaff(page, "staff-2");
  await expect(secondCard.getByText("Reloading current settings…", { exact: true })).toBeVisible();

  await selectStaff(page);
  await firstCard.getByRole("button", { name: "Reload current settings" }).click();
  await expect.poll(() => Object.keys(pendingReloads).length).toBe(3);
  await expect(firstCard.getByText("Reloading current settings…", { exact: true })).toBeVisible();

  pendingReloads["staff-1-cancelled"]();
  await expect(firstCard.getByText("Access changed while this page was open")).toBeVisible();
  await expect(firstCard.getByText("Reloading current settings…", { exact: true })).toBeVisible();
  await expect(firstCard.getByRole("combobox")).toHaveValue("field_technician");
  await selectStaff(page, "staff-2");
  await expect(secondCard.getByText("Reloading current settings…", { exact: true })).toBeVisible();
  await expect(secondCard.getByRole("combobox")).toHaveValue("field_technician");

  pendingReloads["staff-1-new"]();
  await expect.poll(() => recoveryEvents.length).toBe(1);
  await selectStaff(page);
  await expect(firstCard.getByText("Access changed while this page was open")).toBeHidden();
  await expect(firstCard.getByText("Reloading current settings…", { exact: true })).toBeHidden();
  await expect(firstCard.getByRole("combobox")).toHaveValue("accounting");
  await expect.poll(() => recoveryEvents).toEqual([
    { profileId: "staff-1", outcome: "succeeded" },
  ]);

  await selectStaff(page, "staff-2");
  await expect(secondCard.getByText("Reloading current settings…", { exact: true })).toBeVisible();
  pendingReloads["staff-2"]();
  await expect(secondCard.getByText("Access changed while this page was open")).toBeHidden();
  await expect(secondCard.getByRole("combobox")).toHaveValue("it_manager");
  await expect.poll(() => recoveryEvents).toEqual([
    { profileId: "staff-1", outcome: "succeeded" },
    { profileId: "staff-2", outcome: "succeeded" },
  ]);
});

for (const responseOrder of ["staff-1-first", "staff-2-first"] as const) {
  test(`simultaneous staff conflict reloads stay isolated when ${responseOrder} resolves`, async ({ page }) => {
    const secondProfile = {
      ...structuredClone(profile),
      id: "staff-2",
      email: "second.staff@example.com",
      firstName: "Second",
      assignments: { ...profile.assignments, clientIds: [2], jobIds: [20] },
    };
    const initialProfiles = [structuredClone(profile), secondProfile];
    const conflictedProfiles = {
      "staff-1": {
        ...structuredClone(profile),
        assignments: { ...profile.assignments, clientIds: [1, 2], jobIds: [10] },
        updatedAt: "2026-09-09T12:01:00.000Z",
      },
      "staff-2": {
        ...secondProfile,
        assignments: { ...profile.assignments, clientIds: [1, 2], jobIds: [20] },
        updatedAt: "2026-09-09T12:01:00.000Z",
      },
    };
    const latestProfiles = {
      "staff-1": {
        ...conflictedProfiles["staff-1"],
        role: "accounting" as const,
        features: { ...features, invoices: true, reports: true },
        effectiveFeatures: { ...features, invoices: true, reports: true },
        updatedAt: "2026-09-09T12:02:00.000Z",
      },
      "staff-2": {
        ...conflictedProfiles["staff-2"],
        role: "it_manager" as const,
        features: { ...features, operations: true, helpdesk: true },
        effectiveFeatures: { ...features, operations: true, helpdesk: true },
        updatedAt: "2026-09-09T12:03:00.000Z",
      },
    };
    let reloadsEnabled = false;
    const pendingReloads: Record<string, () => void> = {};

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const assignmentMatch = path.match(/^\/api\/staff-access\/(staff-[12])\/assignments$/);
      if (request.method() === "PUT" && assignmentMatch) {
        const profileId = assignmentMatch[1] as keyof typeof conflictedProfiles;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            message: "This staff member's assignments changed since you loaded them.",
            latestAccess: conflictedProfiles[profileId],
          }),
        });
        return;
      }
      if (request.method() === "GET" && path === "/api/staff-access" && reloadsEnabled) {
        const requestedProfileId = Object.keys(pendingReloads).length === 0 ? "staff-1" : "staff-2";
        await new Promise<void>((resolve) => {
          pendingReloads[requestedProfileId] = resolve;
        });
        const otherProfileId = requestedProfileId === "staff-1" ? "staff-2" : "staff-1";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            latestProfiles[requestedProfileId],
            conflictedProfiles[otherProfileId],
          ]),
        });
        return;
      }
      if (request.method() === "POST" && path.endsWith("/recovery-audit")) {
        await route.fulfill({ status: 204 });
        return;
      }
      const responses: Record<string, unknown> = {
        "/api/staff-access": initialProfiles,
        "/api/staff-access/role-features": {
          administrator: features,
          field_technician: features,
          software_developer: features,
          accounting: latestProfiles["staff-1"].features,
          it_manager: latestProfiles["staff-2"].features,
          legal_team: features,
          secretary: features,
        },
        "/api/staff-access/audit": [],
        "/api/clients": [{ id: 1, name: "Alpha Customer" }, { id: 2, name: "Beta Customer" }],
        "/api/crm/jobs": [
          { id: 10, jobNumber: "JOB-100", clientName: "Alpha Customer" },
          { id: 20, jobNumber: "JOB-200", clientName: "Beta Customer" },
        ],
      };
      if (path in responses) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path]) });
        return;
      }
      await route.abort();
    });

    await page.goto("/tests/staff-access.fixture.html");
    const firstCard = await selectStaff(page);
    const secondCard = page.getByTestId("card-staff-staff-2");

    await firstCard.getByRole("checkbox", { name: "Beta Customer", exact: true }).click();
    await expect(firstCard.getByText("Access changed while this page was open")).toBeVisible();
    await selectStaff(page, "staff-2");
    await secondCard.getByRole("checkbox", { name: "Alpha Customer", exact: true }).click();
    await expect(secondCard.getByText("Access changed while this page was open")).toBeVisible();

    reloadsEnabled = true;
    await selectStaff(page);
    await firstCard.getByRole("button", { name: "Reload current settings" }).click();
    await selectStaff(page, "staff-2");
    await secondCard.getByRole("button", { name: "Reload current settings" }).click();
    await expect.poll(() => Object.keys(pendingReloads).length).toBe(2);
    const firstReloadStatus = firstCard.getByText("Reloading current settings…", { exact: true });
    const secondReloadStatus = secondCard.getByText("Reloading current settings…", { exact: true });
    await expect(secondReloadStatus).toBeVisible();
    await selectStaff(page);
    await expect(firstReloadStatus).toBeVisible();

    const firstResolved = responseOrder === "staff-1-first" ? "staff-1" : "staff-2";
    const secondResolved = firstResolved === "staff-1" ? "staff-2" : "staff-1";
    pendingReloads[firstResolved]();
    await selectStaff(page, firstResolved);
    await expect((firstResolved === "staff-1" ? firstCard : secondCard).getByText("Access changed while this page was open")).toBeHidden();
    await expect(firstResolved === "staff-1" ? firstReloadStatus : secondReloadStatus).toBeHidden();
    await selectStaff(page, secondResolved);
    await expect(firstResolved === "staff-1" ? secondReloadStatus : firstReloadStatus).toBeVisible();
    await expect((firstResolved === "staff-1" ? secondCard : firstCard).getByText("Access changed while this page was open")).toBeVisible();
    pendingReloads[secondResolved]();

    await expect((secondResolved === "staff-1" ? firstCard : secondCard).getByText("Access changed while this page was open")).toBeHidden();
    await selectStaff(page);
    await expect(firstCard.getByText("Access changed while this page was open")).toBeHidden();
    await expect(firstReloadStatus).toBeHidden();
    await expect(firstCard.getByRole("combobox")).toHaveValue("accounting");
    await expect(firstCard.locator("label").filter({ hasText: "Invoices" }).getByRole("switch")).toBeChecked();
    await selectStaff(page, "staff-2");
    await expect(secondCard.getByText("Access changed while this page was open")).toBeHidden();
    await expect(secondReloadStatus).toBeHidden();
    await expect(secondCard.getByRole("combobox")).toHaveValue("it_manager");
    await expect(secondCard.locator("label").filter({ hasText: "Devices & operations" }).getByRole("switch")).toBeChecked();
  });
}

for (const responseOrder of ["success-first", "failure-first"] as const) {
  test(`a successful staff reload does not hide another staff warning when ${responseOrder}`, async ({ page }) => {
    const secondProfile = {
      ...structuredClone(profile),
      id: "staff-2",
      email: "second.staff@example.com",
      firstName: "Second",
      assignments: { ...profile.assignments, clientIds: [2], jobIds: [20] },
    };
    const initialProfiles = [structuredClone(profile), secondProfile];
    const conflictedProfiles = {
      "staff-1": {
        ...structuredClone(profile),
        assignments: { ...profile.assignments, clientIds: [1, 2], jobIds: [10] },
        updatedAt: "2026-09-09T12:01:00.000Z",
      },
      "staff-2": {
        ...secondProfile,
        assignments: { ...profile.assignments, clientIds: [1, 2], jobIds: [20] },
        updatedAt: "2026-09-09T12:01:00.000Z",
      },
    };
    const reloadedFirstProfile = {
      ...conflictedProfiles["staff-1"],
      role: "accounting" as const,
      features: { ...features, invoices: true, reports: true },
      effectiveFeatures: { ...features, invoices: true, reports: true },
      updatedAt: "2026-09-09T12:02:00.000Z",
    };
    let reloadsEnabled = false;
    const pendingReloads: Record<string, () => void> = {};

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const assignmentMatch = path.match(/^\/api\/staff-access\/(staff-[12])\/assignments$/);
      if (request.method() === "PUT" && assignmentMatch) {
        const profileId = assignmentMatch[1] as keyof typeof conflictedProfiles;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            message: "This staff member's assignments changed since you loaded them.",
            latestAccess: conflictedProfiles[profileId],
          }),
        });
        return;
      }
      if (request.method() === "GET" && path === "/api/staff-access" && reloadsEnabled) {
        const requestedProfileId = Object.keys(pendingReloads).length === 0 ? "staff-1" : "staff-2";
        await new Promise<void>((resolve) => {
          pendingReloads[requestedProfileId] = resolve;
        });
        if (requestedProfileId === "staff-2") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Unavailable" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([reloadedFirstProfile, conflictedProfiles["staff-2"]]),
        });
        return;
      }
      if (request.method() === "POST" && path.endsWith("/recovery-audit")) {
        await route.fulfill({ status: 204 });
        return;
      }
      const responses: Record<string, unknown> = {
        "/api/staff-access": initialProfiles,
        "/api/staff-access/role-features": {
          administrator: features,
          field_technician: features,
          software_developer: features,
          accounting: reloadedFirstProfile.features,
          it_manager: features,
          legal_team: features,
          secretary: features,
        },
        "/api/staff-access/audit": [],
        "/api/clients": [{ id: 1, name: "Alpha Customer" }, { id: 2, name: "Beta Customer" }],
        "/api/crm/jobs": [
          { id: 10, jobNumber: "JOB-100", clientName: "Alpha Customer" },
          { id: 20, jobNumber: "JOB-200", clientName: "Beta Customer" },
        ],
      };
      if (path in responses) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path]) });
        return;
      }
      await route.abort();
    });

    await page.goto("/tests/staff-access.fixture.html");
    const firstCard = await selectStaff(page);
    const secondCard = page.getByTestId("card-staff-staff-2");

    await firstCard.getByRole("checkbox", { name: "Beta Customer", exact: true }).click();
    await expect(firstCard.getByText("Access changed while this page was open")).toBeVisible();
    await selectStaff(page, "staff-2");
    await secondCard.getByRole("checkbox", { name: "Alpha Customer", exact: true }).click();
    await expect(secondCard.getByText("Access changed while this page was open")).toBeVisible();

    reloadsEnabled = true;
    await selectStaff(page);
    await firstCard.getByRole("button", { name: "Reload current settings" }).click();
    await selectStaff(page, "staff-2");
    await secondCard.getByRole("button", { name: "Reload current settings" }).click();
    await expect.poll(() => Object.keys(pendingReloads).length).toBe(2);

    const firstReloadStatus = firstCard.getByText("Reloading current settings…", { exact: true });
    const secondReloadStatus = secondCard.getByText("Reloading current settings…", { exact: true });
    const firstResolved = responseOrder === "success-first" ? "staff-1" : "staff-2";
    const secondResolved = firstResolved === "staff-1" ? "staff-2" : "staff-1";
    pendingReloads[firstResolved]();

    if (firstResolved === "staff-1") {
      await selectStaff(page);
      await expect(firstCard.getByText("Access changed while this page was open")).toBeHidden();
      await selectStaff(page, "staff-2");
      await expect(secondCard.getByText("Access changed while this page was open")).toBeVisible();
      await expect(secondReloadStatus).toBeVisible();
    } else {
      await expect(secondReloadStatus).toBeHidden();
      await expect(secondCard.getByText("Access changed while this page was open")).toBeVisible();
      await selectStaff(page);
      await expect(firstReloadStatus).toBeVisible();
    }

    pendingReloads[secondResolved]();
    await selectStaff(page);
    await expect(firstReloadStatus).toBeHidden();
    await expect(firstCard.getByText("Access changed while this page was open")).toBeHidden();
    await expect(firstCard.getByRole("combobox")).toHaveValue("accounting");
    await expect(firstCard.locator("label").filter({ hasText: "Invoices" }).getByRole("switch")).toBeChecked();
    await expect(firstCard.getByRole("checkbox", { name: "Beta Customer", exact: true })).toBeChecked();
    await selectStaff(page, "staff-2");
    await expect(secondReloadStatus).toBeHidden();
    await expect(secondCard.getByText("Access changed while this page was open")).toBeVisible();
    await expect(secondCard.getByRole("combobox")).toHaveValue("field_technician");
    await expect(secondCard.locator("label").filter({ hasText: "Devices & operations" }).getByRole("switch")).not.toBeChecked();
    await expect(secondCard.getByRole("checkbox", { name: "Alpha Customer", exact: true })).not.toBeChecked();
    await expect(secondCard.getByRole("checkbox", { name: "Beta Customer", exact: true })).toBeChecked();
  });
}
