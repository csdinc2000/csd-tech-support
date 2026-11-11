import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = new Date("2026-11-10T14:00:00-05:00");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const prospect = (overrides: Record<string, unknown> = {}) => ({
  id: 41, runId: 9, businessName: "Marino Family Dental", website: "https://family.marinofamilydental.com", phone: "+19546519312",
  email: null, address: null, city: "Lauderhill", industry: "Dental office", employeeEstimate: "10-20", fitScore: 82,
  fitReasons: "Four-operatory office handling patient records, so HIPAA backups matter.",
  suggestedServices: "Managed IT services, Data backup and recovery", openingLine: "Saw your new Lauderhill office opened last spring.",
  sources: ["https://family.marinofamilydental.com/our-office/"], status: "new", contactId: null, leadId: null, createdAt: minutesAgo(1),
  ...overrides,
});

const settings = {
  enabled: true, enabledAt: minutesAgo(60 * 24), autoTextEnabled: true,
  autoTextTemplate: "Hi {firstName}, thanks for contacting Computer Systems Depot! Reply STOP to opt out.",
  targetMinutes: 5, escalateSlack: true, escalationPhones: [], businessHoursOnly: false, businessStartHour: 9, businessEndHour: 18,
  businessDays: [1, 2, 3, 4, 5, 6], timezone: "America/New_York", excludedSources: ["lead_gen_agent"], updatedAt: minutesAgo(60),
};

const stlLead = (overrides: Record<string, unknown>) => ({
  leadId: 1, contactId: 1, name: "Devon Price", company: null, phone: "+19545550102", email: null, serviceType: "Data Recovery",
  source: "website_intake", leadStatus: "new", leadCreatedAt: minutesAgo(12), waitingMinutes: 12, responseMinutes: null, overdue: true,
  autoTextStatus: "sent", autoTextDetail: "Submitted to Twilio (queued)", firstContactAt: null, firstContactBy: null,
  firstContactKind: null, escalatedAt: minutesAgo(7), ...overrides,
});

const brief = {
  headline: "Two-location dental practice asking about backups",
  summary: "Marino Family Dental runs two offices and wants reliable patient-record backups.",
  customerType: "small_business",
  companyProfile: { name: "Marino Family Dental", industry: "Dentistry", website: "https://family.marinofamilydental.com" },
  needs: ["HIPAA-compliant backups"],
  recommendedServices: [{ service: "Managed IT services", why: "Covers both offices under one contract." }],
  talkingPoints: ["Mention our 90-day labor guarantee."],
  discoveryQuestions: ["How are X-rays backed up today?"],
  objections: [{ objection: "We already have an IT guy", response: "We can back him up after hours." }],
  risks: [],
  nextBestAction: { action: "Call the office manager", timing: "Today before 4pm", channel: "call" },
  leadScore: 78,
  draftEmail: { subject: "Backups for both Marino offices", body: "Hi Dr. Marino,\n\nThanks for reaching out." },
  draftText: "Hi, this is CSD following up on backups for your offices.",
};

type Calls = { started: unknown[]; imported: number[]; contacted: number[]; researched: number[] };

async function mockApi(page: Page): Promise<Calls> {
  const calls: Calls = { started: [], imported: [], contacted: [], researched: [] };
  let runPolls = 0;
  let imported = false;
  let contacted = false;
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/crm/lead-gen/status") return json({ configured: true, webSearch: true });
    if (path === "/api/crm/lead-gen/runs" && method === "POST") {
      calls.started.push(route.request().postDataJSON());
      return json({ runId: 9 }, 202);
    }
    if (path === "/api/crm/lead-gen/runs") return json({ runs: calls.started.length ? [{ id: 9, target: "dental offices", location: "Lauderhill, FL", maxResults: 10, status: "completed", error: null, summary: null, prospectCount: 1, createdAt: minutesAgo(1), finishedAt: minutesAgo(0) }] : [] });
    if (path === "/api/crm/lead-gen/runs/9") {
      runPolls++;
      const done = runPolls > 1;
      return json({
        run: { id: 9, target: "dental offices", location: "Lauderhill, FL", maxResults: 10, status: done ? "completed" : "running", error: null, summary: done ? "Busy dental market." : null, prospectCount: done ? 1 : 0, createdAt: minutesAgo(1), finishedAt: done ? minutesAgo(0) : null },
        prospects: done ? [prospect()] : [],
      });
    }
    if (path === "/api/crm/lead-gen/prospects") {
      const status = url.searchParams.get("status");
      const ready = runPolls > 1;
      if (status === "new") return json({ prospects: ready && !imported ? [prospect()] : [] });
      if (status === "imported") return json({ prospects: imported ? [prospect({ status: "imported", leadId: 77, contactId: 55 })] : [] });
      return json({ prospects: [] });
    }
    if (path === "/api/crm/lead-gen/prospects/41/import") {
      calls.imported.push(41);
      imported = true;
      return json({ prospect: prospect({ status: "imported", leadId: 77, contactId: 55 }) });
    }

    if (path === "/api/crm/speed-to-lead") {
      return json({
        settings,
        twilioConfigured: true,
        preview: "Hi Maria, thanks for contacting Computer Systems Depot! Reply STOP to opt out.",
        metrics: { total: 2, contacted: contacted ? 2 : 1, waiting: contacted ? 0 : 1, medianMinutes: 3.5, withinTargetPct: 100, autoTextsSent: 2, escalations: 1 },
        leads: [
          contacted
            ? stlLead({ overdue: false, waitingMinutes: null, responseMinutes: 12, firstContactAt: minutesAgo(0), firstContactBy: "Avery Admin", firstContactKind: "manual_contact" })
            : stlLead({}),
          stlLead({ leadId: 2, name: "Maria Alvarez", overdue: false, waitingMinutes: null, responseMinutes: 3.5, firstContactAt: minutesAgo(30), firstContactBy: "Alex Tech", firstContactKind: "call_out", escalatedAt: null, leadCreatedAt: minutesAgo(34) }),
        ],
      });
    }
    if (path === "/api/crm/speed-to-lead/1/contacted") {
      calls.contacted.push(1);
      contacted = true;
      return json({ ok: true });
    }

    if (path === "/api/crm/lead-research/leads") {
      return json({ configured: true, leads: [
        { id: 7, name: "Marino Family Dental", company: "Marino Family Dental", serviceType: "Managed IT", status: "new", source: "lead_gen_agent", createdAt: minutesAgo(90), briefStatus: "completed", briefAt: minutesAgo(10) },
        { id: 8, name: "Devon Price", company: null, serviceType: "Data Recovery", status: "new", source: "website_intake", createdAt: minutesAgo(12), briefStatus: null, briefAt: null },
      ] });
    }
    if (path === "/api/crm/lead-research/7") {
      if (method === "POST") { calls.researched.push(7); return json({ briefId: 3, alreadyRunning: false }, 202); }
      return json({
        lead: { id: 7, name: "Marino Family Dental", company: "Marino Family Dental", email: "office@marino.example", phone: "+19546519312", contactId: 55, serviceType: "Managed IT", status: "new", source: "lead_gen_agent", problem: "Outbound prospect", createdAt: minutesAgo(90) },
        brief: { id: 3, leadId: 7, status: "completed", brief, sources: ["https://family.marinofamilydental.com/"], grounded: true, error: null, createdAt: minutesAgo(11), finishedAt: minutesAgo(10) },
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  return calls;
}

test("lead generation: run a search, see prospects, import one", async ({ page }) => {
  const calls = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/sales-agents.fixture.html");

  await expect(page.getByText("Nothing is contacted automatically")).toBeVisible();
  await page.getByTestId("lead-gen-target").fill("dental offices");
  await page.getByTestId("lead-gen-start").click();
  await expect(page.getByTestId("lead-gen-running")).toBeVisible();
  expect(calls.started[0]).toEqual({ target: "dental offices", location: "Lauderhill, FL (Broward County)", maxResults: 10 });

  // The run completes on the next 4 s poll.
  await page.clock.runFor(4500);
  const card = page.getByTestId("prospect-41");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("82/100");
  await expect(card).toContainText("Saw your new Lauderhill office");
  await expect(page.getByTestId("lead-gen-summary")).toContainText("Found 1 new prospect");

  await page.getByTestId("prospect-import-41").click();
  await expect.poll(() => calls.imported).toEqual([41]);
  await expect(page.getByTestId("prospect-41")).toHaveCount(0);
  await page.getByTestId("prospect-filter-imported").click();
  await expect(page.getByTestId("prospect-lead-link-41")).toHaveAttribute("href", "/crm/leads");
});

test("speed to lead: overdue lead is highlighted and can be marked contacted", async ({ page }) => {
  const calls = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/sales-agents.fixture.html?path=/sales/speed-to-lead");

  const row = page.getByTestId("stl-lead-1");
  await expect(row).toHaveAttribute("data-overdue", "true");
  await expect(page.getByTestId("stl-waiting-1")).toContainText("Waiting 12 min");
  await expect(page.getByTestId("stl-metric-median")).toContainText("3.5 min");
  await expect(page.getByTestId("stl-metric-target")).toContainText("100%");
  await expect(page.getByTestId("stl-research-1")).toHaveAttribute("href", "/sales/copilot?leadId=1");
  await expect(page.getByTestId("stl-preview")).toContainText("Hi Maria, thanks");

  await page.getByTestId("stl-contacted-1").click();
  await expect.poll(() => calls.contacted).toEqual([1]);
  await expect(row).toHaveAttribute("data-overdue", "false");
  await expect(row).toContainText("Avery Admin");
});

test("speed to lead settings are read-only for non-owners", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/sales-agents.fixture.html?path=/sales/speed-to-lead&owner=0");
  await expect(page.getByTestId("stl-settings")).toContainText("Owner only");
  await expect(page.getByTestId("stl-enabled")).toBeDisabled();
  await expect(page.getByTestId("stl-template")).toBeDisabled();
  await expect(page.getByTestId("stl-save")).toHaveCount(0);
});

test("sales copilot renders a completed brief for the preselected lead", async ({ page }) => {
  const calls = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tests/sales-agents.fixture.html?path=${encodeURIComponent("/sales/copilot?leadId=7")}`);

  await expect(page.getByTestId("copilot-lead-name")).toHaveText("Marino Family Dental");
  await expect(page.getByTestId("copilot-headline")).toHaveText("Two-location dental practice asking about backups");
  await expect(page.getByTestId("copilot-grounded")).toBeVisible();
  await expect(page.getByTestId("copilot-next-action")).toContainText("Call the office manager");
  await expect(page.getByTestId("copilot-services")).toContainText("Managed IT services");
  await expect(page.getByTestId("copilot-email-subject")).toContainText("Backups for both Marino offices");
  await expect(page.getByTestId("copilot-draft-text")).toContainText("following up on backups");
  await expect(page.getByTestId("copilot-sources")).toContainText("marinofamilydental.com");
  await page.getByTestId("copilot-objection-0").locator("summary").click();
  await expect(page.getByTestId("copilot-objection-0")).toContainText("We can back him up after hours.");

  await page.getByTestId("copilot-research").click();
  await expect.poll(() => calls.researched).toEqual([7]);
});
