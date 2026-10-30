import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { isAdminApiPath, isAdminUser } from "../security";

const savedAdminEmails = process.env.ADMIN_EMAILS;
const savedLegacyAdminEmail = process.env.CSD_ADMIN_EMAIL;

function restoreAdminEnvironment() {
  if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = savedAdminEmails;

  if (savedLegacyAdminEmail === undefined) delete process.env.CSD_ADMIN_EMAIL;
  else process.env.CSD_ADMIN_EMAIL = savedLegacyAdminEmail;
}

function requestFor(email: string): Request {
  return {
    user: { claims: { email } },
  } as unknown as Request;
}

beforeEach(restoreAdminEnvironment);
afterEach(restoreAdminEnvironment);

test("administrator access is granted only to an allowlisted email", () => {
  process.env.ADMIN_EMAILS = "owner@example.com, second@example.com";
  delete process.env.CSD_ADMIN_EMAIL;

  assert.equal(isAdminUser(requestFor("OWNER@example.com")), true);
  assert.equal(isAdminUser(requestFor("staff@example.com")), false);
});

test("administrator access fails closed without an allowlist", () => {
  delete process.env.ADMIN_EMAILS;
  delete process.env.CSD_ADMIN_EMAIL;

  assert.equal(isAdminUser(requestFor("owner@example.com")), false);
});

test("account-wide communication and calendar APIs require an administrator", () => {
  assert.equal(isAdminApiPath("/api/twilio/settings", "GET"), true);
  assert.equal(isAdminApiPath("/api/call-tracking/numbers", "POST"), true);
  assert.equal(isAdminApiPath("/api/calendar/settings", "PATCH"), true);
});

test("helpdesk lookup reads stay available while configuration changes are protected", () => {
  assert.equal(isAdminApiPath("/api/helpdesk/departments", "GET"), false);
  assert.equal(isAdminApiPath("/api/helpdesk/departments", "POST"), true);
  assert.equal(isAdminApiPath("/api/helpdesk/settings", "GET"), true);
  assert.equal(isAdminApiPath("/api/helpdesk/integrations", "GET"), true);
  assert.equal(isAdminApiPath("/api/helpdesk/sla/check-overdue", "POST"), true);
  assert.equal(isAdminApiPath("/api/tickets", "GET"), false);
});