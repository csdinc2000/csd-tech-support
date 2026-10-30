import assert from "node:assert/strict";
import test from "node:test";
import {
  describeAuditChange,
  getAuditHistoryViewState,
  type AccessAuditEntry,
} from "./staff-access-history.ts";

test("access history exposes loading, empty, error, and populated states", () => {
  assert.equal(getAuditHistoryViewState({ isLoading: true, isError: false }), "loading");
  assert.equal(getAuditHistoryViewState({ isLoading: false, isError: false, data: [] }), "empty");
  assert.equal(getAuditHistoryViewState({ isLoading: false, isError: true }), "error");
  assert.equal(getAuditHistoryViewState({
    isLoading: false,
    isError: false,
    data: [{
      id: "audit-1",
      action: "access_updated",
      previousAccess: {},
      newAccess: {},
      createdAt: "2026-09-08T12:34:56.000Z",
      actorEmail: "admin@example.invalid",
      targetEmail: "staff@example.invalid",
    }],
  }), "populated");
});

test("role, approval, feature, voicemail, and assignment changes stay readable", () => {
  const entry: AccessAuditEntry = {
    id: "audit-2",
    action: "assignments_updated",
    previousAccess: {
      role: "field_technician",
      approval_status: "pending",
      can_view_voicemails: false,
      feature_permissions: { reports: false },
      clientIds: [1, 2],
      jobIds: [10],
    },
    newAccess: {
      role: "administrator",
      approval_status: "approved",
      can_view_voicemails: true,
      feature_permissions: { reports: true },
      clientIds: [2, 3],
      jobIds: [11],
    },
    createdAt: "2026-09-08T12:34:56.000Z",
    actorEmail: "admin@example.invalid",
    targetEmail: "staff@example.invalid",
  };

  assert.deepEqual(describeAuditChange(entry), [
    "Role: Field Technicians → Administrator",
    "Status: Pending approval → Approved",
    "View voicemails: Off → On",
    "Reports: Off → On",
    "Customers added: 3",
    "Customers removed: 1",
    "Jobs added: 11",
    "Jobs removed: 10",
  ]);
});

test("conflict recovery outcomes are distinct from access changes", () => {
  const base = {
    previousAccess: { recovery: "conflict" },
    newAccess: { outcome: "failed" },
    createdAt: "2026-09-08T12:34:56.000Z",
    actorEmail: "admin@example.invalid",
    targetEmail: "staff@example.invalid",
  };
  assert.deepEqual(describeAuditChange({
    ...base,
    id: "audit-recovery-failed",
    action: "conflict_recovery_failed",
  }), ["Conflict recovery failed: current settings could not be reloaded; no access change was made."]);
  assert.deepEqual(describeAuditChange({
    ...base,
    id: "audit-recovery-succeeded",
    action: "conflict_recovery_succeeded",
    newAccess: { outcome: "succeeded" },
  }), ["Conflict recovery succeeded: current settings were reloaded; no access change was made."]);
});