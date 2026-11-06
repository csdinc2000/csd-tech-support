import { expect, test, type Page } from "@playwright/test";
import { installPttFakes, routePttApi } from "./ptt-dispatch.harness";

type TestWindow = Window & {
  __pttTest: {
    pttSocket: () => { receive: (payload: unknown) => void; open: () => void };
    sentTypes: () => Array<{ type?: string; channelId?: string }>;
  };
};

const GROUP = "11111111-2222-4333-8444-555555555555";
const DIRECT = `direct:${GROUP}`;
const ROSTER = [
  { id: "tech-a", name: "Alex Tech", email: null, role: "field_technician", avatarUrl: null, online: true, pttChannelId: null, onPtt: false },
  { id: "desk-b", name: "Blair Desk", email: null, role: "secretary", avatarUrl: null, online: false, pttChannelId: null, onPtt: false },
];

/** Ring endpoints: records POST bodies; the group answers after `answerAfterPolls` status polls. */
async function routeRings(page: Page, answerAfterPolls = 1) {
  const posts: Array<Record<string, unknown>> = [];
  let polls = 0;
  let targets: string[] = [];
  let channelId = DIRECT;
  const group = (status: (id: string) => string) => ({
    groupId: GROUP,
    channelId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
    pages: targets.map((id, index) => ({
      id: index + 1, targetUserId: id, name: ROSTER.find((r) => r.id === id)!.name, status: status(id), respondedAt: null,
    })),
  });
  await page.route("**/api/ptt/pages**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/ptt/pages") {
      const body = request.postDataJSON() as { targetUserIds?: string[]; everyone?: boolean; channelId?: string };
      posts.push(body);
      targets = body.everyone ? ROSTER.map((r) => r.id) : body.targetUserIds ?? [];
      channelId = body.everyone ? body.channelId! : DIRECT;
      polls = 0;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(group(() => "ringing")) });
      return;
    }
    if (request.method() === "GET" && path === `/api/ptt/pages/groups/${GROUP}`) {
      polls += 1;
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify(group((id) => (polls >= answerAfterPolls && id === targets[0] ? "answered" : "ringing"))),
      });
      return;
    }
    if (request.method() === "POST" && path === `/api/ptt/pages/groups/${GROUP}/cancel`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(group(() => "cancelled")) });
      return;
    }
    await route.abort();
  });
  return posts;
}

async function openConsole(page: Page, search = "") {
  await installPttFakes(page);
  await routePttApi(page, { roster: ROSTER });
  const posts = await routeRings(page);
  await page.goto(`/tests/ptt-dispatch.fixture.html${search}`);
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as TestWindow).__pttTest.pttSocket()))).toBe(true);
  await page.evaluate(() => (window as unknown as TestWindow).__pttTest.pttSocket().open());
  await page.evaluate(() => {
    (window as unknown as TestWindow).__pttTest.pttSocket().receive({ type: "hello", clientId: "me", operator: { name: "Fran Desk" } });
  });
  return posts;
}

function joins(page: Page) {
  return page.evaluate(() => (window as unknown as TestWindow).__pttTest.sentTypes()
    .filter((m) => m.type === "join").map((m) => m.channelId));
}

test("the Ring staff panel lists colleagues with role and presence", async ({ page }) => {
  await openConsole(page);
  const panel = page.getByTestId("ptt-ring-panel");
  await expect(panel).toContainText("1/2 online");
  await expect(page.getByTestId("ptt-ring-staff-tech-a")).toContainText("Alex Tech");
  await expect(page.getByTestId("ptt-ring-staff-tech-a")).toContainText("Technician · App open");
  await expect(page.getByTestId("ptt-ring-staff-desk-b")).toContainText("Front desk · Offline");
  await expect(page.getByTestId("ptt-ring-selected")).toBeDisabled();
});

test("Call rings one person and moves the console into a private call with them", async ({ page }) => {
  const posts = await openConsole(page);
  await expect.poll(() => joins(page)).toEqual(["dispatch"]);

  await page.getByTestId("ptt-ring-call-tech-a").click();
  expect(posts).toEqual([{ targetUserIds: ["tech-a"] }]);
  await expect.poll(() => joins(page)).toEqual(["dispatch", DIRECT]);
  await expect(page.getByTestId("ptt-private-call")).toContainText("With Alex Tech");
  await expect(page.getByTestId("ptt-ring-result-tech-a")).toContainText(/Ringing|Answered/);
  await expect(page.getByTestId("ptt-ring-result-tech-a")).toContainText("Answered");

  await page.getByTestId("ptt-leave-private-call").click();
  await expect.poll(() => joins(page)).toEqual(["dispatch", DIRECT, "dispatch"]);
  await expect(page.getByTestId("ptt-private-call")).toHaveCount(0);
});

test("Ring selected opens one private call for the chosen people; Ring everyone uses the talk group", async ({ page }) => {
  const posts = await openConsole(page);
  await page.getByLabel("Select Alex Tech").check();
  await page.getByLabel("Select Blair Desk").check();
  await expect(page.getByTestId("ptt-ring-selected")).toHaveText(/Ring selected \(2\)/);
  await page.getByTestId("ptt-ring-selected").click();
  expect(posts[0]).toEqual({ targetUserIds: ["tech-a", "desk-b"] });
  await expect(page.getByTestId("ptt-private-call")).toContainText("With Alex Tech & Blair Desk");

  await page.getByTestId("ptt-leave-private-call").click();
  await expect(page.getByTestId("ptt-ring-everyone")).toHaveText(/Ring everyone · Dispatch/);
  await page.getByTestId("ptt-ring-everyone").click();
  expect(posts[1]).toEqual({ everyone: true, channelId: "dispatch" });
  await expect(page.getByTestId("ptt-ring-status")).toContainText("All staff · Dispatch");
  await expect(page.getByTestId("ptt-private-call")).toHaveCount(0);
});

test("answering a ring opens the console directly in the private call", async ({ page }) => {
  await openConsole(page, `?channel=${encodeURIComponent(DIRECT)}&with=${encodeURIComponent("Owner Olivia")}`);
  await expect.poll(() => joins(page)).toEqual([DIRECT]);
  await expect(page.getByTestId("ptt-private-call")).toContainText("With Owner Olivia");
});

test("an invalid channel in the link falls back to Dispatch", async ({ page }) => {
  await openConsole(page, "?channel=direct:not-a-call");
  await expect.poll(() => joins(page)).toEqual(["dispatch"]);
  await expect(page.getByTestId("ptt-private-call")).toHaveCount(0);
});
