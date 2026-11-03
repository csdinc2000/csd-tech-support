import { expect, test, type Page, type Route } from "@playwright/test";

// Fixed "now" so the schedule column's today/next-up logic is deterministic.
const NOW = new Date("2026-09-21T13:00:00-04:00");
const SCHEDULE_ROWS = "[data-testid^='board-appointment-'], [data-testid^='board-scheduled-job-']";
const at = (hour: number, minute = 0) => {
  const d = new Date(NOW);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const contacts = [
  { id: 1, fullName: "Maria Alvarez", mobilePhone: "+19545550101", email: "maria@example.com", company: "Alvarez Dental", address: "12 Palm Ave", city: "Plantation", state: "FL", zipCode: "33317", clientId: 7 },
  { id: 2, fullName: "Devon Price", mobilePhone: "+19545550102", email: "devon@example.com", company: null, clientId: null },
];

const jobs = [
  { id: 11, jobNumber: "CSD-2026-0011", contactId: 1, clientId: 7, serviceType: "data_recovery", jobType: "drop_off", priority: "urgent", status: "in_progress", description: "Laptop will not boot after power surge; customer needs tax documents recovered.", technicianNotes: "SSD detected in enclosure, imaging in progress.", notes: null, assignedTo: "Luis", scheduledDateTime: null, estimatedAmount: 350, finalAmount: null, createdAt: at(8), updatedAt: at(12) },
  { id: 12, jobNumber: "CSD-2026-0012", contactId: 2, clientId: null, serviceType: "network_setup", jobType: "on_site", priority: "normal", status: "open", description: "New office needs Wi-Fi mesh and printer sharing.", technicianNotes: null, notes: "Bring 3 mesh nodes.", assignedTo: null, scheduledDateTime: at(15, 30), estimatedAmount: 600, finalAmount: null, createdAt: at(9), updatedAt: at(9) },
  { id: 13, jobNumber: "CSD-2026-0013", contactId: 1, clientId: 7, serviceType: "virus_removal", jobType: "remote", priority: "normal", status: "waiting_parts", description: "Ransomware note on desktop.", technicianNotes: null, notes: null, assignedTo: "Ana", scheduledDateTime: null, estimatedAmount: 150, finalAmount: null, createdAt: at(7), updatedAt: at(7) },
  { id: 14, jobNumber: "CSD-2026-0014", contactId: 2, clientId: null, serviceType: "computer_repair", jobType: "drop_off", priority: "low", status: "completed", description: "Done already", technicianNotes: null, notes: null, assignedTo: "Ana", scheduledDateTime: null, estimatedAmount: 90, finalAmount: 90, createdAt: at(6), updatedAt: at(6) },
];

const appointments = [
  { id: 21, reference: "CSD-A-2026-000021", serviceId: 3, contactId: 1, customerName: "Maria Alvarez", customerEmail: "maria@example.com", customerPhone: "+19545550101", startsAt: at(10), endsAt: at(11), customerTimezone: "America/New_York", status: "completed", totalCents: 12900, depositRequiredCents: 0, amountPaidCents: 12900, customerNotes: "Front desk PC is slow.", internalNotes: null, source: "web", serviceName: "PC Tune-Up", serviceDurationMinutes: 60 },
  { id: 22, reference: "CSD-A-2026-000022", serviceId: 4, contactId: null, customerName: "Walk-in: Sam Okafor", customerEmail: "sam@example.com", customerPhone: "+19545550103", startsAt: at(14), endsAt: at(14, 45), customerTimezone: "America/New_York", status: "confirmed", totalCents: 8900, depositRequiredCents: 2500, amountPaidCents: 2500, customerNotes: "Screen flickers when lid moves.", internalNotes: "Check hinge cable.", source: "phone", serviceName: "Laptop Diagnostic", serviceDurationMinutes: 45 },
];

const intakes = [
  { id: 31, customerName: "Priya Natarajan", phoneNumber: "+19545550104", emailAddress: "priya@example.com", contactPreference: "text", serviceType: "virus_removal", serviceTypeOther: null, deviceType: "laptop", deviceBrandModel: "Dell XPS 13", operatingSystem: "Windows 11", problemDescription: "Pop-ups every few minutes and browser homepage keeps changing.", howDidYouHear: "Google", isFromActiveCall: false, callNotes: null, source: "Website Intake Form", campaign: "fall-tuneup", status: "new", internalNotes: null, followUpDate: null, createdAt: at(12, 40) },
  { id: 32, customerName: "Tom Becker", phoneNumber: "+19545550105", emailAddress: "tom@example.com", contactPreference: "call", serviceType: "Other", serviceTypeOther: "Smart TV setup", deviceType: "other", deviceBrandModel: "Samsung QN90", operatingSystem: "Tizen", problemDescription: "Needs help mounting and connecting to Wi-Fi.", howDidYouHear: "Referral", isFromActiveCall: true, callNotes: "Prefers Saturday.", source: "Phone Link", campaign: null, status: "contacted", internalNotes: "Quote sent.", followUpDate: at(16), createdAt: at(11) },
];

const calls = [
  { id: 41, callSid: "CA123", fromNumber: "+19545550101", toNumber: "+19546377300", status: "completed", direction: "inbound", durationSeconds: 245, hadVoicemail: false, createdAt: at(12, 15), sourceChannel: "google_ads", campaignName: "Brand Search", trackingNumber: "+19546377300", contactId: 1, contactName: "Maria Alvarez", clientId: 7, clientName: "Alvarez Dental", supportTicketId: null, supportTicketNumber: null },
  { id: 42, callSid: "CA124", fromNumber: "+13055550199", toNumber: "+19546377300", status: "no-answer", direction: "inbound", durationSeconds: 0, hadVoicemail: true, createdAt: at(12, 50), sourceChannel: null, campaignName: null, trackingNumber: null, contactId: null, contactName: null, clientId: null, clientName: null, supportTicketId: null, supportTicketNumber: null },
];

async function mockApi(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/crm/jobs") return json(jobs);
    if (path === "/api/crm/contacts") return json(contacts);
    if (path === "/api/booking/appointments") return json(appointments);
    if (path === "/api/intake") return json({ intakes, total: intakes.length, page: 1, totalPages: 1 });
    if (path === "/api/call-tracking/calls") return json(calls);
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
}

test("renders three columns and opens a detail window for every item type", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/tech-board.fixture.html");

  // Left column: active jobs grouped by status, completed jobs excluded.
  const jobsColumn = page.getByTestId("board-active-jobs");
  await expect(jobsColumn.getByText("In Progress", { exact: true })).toBeVisible();
  await expect(jobsColumn.getByText("Open", { exact: true })).toBeVisible();
  await expect(jobsColumn.getByText("Waiting on Parts")).toBeVisible();
  await expect(jobsColumn.getByText("CSD-2026-0014")).toHaveCount(0);

  // Center column: today's appointments plus the job scheduled today, in time order.
  const schedule = page.getByTestId("board-schedule");
  await expect(schedule.getByText("Today")).toBeVisible();
  const rows = schedule.locator(SCHEDULE_ROWS);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Maria Alvarez");
  await expect(rows.nth(1)).toContainText("Sam Okafor");
  await expect(rows.nth(2)).toContainText("CSD-2026-0012");

  // Right column: service requests tab first, call log tab behind it.
  const activity = page.getByTestId("board-activity");
  await expect(activity.getByText("Priya Natarajan")).toBeVisible();
  await expect(activity.getByText("Pop-ups every few minutes", { exact: false })).toBeVisible();

  await page.screenshot({ path: "test-results/tech-board.png", fullPage: true });

  // Job → detail window with customer, service type and reported issue.
  await page.getByTestId("board-job-11").click();
  const detail = page.getByTestId("board-detail");
  await expect(detail.getByTestId("board-detail-title")).toHaveText("Maria Alvarez");
  await expect(detail).toContainText("CSD-2026-0011");
  await expect(detail).toContainText("Data Recovery");
  await expect(detail).toContainText("Drop Off");
  await expect(detail).toContainText("Laptop will not boot after power surge");
  await expect(detail).toContainText("SSD detected in enclosure");
  await expect(detail).toContainText("(954) 555-0101");
  await expect(detail).toContainText("12 Palm Ave, Plantation, FL, 33317");
  await expect(detail.getByRole("link", { name: "Customer record" })).toHaveAttribute("href", "/crm/customers/7");
  await page.screenshot({ path: "test-results/tech-board-job-detail.png" });
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // Appointment → detail window.
  await page.getByTestId("board-appointment-22").click();
  await expect(detail.getByTestId("board-detail-title")).toHaveText("Walk-in: Sam Okafor");
  await expect(detail).toContainText("Laptop Diagnostic");
  await expect(detail).toContainText("Screen flickers when lid moves.");
  await expect(detail).toContainText("Guest booking");
  await expect(detail).toContainText("$64.00"); // balance due
  await page.keyboard.press("Escape");

  // Service request → detail window.
  await page.getByTestId("board-intake-32").click();
  await expect(detail.getByTestId("board-detail-title")).toHaveText("Tom Becker");
  await expect(detail).toContainText("Smart TV setup");
  await expect(detail).toContainText("Needs help mounting");
  await expect(detail).toContainText("Prefers Saturday.");
  await page.keyboard.press("Escape");

  // Call → detail window (missed call shows follow-up guidance).
  await activity.getByTestId("board-tab-calls").click();
  await expect(activity.getByText("Maria Alvarez")).toBeVisible();
  await page.getByTestId("board-call-42").click();
  await expect(detail.getByTestId("board-detail-title")).toHaveText("(305) 555-0199");
  await expect(detail).toContainText("No Answer");
  await expect(detail).toContainText("Left a voicemail");
  await expect(detail).toContainText("was not connected");
  await page.screenshot({ path: "test-results/tech-board-call-detail.png" });
});

test("filters active jobs and pages the schedule by day", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/tech-board.fixture.html");

  const jobsColumn = page.getByTestId("board-active-jobs");
  await jobsColumn.getByLabel("Filter active jobs").fill("devon");
  await expect(jobsColumn.getByTestId("board-job-12")).toBeVisible();
  await expect(jobsColumn.getByTestId("board-job-11")).toHaveCount(0);

  const schedule = page.getByTestId("board-schedule");
  await schedule.getByLabel("Next day").click();
  await expect(schedule.getByText("Nothing scheduled for Sep 22.")).toBeVisible();
  await schedule.getByRole("button", { name: "Today" }).click();
  await expect(schedule.locator(SCHEDULE_ROWS)).toHaveCount(3);

  // Phones and tablets show one column at a time behind a segmented switcher.
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(page.getByTestId("board-active-jobs")).toBeVisible();
  await expect(page.getByTestId("board-schedule")).toBeHidden();
  await expect(page.getByTestId("board-pane-jobs")).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "test-results/tech-board-mobile.png", fullPage: true });
  await page.getByTestId("board-pane-activity").click();
  await expect(page.getByTestId("board-activity")).toBeVisible();
  await expect(page.getByTestId("board-active-jobs")).toBeHidden();
  await expect(page.getByTestId("board-activity").getByText("Priya Natarajan")).toBeVisible();

  // Tablet: still one pane; desktop: all three columns and no switcher.
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(page.getByTestId("board-pane-switcher")).toBeVisible();
  await page.screenshot({ path: "test-results/tech-board-tablet.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("board-pane-switcher")).toBeHidden();
  await expect(page.getByTestId("board-active-jobs")).toBeVisible();
  await expect(page.getByTestId("board-schedule")).toBeVisible();
});

test("hides the call log for staff without communications access", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/tech-board.fixture.html?calls=0");
  const activity = page.getByTestId("board-activity");
  await activity.getByTestId("board-tab-calls").click();
  await expect(activity.getByText("Call logs require approved Communications access.")).toBeVisible();
});

test("shows at-a-glance counts and quick links to related support pages", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/tech-board.fixture.html");

  const stats = page.getByTestId("board-stats");
  await expect(stats.getByTestId("board-stat-active")).toContainText("3");
  await expect(stats.getByTestId("board-stat-urgent")).toContainText("1");
  await expect(stats.getByTestId("board-stat-unassigned")).toContainText("1");
  await expect(stats.getByTestId("board-stat-ready")).toContainText("0");
  await expect(stats.getByTestId("board-stat-today")).toContainText("3");
  await expect(stats.getByTestId("board-stat-requests")).toContainText("1");
  await expect(stats.getByTestId("board-stat-missed")).toContainText("1");
  await expect(stats.getByTestId("board-stat-active")).toHaveAttribute("href", "/crm/jobs");

  const links = page.getByTestId("board-quick-links");
  await expect(links.getByTestId("board-link-helpdesk")).toHaveAttribute("href", "/tickets");
  await expect(links.getByTestId("board-link-remote-access")).toHaveAttribute("href", "/remote-access");
  await expect(links.getByTestId("board-link-training")).toHaveAttribute("href", "/training");

  await links.getByTestId("board-all-links").click();
  const sheet = page.getByTestId("board-links-sheet");
  await expect(sheet.getByText("Remote & devices")).toBeVisible();
  await expect(sheet.getByRole("link", { name: /Cheat Sheets/ })).toHaveAttribute("href", "/tech-tools?tab=cheatsheets");
  await page.screenshot({ path: "test-results/tech-board-links.png" });
});

test("hides quick links and the missed-call tile the role can't open", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/tech-board.fixture.html?calls=0&features=crm");

  const links = page.getByTestId("board-quick-links");
  await expect(links.getByTestId("board-link-jobs")).toBeVisible();
  await expect(links.getByTestId("board-link-training")).toBeVisible();
  await expect(links.getByTestId("board-link-remote-access")).toHaveCount(0);
  await expect(links.getByTestId("board-link-helpdesk")).toHaveCount(0);
  await expect(page.getByTestId("board-stat-missed")).toHaveCount(0);
  // Schedule tile needs Operations, so it renders as plain text rather than a link.
  await expect(page.getByTestId("board-stat-today")).not.toHaveAttribute("href", /.*/);
});
