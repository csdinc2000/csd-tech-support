import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = new Date("2026-10-30T15:00:00-04:00");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const ME = "user-ana";

type Conversation = {
  conversationId: number; threadKey: string; customerNumber: string; contactId: number | null; contactName: string | null;
  status: "open" | "done"; assignedUserId: string | null; assignedName: string | null; lastMessage: string;
  lastDirection: string; lastSentBy: string | null; lastAt: string; messageCount: number; unread: boolean;
};

function seed() {
  const conversations: Conversation[] = [
    { conversationId: 12, threadKey: "9545550101", customerNumber: "+19545550101", contactId: 1, contactName: "Maria Alvarez", status: "open", assignedUserId: null, assignedName: null, lastMessage: "Is my laptop ready?", lastDirection: "inbound", lastSentBy: null, lastAt: ago(5), messageCount: 3, unread: true },
    { conversationId: 13, threadKey: "9545550102", customerNumber: "+19545550102", contactId: null, contactName: null, status: "open", assignedUserId: "user-luis", assignedName: "Luis Reyes", lastMessage: "On my way", lastDirection: "outbound", lastSentBy: "Luis Reyes", lastAt: ago(30), messageCount: 2, unread: false },
    { conversationId: 14, threadKey: "9545550103", customerNumber: "+19545550103", contactId: null, contactName: "Tom Becker", status: "done", assignedUserId: ME, assignedName: "Ana Diaz", lastMessage: "Thanks!", lastDirection: "inbound", lastSentBy: null, lastAt: ago(600), messageCount: 4, unread: false },
  ];
  const items: Record<string, any[]> = {
    "9545550101": [
      { kind: "call", id: "call-1", at: ago(60), direction: "inbound", status: "no-answer", durationSeconds: 0, hadVoicemail: true },
      { kind: "voicemail", id: "voicemail-1", voicemailId: 1, at: ago(59), durationSeconds: 21, transcription: "Hi, calling about my laptop.", listened: false },
      { kind: "message", id: "message-1", at: ago(20), body: "Got your voicemail — checking now.", direction: "outbound", status: "delivered", errorCode: null, sentBy: "Luis Reyes" },
      { kind: "message", id: "message-2", at: ago(5), body: "Is my laptop ready?", direction: "inbound", status: "received", errorCode: null, sentBy: null },
    ],
  };
  return { conversations, items, sent: [] as any[], notes: [] as any[], patches: [] as any[], reads: [] as string[] };
}

async function mockApi(page: Page) {
  const state = seed();
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body = req.postData() ? JSON.parse(req.postData()!) : {};

    if (path === "/api/sms/inbox") {
      const filter = url.searchParams.get("filter") ?? "open";
      const all = state.conversations;
      const counts = {
        open: all.filter((c) => c.status === "open").length,
        mine: all.filter((c) => c.status === "open" && c.assignedUserId === ME).length,
        unassigned: all.filter((c) => c.status === "open" && !c.assignedUserId).length,
        done: all.filter((c) => c.status === "done").length,
        all: all.length,
        unread: all.filter((c) => c.unread).length,
      };
      const conversations = all.filter((c) =>
        filter === "all" ? true
          : filter === "done" ? c.status === "done"
          : c.status === "open" && (filter === "mine" ? c.assignedUserId === ME : filter === "unassigned" ? !c.assignedUserId : true));
      return json({ conversations, counts, currentUserId: ME });
    }
    if (path === "/api/sms/inbox/assignees") return json([{ id: ME, name: "Ana Diaz" }, { id: "user-luis", name: "Luis Reyes" }]);
    const match = /^\/api\/sms\/inbox\/(\d+)(\/read|\/notes)?$/.exec(path);
    if (match) {
      const conv = state.conversations.find((c) => c.threadKey === match[1])!;
      if (match[2] === "/read") { conv.unread = false; state.reads.push(conv.threadKey); return json({ success: true }); }
      if (match[2] === "/notes") {
        state.notes.push(body);
        (state.items[conv.threadKey] ??= []).push({ kind: "note", id: `note-${state.notes.length}`, at: NOW.toISOString(), body: body.body, author: "Ana Diaz" });
        return json({ id: state.notes.length }, 201);
      }
      if (req.method() === "PATCH") {
        state.patches.push(body);
        if (body.status) conv.status = body.status;
        if ("assignedUserId" in body) {
          conv.assignedUserId = body.assignedUserId;
          conv.assignedName = body.assignedUserId === ME ? "Ana Diaz" : body.assignedUserId ? "Luis Reyes" : null;
        }
        return json({ conversationId: conv.conversationId, status: conv.status, assignedUserId: conv.assignedUserId });
      }
      const { lastMessage, lastDirection, lastSentBy, lastAt, messageCount, unread, ...conversation } = conv;
      return json({ conversation, items: state.items[conv.threadKey] ?? [] });
    }
    if (path === "/api/sms/send") {
      state.sent.push(body);
      const conv = state.conversations.find((c) => c.customerNumber === body.to)!;
      if (!conv.assignedUserId) { conv.assignedUserId = ME; conv.assignedName = "Ana Diaz"; }
      state.items[conv.threadKey].push({ kind: "message", id: `message-${Date.now()}`, at: NOW.toISOString(), body: body.body, direction: "outbound", status: "queued", errorCode: null, sentBy: "Ana Diaz" });
      return json({ success: true, sid: "SM1", from: "+19546377300" });
    }
    if (path === "/api/auth/access") return json(null, 401);
    return json({}, 404);
  });
  return state;
}

test("works the shared inbox: filters, unread, timeline, reply as main line, notes, assign and done", async ({ page }) => {
  const state = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/shared-inbox.fixture.html");

  const inbox = page.getByTestId("shared-inbox");
  await expect(inbox.getByTestId("inbox-unread-count")).toHaveText("1 unread");
  await expect(inbox.getByTestId("inbox-filter-open")).toContainText("2");
  await expect(inbox.getByTestId("thread-9545550102")).toContainText("Luis Reyes: On my way");
  await expect(inbox.getByTestId("thread-9545550102")).toContainText("Luis Reyes");
  await expect(inbox.getByTestId("thread-9545550103")).toHaveCount(0);

  await inbox.getByTestId("inbox-filter-unassigned").click();
  await expect(inbox.getByTestId("thread-9545550102")).toHaveCount(0);
  await inbox.getByTestId("thread-9545550101").click();

  // Opening marks it read; the timeline merges calls, voicemail and texts with who sent them.
  await expect.poll(() => state.reads).toContain("9545550101");
  const timeline = page.getByTestId("conversation-timeline");
  await expect(timeline.getByTestId("call-call-1")).toContainText("Missed call");
  await expect(timeline.getByTestId("voicemail-voicemail-1")).toContainText("Hi, calling about my laptop.");
  await expect(timeline.getByTestId("msg-message-1")).toContainText("Luis Reyes");
  await expect(page.getByText("Customer sees (954) 637-7300")).toBeVisible();

  // Reply goes to the customer's number with no sender override.
  await page.getByTestId("input-reply-body").fill("Yes, ready for pickup!");
  await page.getByTestId("button-send-reply").click();
  await expect.poll(() => state.sent).toEqual([{ to: "+19545550101", body: "Yes, ready for pickup!" }]);
  await expect(timeline.getByText("Yes, ready for pickup!")).toBeVisible();

  // Team note never hits the SMS endpoint.
  await page.getByTestId("composer-mode-note").click();
  await page.getByTestId("input-reply-body").fill("Customer prefers pickup after 6pm.");
  await page.getByTestId("button-send-reply").click();
  await expect(timeline.getByText("Customer prefers pickup after 6pm.")).toBeVisible();
  expect(state.sent).toHaveLength(1);
  expect(state.notes).toEqual([{ body: "Customer prefers pickup after 6pm." }]);
  await page.screenshot({ path: "test-results/shared-inbox.png" });

  // Mark done → it leaves the open queue.
  await page.getByTestId("button-mark-done").click();
  await expect.poll(() => state.patches).toContainEqual({ status: "done" });
  await expect(page.getByTestId("button-reopen")).toBeVisible();
});

test("assigns a conversation to me and shows it under Mine", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/tests/shared-inbox.fixture.html");
  await page.getByTestId("thread-9545550102").click();
  await page.getByTestId("button-assign-me").click();
  await expect.poll(() => state.patches).toContainEqual({ assignedUserId: ME });
  await page.getByTestId("inbox-filter-mine").click();
  await expect(page.getByTestId("thread-9545550102")).toContainText("You");
});

test("is usable on a phone: list first, then conversation with a back button", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/shared-inbox.fixture.html");
  await page.getByTestId("thread-9545550101").click();
  await expect(page.getByTestId("conversation-title")).toHaveText("Maria Alvarez");
  await expect(page.getByTestId("thread-9545550101")).toBeHidden();
  await page.screenshot({ path: "test-results/shared-inbox-mobile.png" });
  await page.getByRole("button", { name: "Back to conversations" }).click();
  await expect(page.getByTestId("thread-9545550101")).toBeVisible();
});
