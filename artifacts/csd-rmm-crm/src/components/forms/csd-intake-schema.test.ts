import assert from "node:assert/strict";
import test from "node:test";
import { csdIntakeFormSchema } from "./csd-intake-schema";

const minimalPhoneSubmission = {
  customerName: "J",
  phoneNumber: "(954) 637-1234",
  contactPreference: "call",
  serviceId: "2",
  deviceType: "Laptop",
  problemDescription: "Computer will not start.",
  scheduleNow: false,
  smsConsent: false,
};

test("accepts required intake information while omitting optional fields", () => {
  const result = csdIntakeFormSchema.safeParse(minimalPhoneSubmission);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.emailAddress, "");
    assert.equal(result.data.deviceBrandModel, "");
    assert.equal(result.data.operatingSystem, "");
    assert.equal(result.data.howDidYouHear, "");
  }
});

test("accepts email-only submissions when email is the contact preference", () => {
  const result = csdIntakeFormSchema.safeParse({
    ...minimalPhoneSubmission,
    phoneNumber: "",
    emailAddress: "customer@example.com",
    contactPreference: "email",
  });
  assert.equal(result.success, true);
});

test("requires at least one valid contact method", () => {
  const result = csdIntakeFormSchema.safeParse({
    ...minimalPhoneSubmission,
    phoneNumber: "",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.flatten().fieldErrors.phoneNumber?.length);
  }
});

test("rejects malformed phone characters and invalid nonblank emails", () => {
  assert.equal(csdIntakeFormSchema.safeParse({
    ...minimalPhoneSubmission,
    phoneNumber: "954-ABC-1234",
  }).success, false);
  assert.equal(csdIntakeFormSchema.safeParse({
    ...minimalPhoneSubmission,
    emailAddress: "not-an-email",
  }).success, false);
});

test("requires contact details to match the chosen contact preference", () => {
  const result = csdIntakeFormSchema.safeParse({
    ...minimalPhoneSubmission,
    emailAddress: "",
    contactPreference: "email",
  });
  assert.equal(result.success, false);
});
