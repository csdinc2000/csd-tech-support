import assert from "node:assert/strict";
import test from "node:test";
import { meetingOnboardingStatus as status } from "./meeting-onboarding-status.ts";

test("sign-in alone and unaccepted pending profiles are not awaiting approval", () => {
  assert.equal(status({ email: "person@example.com", approvalStatus: null })?.label, "Not enrolled");
  assert.equal(status({ email: "person@example.com", approvalStatus: "pending" })?.label, "Not enrolled");
  assert.equal(status({ email: "person@example.com", approvalStatus: null, invitationStatus: "pending" })?.label, "Invitation pending");
});

test("only accepted onboarding is awaiting owner approval", () => {
  assert.equal(status({ email: "person@example.com", approvalStatus: "pending", requiresOwnerApproval: true })?.label, "Awaiting owner approval");
  assert.equal(status({ email: "person@example.com", approvalStatus: "pending", invitationStatus: "accepted" })?.label, "Awaiting owner approval");
});

test("suspension is never hidden by an invitation or missing email", () => {
  assert.equal(status({ email: null, approvalStatus: "suspended", invitationStatus: "pending" })?.label, "Suspended");
});

test("approved staff need a valid email; eligible staff have no blocker", () => {
  for (const email of [null, "", "person", "a b@example.com"]) {
    assert.equal(status({ email, approvalStatus: "approved" })?.label, "Missing email");
  }
  assert.equal(status({ email: " person@example.com ", approvalStatus: "approved" }), null);
});

test("expired and revoked invitations require a new invitation, not direct approval", () => {
  for (const invitationStatus of ["expired", "revoked"] as const) {
    const result = status({ email: "person@example.com", approvalStatus: null, invitationStatus });
    assert.equal(result?.label, "Not enrolled");
    assert.match(result!.guidance, /no longer active/);
  }
});
