import { expect, test, type Page, type Route } from "@playwright/test";

// Replaces the browser's speech APIs with scripted stand-ins: each time the
// assistant starts listening it receives the next queued answer. Queue items
// of the form "__error:<code>" raise a recognition error instead.
async function installFakeSpeech(page: Page, opts: { recognition?: boolean } = {}) {
  await page.addInitScript(({ recognition }) => {
    const w = window as any;
    w.__answers = [] as string[];
    w.__spoken = [] as string[];
    w.__listens = 0;
    class FakeUtterance {
      text: string; onend: null | (() => void) = null; onerror: null | (() => void) = null;
      lang = ""; volume = 1; rate = 1; voice = null;
      constructor(text: string) { this.text = text; }
    }
    w.SpeechSynthesisUtterance = FakeUtterance;
    Object.defineProperty(w, "speechSynthesis", {
      configurable: true,
      value: {
        speak(u: FakeUtterance) { w.__spoken.push(u.text); setTimeout(() => u.onend?.(), 0); },
        cancel() {},
        getVoices() { return []; },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    if (!recognition) {
      delete w.SpeechRecognition;
      delete w.webkitSpeechRecognition;
      return;
    }
    class FakeRecognition {
      onresult: any = null; onerror: any = null; onend: any = null;
      lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
      private timer: any;
      start() {
        w.__listens++;
        const poll = () => {
          const next = w.__answers.shift();
          if (next === undefined) { this.timer = setTimeout(poll, 30); return; }
          if (next.startsWith("__error:")) { this.onerror?.({ error: next.slice(8) }); this.onend?.(); return; }
          const result = Object.assign([{ transcript: next }], { isFinal: true });
          this.onresult?.({ resultIndex: 0, results: [result] });
          this.onend?.();
        };
        this.timer = setTimeout(poll, 30);
      }
      abort() { clearTimeout(this.timer); }
      stop() { clearTimeout(this.timer); }
    }
    w.SpeechRecognition = FakeRecognition;
  }, { recognition: opts.recognition ?? true });
}

const answer = (page: Page, ...texts: string[]) =>
  page.evaluate((t) => { (window as any).__answers.push(...t); }, texts);

const spoken = (page: Page) => page.evaluate(() => ((window as any).__spoken as string[]).join(" | "));

interface Mocks {
  aiEnabled?: boolean;
  interpret?: (body: any) => any;
  intakeStatus?: number;
}

async function mockApi(page: Page, mocks: Mocks = {}) {
  const intakes: any[] = [];
  const interpretCalls: any[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/booking/services") {
      return route.fulfill({ json: [
        { id: 3, name: "Computer Repair", basePriceCents: 0, durationMinutes: 60 },
        { id: 7, name: "Virus Removal", basePriceCents: 0, durationMinutes: 60 },
      ] });
    }
    if (path === "/api/portal/voice-intake/status") {
      return route.fulfill({ json: { aiEnabled: !!mocks.aiEnabled, provider: mocks.aiEnabled ? "Anthropic Claude" : null } });
    }
    if (path === "/api/portal/voice-intake/interpret") {
      const body = request.postDataJSON();
      interpretCalls.push(body);
      return route.fulfill({ json: mocks.interpret!(body) });
    }
    if (path === "/api/intake" && request.method() === "POST") {
      intakes.push(request.postDataJSON());
      if (mocks.intakeStatus && mocks.intakeStatus >= 400) {
        return route.fulfill({ status: mocks.intakeStatus, json: { success: false, error: "Failed to create intake" } });
      }
      return route.fulfill({ status: 201, json: { success: true, contact: { id: 1 }, lead: { id: 2 }, ticket: { number: "CSD-1042" } } });
    }
    return route.abort();
  });
  return { intakes, interpretCalls };
}

async function openVoice(page: Page, mode: "basic" | "ai" = "basic") {
  await page.goto("/tests/voice-intake.fixture.html");
  await expect(page.getByTestId("button-start-voice-intake")).toBeEnabled();
  await page.getByTestId("button-start-voice-intake").click();
  await expect(page.getByTestId("voice-intake-consent")).toBeVisible();
  await page.getByTestId(mode === "ai" ? "button-voice-start-ai" : "button-voice-start-basic").click();
  await expect(page.getByTestId("voice-intake-panel")).toBeVisible();
}

const FULL_CONVERSATION = [
  "yes",                              // ready
  "My name is Dana Rivera",
  "skip",                             // company
  "nine five four five five five oh one two three",
  "yes",                              // confirm phone
  "dana at example dot com",
  "yes",                              // confirm email
  "email please",
  "a Dell laptop",                    // device type + brand
  "windows 11",
  "it will not turn on at all since yesterday",
  "computer repair",
  "skip",                             // address
  "google",
];

test("a customer completes the whole intake by voice and approves submission", async ({ page }) => {
  await installFakeSpeech(page);
  const { intakes } = await mockApi(page);
  await openVoice(page);
  await answer(page, ...FULL_CONVERSATION);

  await expect(page.getByTestId("voice-log")).toContainText("Would you like to make any changes before submitting?", { timeout: 15_000 });
  // Answers land in the existing form fields in real time.
  await expect(page.getByLabel("Full Name *")).toHaveValue("Dana Rivera");
  await expect(page.getByLabel("Mobile Phone Number *")).toHaveValue("9545550123");
  await expect(page.getByLabel("Email Address *")).toHaveValue("dana@example.com");
  await expect(page.getByLabel("Device Brand & Model *")).toHaveValue("Dell");
  await expect(page.getByRole("combobox", { name: /type of device/i })).toContainText("Laptop");
  await expect(page.getByRole("combobox", { name: /Operating System/i })).toContainText("Windows 11");
  await expect(page.getByRole("combobox", { name: /service/i })).toContainText("Computer Repair");
  await expect(page.getByRole("combobox", { name: /How did you hear/i })).toContainText("Google Search");
  await expect(page.getByRole("radio", { name: "Email" })).toBeChecked();
  await expect(page.getByTestId("voice-progress")).toHaveText("10 of 10");
  // Contact details were read back for confirmation, SMS consent explained but never ticked.
  expect(await spoken(page)).toContain("Let me confirm your email address");
  expect(await spoken(page)).toContain("text message consent box");
  await expect(page.getByTestId("checkbox-sms-consent")).not.toBeChecked();
  expect(intakes).toHaveLength(0);

  // "No changes" is not approval; the assistant asks explicitly.
  await answer(page, "no changes");
  await expect(page.getByTestId("voice-log")).toContainText("Shall I submit your service request now?");
  expect(intakes).toHaveLength(0);
  await answer(page, "yes");

  await expect(page.getByTestId("text-ticket-number")).toContainText("CSD-1042");
  expect(intakes).toHaveLength(1);
  expect(intakes[0]).toMatchObject({
    full_name: "Dana Rivera", mobile_phone: "9545550123", email: "dana@example.com",
    preferred_contact_method: "email", service_id: 3, device_type: "Laptop", operating_system: "Windows 11",
    how_did_you_hear_about_us: "Google Search", intake_channel: "voice", sms_consent: false, sms_consent_text: null,
  });
  expect(intakes[0].problem_description).toContain("will not turn on");
  await expect.poll(() => spoken(page)).toContain("Your ticket number is C S D - 1 0 4 2");
});

test("AI mode maps one natural sentence to several fields and skips answered questions", async ({ page }) => {
  await installFakeSpeech(page);
  const { interpretCalls } = await mockApi(page, {
    aiEnabled: true,
    interpret: (body) => {
      const none = { intent: "answer", updates: {}, changeField: null, acknowledgement: "", followUpQuestion: null };
      if (body.step === "ready") return { ...none, intent: "yes" };
      if (body.step === "customerName") return { ...none, updates: { customerName: "Sam Lee" } };
      if (body.step === "companyName") return { ...none, intent: "skip" };
      if (body.step === "phoneNumber") return { ...none, updates: { phoneNumber: "9545550188" } };
      if (body.step === "emailAddress") return { ...none, updates: { emailAddress: "sam@example.com" } };
      if (body.step.startsWith("confirm:")) return { ...none, intent: "yes" };
      if (body.step === "contactPreference") return { ...none, updates: { contactPreference: "call" } };
      if (body.step === "deviceType") {
        return {
          ...none,
          updates: { deviceType: "Laptop", deviceBrandModel: "Dell", problemDetail: "It won't turn on." },
          acknowledgement: "I understand. Your Dell laptop isn't powering on.",
        };
      }
      return none;
    },
  });
  await openVoice(page, "ai");
  await answer(page, "yes", "Sam Lee", "no", "954 555 0188", "yes", "sam at example dot com", "yes", "call me",
    "It's a Dell laptop, and it won't turn on.");

  await expect(page.getByTestId("voice-log")).toContainText("Your Dell laptop isn't powering on.", { timeout: 15_000 });
  // Brand/model and problem were captured, so the next question is the operating system.
  await expect(page.getByTestId("voice-log")).toContainText("which operating system");
  await expect(page.getByLabel("Device Brand & Model *")).toHaveValue("Dell");
  await expect(page.getByLabel(/Describe the problem/)).toHaveValue("It won't turn on.");
  expect(interpretCalls.map((c) => c.step)).not.toContain("deviceBrandModel");
  // The assistant only ever gets the form's real options to choose from.
  expect(interpretCalls[0].options.deviceType).toEqual(["Laptop", "Desktop", "All-in-One", "Other"]);
  expect(interpretCalls[0].options.services).toEqual([{ id: 3, name: "Computer Repair" }, { id: 7, name: "Virus Removal" }]);
});

test("microphone refusal falls back to typing, and typed form edits are kept", async ({ page }) => {
  await installFakeSpeech(page);
  const { intakes } = await mockApi(page);
  await page.goto("/tests/voice-intake.fixture.html");
  // The customer typed their name by hand before trying voice.
  await page.getByLabel("Full Name *").fill("Pat Morgan");
  await page.getByTestId("button-start-voice-intake").click();
  await answer(page, "__error:not-allowed");
  await page.getByTestId("button-voice-start-basic").click();

  await expect(page.getByTestId("voice-notice")).toContainText("Microphone access was blocked");
  await expect(page.getByTestId("button-voice-use-mic")).toBeVisible();
  // Typing works as the fallback.
  await page.getByTestId("input-voice-typed").fill("yes");
  await page.getByTestId("button-voice-send").click();
  // The typed name is preserved and not asked again: next is the company.
  await expect(page.getByTestId("voice-log")).toContainText("Is this request for a business?");
  await expect(page.getByLabel("Full Name *")).toHaveValue("Pat Morgan");
  expect(intakes).toHaveLength(0);
});

test("a customer corrects an earlier answer at review", async ({ page }) => {
  await installFakeSpeech(page);
  await mockApi(page);
  await openVoice(page);
  await answer(page, ...FULL_CONVERSATION);
  await expect(page.getByTestId("voice-log")).toContainText("Would you like to make any changes", { timeout: 15_000 });

  await answer(page, "I need to change my email", "dana dot r at example dot org", "yes");
  await expect(page.getByLabel("Email Address *")).toHaveValue("dana.r@example.org");
  // Back to review once the correction is confirmed.
  await expect.poll(async () => (await page.getByTestId("voice-log").textContent())!.split("Would you like to make any changes").length - 1).toBe(2);
});

test("pause and resume keep the place in the conversation", async ({ page }) => {
  await installFakeSpeech(page);
  await mockApi(page);
  await openVoice(page);
  await answer(page, "yes", "Dana Rivera");
  await expect(page.getByTestId("voice-log")).toContainText("Is this request for a business?");

  await page.getByTestId("button-voice-pause").click();
  await expect(page.getByTestId("voice-status")).toHaveText(/Paused/);
  const listensWhilePaused = await page.evaluate(() => (window as any).__listens);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__listens)).toBe(listensWhilePaused);

  await page.getByTestId("button-voice-resume").click();
  await expect(page.getByTestId("voice-log")).toContainText("Welcome back. Thanks, Dana. Is this request for a business?");
  await answer(page, "Acme Corp");
  await expect(page.getByLabel("Company")).toHaveValue("Acme Corp");
});

test("browsers without speech recognition get the typing fallback", async ({ page }) => {
  await installFakeSpeech(page, { recognition: false });
  await mockApi(page);
  await openVoice(page);
  await expect(page.getByTestId("voice-notice")).toContainText("doesn't support speech recognition");
  await expect(page.getByTestId("button-voice-speak")).toHaveCount(0);
  await page.getByTestId("input-voice-typed").fill("yes");
  await page.getByTestId("button-voice-send").click();
  await expect(page.getByTestId("voice-log")).toContainText("full name");
});

test("required information is enforced and nothing is submitted while missing", async ({ page }) => {
  await installFakeSpeech(page);
  const { intakes } = await mockApi(page);
  await openVoice(page);
  await answer(page, "yes", "Dana Rivera", "skip", "skip");
  // The phone number is required: skipping is refused and the question repeats.
  await expect(page.getByTestId("voice-log")).toContainText("This one is needed to complete your request.");
  await expect(page.getByTestId("voice-progress")).toHaveText("1 of 10");
  await expect(page.getByTestId("button-voice-submit")).toHaveCount(0);
  expect(intakes).toHaveLength(0);
});

test("a failed submission is never announced as success", async ({ page }) => {
  await installFakeSpeech(page);
  const { intakes } = await mockApi(page, { intakeStatus: 500 });
  await openVoice(page);
  await answer(page, ...FULL_CONVERSATION, "submit it");
  await expect(page.getByTestId("voice-log")).toContainText("couldn't be submitted", { timeout: 15_000 });
  expect(intakes).toHaveLength(1);
  await expect(page.getByTestId("text-ticket-number")).toHaveCount(0);
  expect(await spoken(page)).not.toContain("submitted successfully");
  // Answers survive for a retry.
  await expect(page.getByLabel("Full Name *")).toHaveValue("Dana Rivera");
});

test("manual form still works without voice and is not tagged as voice", async ({ page }) => {
  await installFakeSpeech(page);
  const { intakes } = await mockApi(page);
  await page.goto("/tests/voice-intake.fixture.html");
  const choose = async (label: RegExp, option: string) => {
    await page.getByRole("combobox", { name: label }).click();
    await page.getByRole("option", { name: option }).click();
  };
  await page.getByLabel("Full Name *").fill("Lee Park");
  await page.getByLabel("Mobile Phone Number *").fill("9545550111");
  await page.getByLabel("Email Address *").fill("lee@example.com");
  await choose(/service/i, "Virus Removal");
  await choose(/type of device/i, "Desktop");
  await page.getByLabel("Device Brand & Model *").fill("HP Pavilion");
  await choose(/Operating System/i, "Windows 10");
  await page.getByLabel(/Describe the problem/).fill("Pop-ups everywhere and it is slow.");
  await choose(/How did you hear/i, "Social Media");
  await page.getByTestId("checkbox-sms-consent").check();
  await page.getByTestId("button-submit").click();
  await expect(page.getByTestId("text-ticket-number")).toContainText("CSD-1042");
  expect(intakes[0].intake_channel).toBeUndefined();
  expect(intakes[0].sms_consent).toBe(true);
});
