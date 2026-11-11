import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = new Date("2026-11-10T09:00:00-05:00");

type Task = {
  id: number; title: string; notes: string | null; dueAt: string | null; priority: string; status: "open" | "done";
  leadId: number | null; contactId: number | null; createdVia: string; completedAt: string | null; createdAt: string; bucket: string;
};
const task = (over: Partial<Task>): Task => ({
  id: 1, title: "Task", notes: null, dueAt: null, priority: "normal", status: "open", leadId: null, contactId: null,
  createdVia: "app", completedAt: null, createdAt: NOW.toISOString(), bucket: "someday", ...over,
});

function briefingFor(tasks: Task[]) {
  return {
    aiConfigured: true,
    briefing: {
      date: "2026-11-10",
      generatedAt: NOW.toISOString(),
      timezone: "America/New_York",
      tasks: {
        overdue: tasks.filter((t) => t.bucket === "overdue"),
        today: tasks.filter((t) => t.bucket === "today"),
        upcoming: tasks.filter((t) => t.bucket === "upcoming"),
        someday: tasks.filter((t) => t.bucket === "someday").length,
      },
      speedToLead: {
        enabled: true,
        targetMinutes: 5,
        waiting: [
          { leadId: 42, name: "Maria Alvarez", serviceType: "Data Recovery", waitingMinutes: 18, overdue: true },
          { leadId: 43, name: "Devon Price", serviceType: "Tune-up", waitingMinutes: 2, overdue: false },
        ],
        metrics: { medianMinutes: 4.5, withinTargetPct: 80, waiting: 2, contacted: 10 },
      },
      leads: {
        newLast24h: [{ leadId: 42, name: "Maria Alvarez", company: null, serviceType: "Data Recovery", source: "website_intake", status: "new", createdAt: NOW.toISOString() }],
        openPipeline: 7,
        prospectsToReview: 3,
        recentBriefs: [{ leadId: 40, name: "Sunrise Dental", headline: "Two-office dental practice" }],
      },
      appointments: [{ reference: "BK-1", customerName: "Jamie Fox", service: "Diagnostics", startsAt: "2026-11-10T15:30:00Z", endsAt: null, status: "confirmed" }],
      tickets: { open: 4, urgent: 1 },
    },
  };
}

async function mockApi(page: Page) {
  const tasks: Task[] = [
    task({ id: 1, title: "Send quote to Sunrise Dental", dueAt: "2026-11-09T15:00:00Z", bucket: "overdue", priority: "high" }),
    task({ id: 2, title: "Call back Jamie", dueAt: "2026-11-10T19:00:00Z", bucket: "today", createdVia: "aria" }),
  ];
  const calls = { posts: [] as unknown[], patches: [] as Array<{ id: string; body: unknown }>, narrative: 0 };
  let nextId = 10;
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/assistant/briefing") return json(briefingFor(tasks.filter((t) => t.status === "open")));
    if (url.pathname === "/api/assistant/briefing/narrative") {
      calls.narrative++;
      return json({ narrative: {
        greeting: "Good morning!",
        narrative: "You have one overdue quote and Maria has been waiting 18 minutes.",
        topPriorities: [{ title: "Call Maria Alvarez", why: "Waiting past the 5 minute target" }, { title: "Send the Sunrise Dental quote", why: "Overdue since yesterday" }],
      } });
    }
    if (url.pathname === "/api/assistant/tasks" && request.method() === "GET") {
      const status = url.searchParams.get("status") ?? "open";
      return json({ tasks: tasks.filter((t) => t.status === status) });
    }
    if (url.pathname === "/api/assistant/tasks" && request.method() === "POST") {
      const body = request.postDataJSON();
      calls.posts.push(body);
      const created = task({ id: nextId++, title: body.title, priority: body.priority, dueAt: body.dueAt, bucket: body.dueAt ? "upcoming" : "someday" });
      tasks.push(created);
      return json({ task: created }, 201);
    }
    const match = url.pathname.match(/^\/api\/assistant\/tasks\/(\d+)$/);
    if (match && request.method() === "PATCH") {
      const body = request.postDataJSON();
      calls.patches.push({ id: match[1], body });
      const t = tasks.find((x) => x.id === Number(match[1]))!;
      Object.assign(t, body);
      if (body.status === "done") t.bucket = "done";
      return json({ task: t });
    }
    return json({ message: "not mocked" }, 404);
  });
  return calls;
}

test("briefing shows overdue tasks, waiting leads and every section", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockApi(page);
  await page.goto("/tests/executive-assistant.fixture.html");

  const briefing = page.getByTestId("assistant-briefing");
  await expect(page.getByTestId("briefing-date")).toHaveText("Tuesday, November 10, 2026");
  await expect(page.getByTestId("briefing-tasks-overdue")).toContainText("Send quote to Sunrise Dental");
  await expect(page.getByTestId("briefing-tasks-today")).toContainText("Call back Jamie");

  const waiting = page.getByTestId("waiting-lead-42");
  await expect(waiting).toContainText("Maria Alvarez");
  await expect(waiting).toContainText("18 min");
  await expect(waiting).toHaveClass(/bg-red-50/);
  await expect(waiting.getByRole("link", { name: "Research" })).toHaveAttribute("href", "/sales/copilot?leadId=42");
  await expect(page.getByTestId("waiting-lead-43")).not.toHaveClass(/bg-red-50/);
  await expect(briefing.getByRole("link", { name: "Speed to Lead" })).toHaveAttribute("href", "/sales/speed-to-lead");

  await expect(page.getByTestId("briefing-prospects")).toContainText("3 prospects");
  await expect(page.getByTestId("briefing-briefs")).toContainText("Sunrise Dental");
  await expect(page.getByTestId("briefing-appointments")).toContainText("10:30 AM");
  await expect(page.getByTestId("briefing-tickets")).toContainText("1 urgent");
  await expect(page.getByTestId("task-2-aria")).toBeVisible();
  await expect(page.getByTestId("assistant-ask-aria").getByRole("link").first())
    .toHaveAttribute("href", "/aria?prompt=Brief%20me%20on%20today");
});

test("quick-add posts a task and completing a task patches it", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/tests/executive-assistant.fixture.html");

  const tasksPanel = page.getByTestId("assistant-tasks");
  await tasksPanel.getByLabel("New task", { exact: true }).fill("Order SSD for Maria");
  await tasksPanel.getByLabel("New task priority").selectOption("high");
  await tasksPanel.getByRole("button", { name: "Add" }).click();
  await expect(tasksPanel).toContainText("Order SSD for Maria");
  expect(calls.posts).toEqual([{ title: "Order SSD for Maria", priority: "high", dueAt: null }]);

  await tasksPanel.getByRole("checkbox", { name: "Complete Send quote to Sunrise Dental" }).click();
  await expect.poll(() => calls.patches).toEqual([{ id: "1", body: { status: "done" } }]);
  await expect(tasksPanel.getByTestId("task-group-overdue")).toHaveCount(0);
  await expect(page.getByTestId("briefing-tasks-overdue")).toHaveCount(0);

  await tasksPanel.getByLabel("Show completed").click();
  await expect(tasksPanel.getByTestId("task-group-done")).toContainText("Send quote to Sunrise Dental");
});

test("Have Aria brief me shows the narrative and numbered priorities", async ({ page }) => {
  const calls = await mockApi(page);
  await page.addInitScript(() => {
    // Headless Chromium has no voices; keep speech calls inert.
    Object.defineProperty(window, "speechSynthesis", { value: { speak() {}, cancel() {} }, configurable: true });
  });
  await page.goto("/tests/executive-assistant.fixture.html");
  await page.getByTestId("briefing-narrative-button").click();
  await expect(page.getByTestId("briefing-narrative")).toContainText("Good morning!");
  const priorities = page.getByTestId("briefing-priorities").locator("li");
  await expect(priorities).toHaveCount(2);
  await expect(priorities.first()).toContainText("Call Maria Alvarez");
  await expect(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
  expect(calls.narrative).toBe(1);
});

test("the Aria Today strip summarizes tasks and waiting leads", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/executive-assistant.fixture.html?view=strip");
  const strip = page.getByTestId("aria-today-strip");
  await expect(strip).toContainText("2 tasks due (1 overdue)");
  await expect(strip).toContainText("2 leads waiting (1 past target)");
  await expect(strip.getByRole("link", { name: "Open Executive Assistant" })).toHaveAttribute("href", "/assistant");
});
