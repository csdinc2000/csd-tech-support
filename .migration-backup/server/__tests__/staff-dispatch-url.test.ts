import test from "node:test";
import assert from "node:assert/strict";
import { buildStaffHelpdeskUrl } from "../staff-dispatch";

test("staff dispatch URL requires an explicitly configured public base URL", () => {
  assert.equal(buildStaffHelpdeskUrl("", 42), null);
  assert.equal(buildStaffHelpdeskUrl(undefined, 42), null);
  assert.equal(
    buildStaffHelpdeskUrl("https://support.example.test/", 42),
    "https://support.example.test/tickets?ticket=42",
  );
});