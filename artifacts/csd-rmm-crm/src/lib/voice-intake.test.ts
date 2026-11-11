import assert from "node:assert/strict";
import test from "node:test";
import {
  VOICE_STEPS,
  changeFieldFromText,
  formWrites,
  localInterpret,
  nextStep,
  spokenDigits,
  spokenEmail,
  spokenEmailToAddress,
  spokenPhone,
  type VoiceField,
} from "./voice-intake.ts";

const options = {
  deviceType: ["Laptop", "Desktop", "All-in-One", "Other"],
  operatingSystem: ["Windows 11", "Windows 10", "Windows 8/8.1", "Windows 7", "macOS (Mac)", "Chrome OS", "Linux", "Other"],
  howDidYouHear: ["Google Search", "Existing Customer", "Referral from Friend/Family", "Flyer/Advertisement", "Social Media", "Yellow Pages", "Other"],
  services: [{ id: 3, name: "Computer Repair" }, { id: 7, name: "Virus Removal" }, { id: 9, name: "Data Recovery" }],
};

test("steps follow the existing form's fields and skip what is answered", () => {
  const answered = new Set<VoiceField>(["customerName", "deviceType", "deviceBrandModel"]);
  const skipped = new Set<VoiceField>(["companyName"]);
  assert.equal(nextStep((f) => answered.has(f), skipped)?.field, "phoneNumber");
  // Required steps are never skippable.
  const all = new Set(VOICE_STEPS.map((s) => s.field).filter((f) => f !== "operatingSystem"));
  assert.equal(nextStep((f) => all.has(f), new Set(["operatingSystem"]))?.field, "operatingSystem");
  assert.equal(nextStep(() => true, new Set()), null);
  // SMS consent is not a voice step at all.
  assert.equal(VOICE_STEPS.some((s) => (s.field as string) === "smsConsent"), false);
});

test("spoken phone numbers and emails become form values", () => {
  assert.equal(spokenDigits("nine five four five five five oh one two three"), "9545550123");
  assert.equal(spokenDigits("954 555 double one 23"), "9545551123");
  assert.equal(spokenEmailToAddress("my email is dana dot rivera at gmail dot com"), "dana.rivera@gmail.com");
  assert.equal(localInterpret("phoneNumber", "it's 954-555-0123", options).updates.phoneNumber, "9545550123");
  assert.equal(localInterpret("emailAddress", "Dana at example dot com", options).updates.emailAddress, "dana@example.com");
});

test("values are read back clearly for confirmation", () => {
  assert.equal(spokenPhone("9545550123"), "9 5 4, 5 5 5, 0 1 2 3");
  assert.equal(spokenEmail("dana.r@example.com"), "d a n a dot r at example dot com");
});

test("confirmation answers, including corrections in the same breath", () => {
  assert.equal(localInterpret("confirm:emailAddress", "yes that's right", options).intent, "yes");
  assert.equal(localInterpret("confirm:emailAddress", "no", options).intent, "no");
  const fix = localInterpret("confirm:phoneNumber", "no it's 954 555 0199", options);
  assert.equal(fix.intent, "change");
  assert.equal(fix.updates.phoneNumber, "9545550199");
});

test("natural answers map to the form's exact dropdown options", () => {
  const dell = localInterpret("deviceType", "It's a Dell laptop and it won't turn on", options);
  assert.equal(dell.updates.deviceType, "Laptop");
  assert.equal(dell.updates.deviceBrandModel, "Dell");
  assert.equal(localInterpret("operatingSystem", "it's a mac", options).updates.operatingSystem, "macOS (Mac)");
  assert.equal(localInterpret("operatingSystem", "not sure", options).updates.operatingSystem, "Other");
  assert.equal(localInterpret("howDidYouHear", "my neighbor recommended you", options).updates.howDidYouHear, "Referral from Friend/Family");
  assert.equal(localInterpret("serviceId", "virus removal please", options).updates.serviceId, 7);
  assert.equal(localInterpret("serviceId", "the second one", options).updates.serviceId, 7);
  assert.equal(localInterpret("contactPreference", "text me", options).updates.contactPreference, "text");
});

test("nothing is invented when the answer doesn't fit", () => {
  assert.equal(localInterpret("deviceType", "um", options).intent, "unclear");
  assert.deepEqual(localInterpret("operatingSystem", "the blue one", options).updates, {});
  assert.equal(localInterpret("companyName", "skip", options).intent, "skip");
  // A long answer that starts with "I don't know" is still a description.
  const desc = localInterpret("problemDescription", "I don't know why but it shuts off after ten minutes", options);
  assert.equal(desc.intent, "answer");
  assert.match(desc.updates.problemDetail!, /shuts off/);
});

test("sensitive information is refused", () => {
  assert.equal(localInterpret("problemDescription", "my password is hunter2", options).intent, "sensitive");
});

test("review never treats 'yes' or 'no' as submission approval", () => {
  assert.equal(localInterpret("review", "yes", options).intent, "yes");
  assert.equal(localInterpret("review", "no, looks good", options).intent, "no");
  assert.equal(localInterpret("review", "please submit it", options).intent, "submit");
  assert.equal(localInterpret("review", "don't submit yet", options).intent, "yes");
  const change = localInterpret("review", "I need to change my email", options);
  assert.equal(change.intent, "change");
  assert.equal(change.changeField, "emailAddress");
  assert.equal(localInterpret("confirm:submit", "yes go ahead", options).intent, "yes");
  assert.equal(changeFieldFromText("my email is fine"), null);
});

test("problem details accumulate instead of overwriting", () => {
  assert.deepEqual(formWrites({ problemDetail: "It won't turn on." }, {}, false), { problemDescription: "It won't turn on." });
  assert.deepEqual(
    formWrites({ problemDetail: "No lights when I press power." }, { problemDescription: "It won't turn on" }, false),
    { problemDescription: "It won't turn on. No lights when I press power." },
  );
  assert.deepEqual(formWrites({ problemDetail: "Screen is cracked." }, { problemDescription: "Old text" }, true), { problemDescription: "Screen is cracked." });
  assert.deepEqual(formWrites({ deviceType: "Laptop", deviceBrandModel: "" }, {}, false), { deviceType: "Laptop" });
});
