import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

const NOW = new Date("2026-09-21T13:00:00-04:00");
const ACCEPTED_AT = "2026-09-21T16:32:00.000Z";
const ACCEPTED_ID = "10000000-0000-4000-8000-000000000001";
const UNKNOWN_ID = "10000000-0000-4000-8000-000000000002";
const SUBMITTING_ID = "10000000-0000-4000-8000-000000000003";

type AttemptStatus = "accepted" | "rejected" | "submitting" | "unknown";

type EmailAttempt = {
  id: string;
  senderId: string;
  senderName: string;
  status: AttemptStatus;
  provider: string;
  messageId: string | null;
  outcome: string;
  createdAt: string;
  updatedAt: string;
};

const acceptedAttempt: EmailAttempt = {
  id: ACCEPTED_ID,
  senderId: "staff-id",
  senderName: "Test Staff",
  status: "accepted",
  provider: "sendgrid",
  messageId: "SG-message-123",
  outcome: "Accepted by provider; customer delivery is not confirmed.",
  createdAt: ACCEPTED_AT,
  updatedAt: ACCEPTED_AT,
};

const unknownAttempt: EmailAttempt = {
  id: UNKNOWN_ID,
  senderId: "staff-id",
  senderName: "Test Staff",
  status: "unknown",
  provider: "sendgrid",
  messageId: null,
  outcome: "Provider acceptance could not be confirmed.",
  createdAt: ACCEPTED_AT,
  updatedAt: ACCEPTED_AT,
};

const submittingAttempt: EmailAttempt = {
  id: SUBMITTING_ID,
  senderId: "staff-id",
  senderName: "Test Staff",
  status: "submitting",
  provider: "sendgrid",
  messageId: null,
  outcome: "Provider submission is still in progress.",
  createdAt: ACCEPTED_AT,
  updatedAt: ACCEPTED_AT,
};

type MockOptions = {
  initialAttempts?: EmailAttempt[];
  failHistoryUntilRefresh?: boolean;
  holdPost?: boolean;
  abortPost?: boolean;
};

async function mockApi(page: Page, options: MockOptions = {}) {
  await page.clock.setFixedTime(NOW);
  let attempts = [...(options.initialAttempts ?? [])];
  let historyUnavailable = options.failHistoryUntilRefresh ?? false;
  let historyReads = 0;
  let releasePost: (() => void) | undefined;
  const posts: Record<string, unknown>[] = [];

  const intakes = [
    {
      id: 31,
      customerName: "Priya Natarajan",
      phoneNumber: "+19545550104",
      emailAddress: "priya@example.com",
      contactPreference: "text",
      serviceType: "virus_removal",
      serviceTypeOther: null,
      deviceType: "laptop",
      deviceBrandModel: "Dell XPS 13",
      operatingSystem: "Windows 11",
      problemDescription: "Pop-ups every few minutes and browser homepage keeps changing.",
      howDidYouHear: "Google",
      isFromActiveCall: false,
      callNotes: null,
      source: "Website Intake Form",
      campaign: "fall-tuneup",
      status: "new",
      internalNotes: null,
      followUpDate: null,
      createdAt: "2026-09-21T16:40:00.000Z",
    },
    {
      id: 32,
      customerName: "Tom Becker",
      phoneNumber: "+19545550105",
      emailAddress: "tom@example.com",
      contactPreference: "call",
      serviceType: "Other",
      serviceTypeOther: "Smart TV setup",
      deviceType: "other",
      deviceBrandModel: "Samsung QN90",
      operatingSystem: "Tizen",
      problemDescription: "Needs help mounting and connecting to Wi-Fi.",
      howDidYouHear: "Referral",
      isFromActiveCall: true,
      callNotes: "Prefers Saturday.",
      source: "Phone Link",
      campaign: null,
      status: "contacted",
      internalNotes: "Quote sent.",
      followUpDate: "2026-09-21T20:00:00.000Z",
      createdAt: "2026-09-21T15:00:00.000Z",
    },
  ];

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (request.method() === "GET" && path === "/api/intake/32/email-history") {
      historyReads += 1;
      if (historyUnavailable) return json({ message: "History unavailable" }, 503);
      return json({ attempts });
    }

    if (request.method() === "POST" && path === "/api/intake/32/email") {
      posts.push(request.postDataJSON() as Record<string, unknown>);
      if (options.abortPost) {
        attempts = [{
          ...unknownAttempt,
          createdAt: ACCEPTED_AT,
          updatedAt: ACCEPTED_AT,
        }];
        return route.abort();
      }
      if (options.holdPost) {
        await new Promise<void>((resolve) => {
          releasePost = resolve;
        });
      }
      attempts = [{ ...acceptedAttempt }, ...attempts];
      return json({ submitted: true });
    }

    // The fixture mirrors the board mocks in tech-board.spec.ts. Every API
    // request is intercepted, including unrelated routes, so tests cannot
    // reach a real service.
    if (path === "/api/crm/jobs") return json([]);
    if (path === "/api/crm/contacts") return json([]);
    if (path === "/api/booking/appointments") return json([]);
    if (path === "/api/intake") return json({ intakes, total: intakes.length, page: 1, totalPages: 1 });
    if (path === "/api/call-tracking/calls") return json([]);
    return json({}, 404);
  });

  return {
    posts,
    historyReadCount: () => historyReads,
    allowHistoryRefresh: () => { historyUnavailable = false; },
    releasePost: () => releasePost?.(),
  };
}

async function openRequest(page: Page) {
  await page.goto("/tests/tech-board.fixture.html");
  await page.getByTestId("board-intake-32").click();
  const detail = page.getByTestId("board-detail");
  await expect(detail.getByTestId("board-detail-title")).toHaveText("Tom Becker");
  return detail;
}

async function openComposer(detail: Locator, page: Page) {
  await detail.getByTestId("button-service-request-email").click();
  const dialog = page.getByTestId("service-request-email-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function fillMessage(dialog: Locator) {
  await dialog.getByLabel("Subject").fill("Service request update");
  await dialog.getByLabel("Message").fill("We can help with your setup.");
}

test("request detail history displays known acceptance and unknown warnings with acknowledgement gating", async ({ page }) => {
  await mockApi(page, { initialAttempts: [acceptedAttempt, unknownAttempt] });
  const detail = await openRequest(page);
  const detailHistory = detail.getByTestId("service-request-email-history");

  await expect(detailHistory.getByText("Accepted by provider — delivery unconfirmed")).toBeVisible();
  await expect(detailHistory.getByText("Submission outcome unknown — check before retrying")).toBeVisible();
  await expect(detailHistory).toContainText("Test Staff");
  await expect(detailHistory).toContainText("SG-message-123");

  const dialog = await openComposer(detail, page);
  const acknowledgement = dialog.getByRole("checkbox", {
    name: /An earlier email may already have been sent/,
  });
  const send = dialog.getByRole("button", { name: "Send email" });
  await fillMessage(dialog);

  await expect(dialog.getByText("Accepted by provider — delivery unconfirmed")).toBeVisible();
  await expect(dialog.getByText("Submission outcome unknown — check before retrying")).toBeVisible();
  await expect(acknowledgement).not.toBeChecked();
  await expect(send).toBeDisabled();

  await acknowledgement.check();
  await expect(send).toBeEnabled();
  await acknowledgement.uncheck();
  await expect(send).toBeDisabled();
});

test("a submitting history attempt prevents another email from being sent", async ({ page }) => {
  await mockApi(page, { initialAttempts: [submittingAttempt] });
  const detail = await openRequest(page);
  const dialog = await openComposer(detail, page);
  const acknowledgement = dialog.getByRole("checkbox", {
    name: /An earlier email may already have been sent/,
  });
  const send = dialog.getByRole("button", { name: "Send email" });
  await fillMessage(dialog);

  await expect(dialog.getByText("Submission in progress")).toBeVisible();
  await expect(acknowledgement).toBeDisabled();
  await expect(send).toBeDisabled();
});

test("history errors block sending until a manual refresh succeeds", async ({ page }) => {
  const api = await mockApi(page, { failHistoryUntilRefresh: true });
  const detail = await openRequest(page);
  await expect(detail.getByText("Send history is unavailable. Check it before retrying an email.")).toBeVisible();

  const dialog = await openComposer(detail, page);
  await expect(dialog.getByText("Send history is unavailable. Check it before retrying an email.")).toBeVisible();
  await fillMessage(dialog);
  const send = dialog.getByRole("button", { name: "Send email" });
  await expect(send).toBeDisabled();

  api.allowHistoryRefresh();
  await dialog.getByRole("button", { name: "Refresh history" }).click();
  await expect(dialog.getByText("No tracked email attempts for this request.")).toBeVisible();
  await expect(send).toBeEnabled();
  expect(api.posts).toHaveLength(0);
});

test("accepted submissions invalidate history and remain visible after reopening and reloading", async ({ page }) => {
  const api = await mockApi(page);
  let detail = await openRequest(page);
  const dialog = await openComposer(detail, page);
  await fillMessage(dialog);
  const readsBeforeSend = api.historyReadCount();

  await dialog.getByRole("button", { name: "Send email" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Email accepted by provider", { exact: true }).first()).toBeVisible();
  await expect.poll(() => api.historyReadCount()).toBeGreaterThan(readsBeforeSend);
  expect(api.posts).toEqual([{
    expectedEmail: "tom@example.com",
    subject: "Service request update",
    body: "We can help with your setup.",
  }]);

  await page.getByTestId("board-intake-32").click();
  detail = page.getByTestId("board-detail");
  await expect(detail.getByText("Accepted by provider — delivery unconfirmed")).toBeVisible();
  const acceptedRow = detail.getByRole("listitem").filter({ hasText: "SG-message-123" });
  await expect(acceptedRow).toContainText("Test Staff");
  await expect(acceptedRow).toContainText("sendgrid");
  await expect(acceptedRow).toContainText(acceptedAttempt.outcome);
  const localizedCreatedAt = await page.evaluate((value) => new Date(value).toLocaleString(), ACCEPTED_AT);
  await expect(acceptedRow).toContainText(localizedCreatedAt);

  await page.reload();
  await page.getByTestId("board-intake-32").click();
  detail = page.getByTestId("board-detail");
  await expect(detail.getByText("Accepted by provider — delivery unconfirmed")).toBeVisible();
  const reloadedRow = detail.getByRole("listitem").filter({ hasText: "SG-message-123" });
  await expect(reloadedRow).toContainText("Test Staff");
  await expect(reloadedRow).toContainText(localizedCreatedAt);
  await page.screenshot({ path: "test-results/service-request-email-history.png" });
});

test("an aborted browser POST warns honestly and refreshes history to an unknown outcome", async ({ page }) => {
  const api = await mockApi(page, { abortPost: true });
  const detail = await openRequest(page);
  const dialog = await openComposer(detail, page);
  await fillMessage(dialog);
  const readsBeforeSend = api.historyReadCount();

  await dialog.getByRole("button", { name: "Send email" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Submission did not complete normally. The provider may have accepted the email.",
  );
  await expect.poll(() => api.historyReadCount()).toBeGreaterThan(readsBeforeSend);
  await expect(dialog.getByText("Submission outcome unknown — check before retrying")).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /An earlier email may already have been sent/ })).toBeVisible();
  expect(api.posts).toEqual([{
    expectedEmail: "tom@example.com",
    subject: "Service request update",
    body: "We can help with your setup.",
  }]);
});

test("the composer prevents a second click while its POST is still submitting", async ({ page }) => {
  const api = await mockApi(page, { holdPost: true });
  const detail = await openRequest(page);
  const dialog = await openComposer(detail, page);
  await fillMessage(dialog);

  await dialog.getByRole("button", { name: "Send email" }).click();
  const sending = dialog.getByRole("button", { name: "Sending…" });
  await expect(sending).toBeDisabled();
  expect(api.posts).toHaveLength(1);
  await sending.evaluate((button: HTMLButtonElement) => button.click());
  expect(api.posts).toHaveLength(1);

  api.releasePost();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Email accepted by provider", { exact: true }).first()).toBeVisible();
});