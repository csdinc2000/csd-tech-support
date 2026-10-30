import test from "node:test";
import assert from "node:assert/strict";
import {
  isAuthorizedDispatchPhone,
  normalizeDispatchPhone,
  parseStaffSmsCommand,
} from "../staff-dispatch-command";

test("staff command parser accepts only exact command forms", () => {
  assert.deepEqual(parseStaffSmsCommand(" claim csd-2026-0042 "), {
    kind: "claim",
    ticketNumber: "CSD-2026-0042",
  });
  assert.deepEqual(parseStaffSmsCommand("CLIENT CSD-2026-0042: On my way"), {
    kind: "client",
    ticketNumber: "CSD-2026-0042",
    message: "On my way",
  });
  assert.deepEqual(parseStaffSmsCommand("CLAIM"), { kind: "invalid" });
  assert.deepEqual(parseStaffSmsCommand("STATUS CSD-1 extra"), { kind: "invalid" });
  assert.deepEqual(parseStaffSmsCommand("hello"), { kind: "plain" });
});

test("authorization requires exact normalized phone and every permission flag", () => {
  const base = { phone: "+19545550123", enabled: true, onDuty: true, canUseCommands: true };
  assert.equal(normalizeDispatchPhone("(954) 555-0123"), "+19545550123");
  assert.equal(isAuthorizedDispatchPhone("(954) 555-0123", [base]), true);
  assert.equal(isAuthorizedDispatchPhone("+19545550124", [base]), false);
  assert.equal(isAuthorizedDispatchPhone(base.phone, [{ ...base, enabled: false }]), false);
  assert.equal(isAuthorizedDispatchPhone(base.phone, [{ ...base, onDuty: false }]), false);
  assert.equal(isAuthorizedDispatchPhone(base.phone, [{ ...base, canUseCommands: false }]), false);
});