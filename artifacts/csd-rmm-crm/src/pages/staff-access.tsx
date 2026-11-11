import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock3, History, RotateCcw, ShieldCheck, ShieldOff, Trash2, UsersRound, Voicemail, Search } from "lucide-react";
import { Link, useLocation } from "wouter";
import { ApiRequestError, apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { ApprovalStatus, StaffCapabilities, StaffFeature, StaffRole } from "@/hooks/use-admin-access";
import { useAdminAccess } from "@/hooks/use-admin-access";
import StaffInviteManager from "./staff-invite-manager";
import { StaffContactEditor } from "./staff-contact-editor";
import { accountLabel, isAccountsPage, StaffAccountDirectoryRoster } from "./staff-account-directory";
import type { AccountsPage } from "./staff-account-directory";
import type { StaffAccountDirectoryEntry } from "./staff-dispatch-handoff";
import {
  describeAuditChange,
  getAuditHistoryViewState,
  isRecoveryAuditAction,
  type AccessAuditEntry,
} from "./staff-access-history";

type EditableRole = Exclude<StaffRole, "owner">;
type StaffProfile = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  helpdeskAssigneeId?: number | null;
  requiresOwnerApproval?: boolean;
  role: StaffRole;
  approvalStatus: ApprovalStatus;
  isOwner: boolean;
  features: Record<StaffFeature, boolean>;
  effectiveFeatures: Record<StaffFeature, boolean>;
  capabilities: StaffCapabilities;
  assignments: {
    clientIds: number[];
    jobIds: number[];
    contactAssignments: Array<{ contactId: number; canEdit: boolean }>;
  };
  updatedAt: string | null;
};
type ClientOption = { id: number; name: string };
type JobOption = { id: number; jobNumber: string; clientName?: string | null };
type ContactOption = { id: number; fullName: string; email?: string | null };
type RoleFeatureDefaults = Record<EditableRole, Record<StaffFeature, boolean>>;
type AccessSnapshot = {
  role: StaffRole;
  approvalStatus: ApprovalStatus;
  features: Record<StaffFeature, boolean>;
  capabilities: StaffCapabilities;
  updatedAt: string | null;
  assignments?: StaffProfile["assignments"];
};
type AccessConflict = {
  baseline: AccessSnapshot;
  latest: AccessSnapshot;
};
type StaffRecoveryAlert = {
  id: number;
  title: string;
  description: string | null;
  alertSource: string | null;
  severity: string;
};

// Communications hub tab switches. They only apply while the person also has
// the Communications feature.
const COMMUNICATION_TOOL_OPTIONS: Array<{ key: "smsInbox" | "callTracking" | "mainLineSetup"; label: string; hint: string }> = [
  { key: "smsInbox", label: "Inbox & SMS", hint: "Shared text inbox, conversation history and bulk texts." },
  { key: "callTracking", label: "Calls & Tracking", hint: "Tracking numbers, call flows, and linking calls to contacts or tickets." },
  { key: "mainLineSetup", label: "Main Line Setup", hint: "Where customer calls and texts are forwarded, voicemail greeting and call log." },
];

const FEATURE_OPTIONS: Array<{ key: StaffFeature; label: string; sensitive?: boolean; hint?: string }> = [
  { key: "dashboard", label: "Dashboard" },
  { key: "crm", label: "Customers & CRM", hint: "Enables customer and job pages. Customer, job, and contact assignments still limit what staff can see." },
  { key: "communications", label: "Communications" },
  { key: "scheduling", label: "Scheduling" },
  { key: "operations", label: "Devices & operations" },
  { key: "helpdesk", label: "Help desk" },
  { key: "invoices", label: "Invoices", sensitive: true },
  { key: "reports", label: "Reports" },
  { key: "automation", label: "Automation", sensitive: true },
  { key: "compliance", label: "Compliance", sensitive: true },
  { key: "helpdeskAdmin", label: "Helpdesk configuration", sensitive: true },
  { key: "dispatchAdmin", label: "Dispatch configuration", sensitive: true },
  { key: "marketplace", label: "Community marketplace" },
];

function statusBadge(status: ApprovalStatus, profileId: string) {
  if (status === "approved") {
    return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800 shadow-none hover:bg-emerald-50" data-testid={`badge-status-approved-${profileId}`}>Approved</Badge>;
  }
  if (status === "suspended") {
    return <Badge variant="destructive" className="shadow-none" data-testid={`badge-status-suspended-${profileId}`}>Suspended</Badge>;
  }
  return <Badge className="border-amber-200 bg-amber-50 text-amber-900 shadow-none hover:bg-amber-50" data-testid={`badge-status-pending-${profileId}`}>Pending approval</Badge>;
}

const ROLE_LABELS: Record<EditableRole, string> = {
  administrator: "Administrator",
  field_technician: "Field Technician",
  software_developer: "Software Developer",
  accounting: "Accounting",
  it_manager: "IT Manager",
  legal_team: "Legal Team",
  secretary: "Secretary",
};

type StaffAccessHook = () => Pick<ReturnType<typeof useAdminAccess>, "isAdmin" | "role" | "isLoading">;

function roleLabel(role: StaffRole) {
  return role === "owner" ? "Owner" : ROLE_LABELS[role];
}

function approvalLabel(status: ApprovalStatus) {
  return status === "approved" ? "Approved" : status === "suspended" ? "Suspended" : "Pending approval";
}

function snapshotFromProfile(profile: StaffProfile): AccessSnapshot {
  return {
    role: profile.role === "owner" ? "administrator" : profile.role,
    approvalStatus: profile.approvalStatus,
    features: { ...profile.features },
    capabilities: { ...profile.capabilities },
    updatedAt: profile.updatedAt,
    assignments: {
      clientIds: [...profile.assignments.clientIds],
      jobIds: [...profile.assignments.jobIds],
      contactAssignments: profile.assignments.contactAssignments.map((assignment) => ({ ...assignment })),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isUsableStaffProfile(value: unknown): value is StaffProfile {
  if (!isRecord(value) || typeof value.id !== "string"
    || (value.updatedAt !== null && typeof value.updatedAt !== "string")) return false;
  if (typeof value.role !== "string" || typeof value.approvalStatus !== "string" || typeof value.isOwner !== "boolean") return false;
  const features = value.features;
  if (!isRecord(features) || !FEATURE_OPTIONS.every(({ key }) => typeof features[key] === "boolean")) return false;
  const effectiveFeatures = value.effectiveFeatures;
  if (!isRecord(effectiveFeatures) || !FEATURE_OPTIONS.every(({ key }) => typeof effectiveFeatures[key] === "boolean")) return false;
  if (!isRecord(value.capabilities) || typeof value.capabilities.viewVoicemails !== "boolean") return false;
  if (!isRecord(value.assignments)) return false;
  return Array.isArray(value.assignments.clientIds)
    && value.assignments.clientIds.every((id) => typeof id === "number")
    && Array.isArray(value.assignments.jobIds)
    && value.assignments.jobIds.every((id) => typeof id === "number")
    && Array.isArray(value.assignments.contactAssignments)
    && value.assignments.contactAssignments.every((assignment) =>
      isRecord(assignment) && typeof assignment.contactId === "number" && typeof assignment.canEdit === "boolean");
}

function includesUsableStaffProfile(value: unknown, profileId: string): value is StaffProfile[] {
  return Array.isArray(value) && value.some((candidate) => isUsableStaffProfile(candidate) && candidate.id === profileId);
}

function profileFromReload(value: unknown, profileId: string): StaffProfile | null {
  if (!includesUsableStaffProfile(value, profileId)) return null;
  return value.find((candidate) => candidate.id === profileId) ?? null;
}

function conflictFromError(error: unknown): AccessSnapshot | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const payload = error.payload;
  if (!payload || typeof payload !== "object" || !("latestAccess" in payload)) return null;
  const latestAccess = payload.latestAccess;
  if (!latestAccess || typeof latestAccess !== "object") return null;
  return latestAccess as AccessSnapshot;
}

function changedFields(baseline: AccessSnapshot, latest: AccessSnapshot) {
  const changes: Array<{ label: string; before: string; after: string }> = [];
  if (baseline.role !== latest.role) {
    changes.push({ label: "Role", before: roleLabel(baseline.role), after: roleLabel(latest.role) });
  }
  if (baseline.approvalStatus !== latest.approvalStatus) {
    changes.push({ label: "Approval", before: approvalLabel(baseline.approvalStatus), after: approvalLabel(latest.approvalStatus) });
  }
  for (const feature of FEATURE_OPTIONS) {
    if (baseline.features[feature.key] !== latest.features[feature.key]) {
      changes.push({
        label: feature.label,
        before: baseline.features[feature.key] ? "Enabled" : "Disabled",
        after: latest.features[feature.key] ? "Enabled" : "Disabled",
      });
    }
  }
  if (baseline.capabilities.viewVoicemails !== latest.capabilities.viewVoicemails) {
    changes.push({
      label: "View voicemails",
      before: baseline.capabilities.viewVoicemails ? "Enabled" : "Disabled",
      after: latest.capabilities.viewVoicemails ? "Enabled" : "Disabled",
    });
  }
  for (const tool of COMMUNICATION_TOOL_OPTIONS) {
    const before = baseline.capabilities[tool.key];
    const after = latest.capabilities[tool.key];
    if (typeof after === "boolean" && before !== after) {
      changes.push({ label: tool.label, before: before ? "Enabled" : "Disabled", after: after ? "Enabled" : "Disabled" });
    }
  }
  if (latest.assignments) {
    const baselineClients = [...(baseline.assignments?.clientIds ?? [])].sort((a, b) => a - b);
    const latestClients = [...latest.assignments.clientIds].sort((a, b) => a - b);
    if (baselineClients.join(",") !== latestClients.join(",")) {
      changes.push({ label: "Assigned customers", before: baselineClients.length ? baselineClients.join(", ") : "None", after: latestClients.length ? latestClients.join(", ") : "None" });
    }
    const baselineJobs = [...(baseline.assignments?.jobIds ?? [])].sort((a, b) => a - b);
    const latestJobs = [...latest.assignments.jobIds].sort((a, b) => a - b);
    if (baselineJobs.join(",") !== latestJobs.join(",")) {
      changes.push({ label: "Assigned jobs", before: baselineJobs.length ? baselineJobs.join(", ") : "None", after: latestJobs.length ? latestJobs.join(", ") : "None" });
    }
    const summarizeContacts = (items: StaffProfile["assignments"]["contactAssignments"]) =>
      items.slice().sort((a, b) => a.contactId - b.contactId)
        .map((assignment) => `${assignment.contactId}:${assignment.canEdit ? "edit" : "view"}`).join(", ");
    const beforeContacts = summarizeContacts(baseline.assignments?.contactAssignments ?? []);
    const afterContacts = summarizeContacts(latest.assignments.contactAssignments);
    if (beforeContacts !== afterContacts) {
      changes.push({ label: "Assigned contacts", before: beforeContacts || "None", after: afterContacts || "None" });
    }
  }
  return changes;
}


const AUDIT_PREVIEW_COUNT = 15;

function displayName(profile: StaffProfile) {
  return [profile.firstName, profile.lastName].filter(Boolean).join(" ")
    || profile.email
    || `Unnamed staff · ${profile.id.slice(-6)}`;
}

function SectionHeading({ title, hint, aside }: { title: string; hint?: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {aside}
    </div>
  );
}

function AssignmentList({
  title,
  count,
  emptyText,
  children,
  isLoading = false,
  error,
  onRetry,
}: {
  title: string;
  count: number;
  emptyText: string;
  children: ReactNode;
  isLoading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {isLoading ? (
          <p className="p-4 text-center text-xs text-muted-foreground">Loading {title.toLowerCase()}…</p>
        ) : error ? (
          <div className="flex items-center justify-between gap-3 p-3 text-xs text-destructive" role="alert">
            <span>{error}</span>
            {onRetry && <Button type="button" variant="ghost" size="sm" onClick={onRetry}>Retry</Button>}
          </div>
        ) : count === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">{emptyText}</p>
        ) : children}
      </div>
    </div>
  );
}

const checkboxClass = "mt-0.5 h-4 w-4 shrink-0 rounded-sm border-input text-csd-red focus:ring-csd-red disabled:opacity-50";
const assignmentRowClass = "flex items-start gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50";

function SuspendButton({ onSuspend, disabled, id }: { onSuspend: () => void; disabled: boolean; id: string }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex items-center gap-2" data-testid={`suspend-confirm-group-${id}`}>
        <span className="text-sm text-muted-foreground">Suspend this account?</span>
        <Button size="sm" variant="destructive" onClick={() => { onSuspend(); setConfirming(false); }} data-testid={`button-confirm-suspend-${id}`}>Suspend</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} data-testid={`button-cancel-suspend-${id}`}>Cancel</Button>
      </div>
    );
  }

  return (
    <Button size="sm" variant="outline" className="text-red-700 hover:text-red-800" disabled={disabled} onClick={() => setConfirming(true)} data-testid={`button-suspend-${id}`}>
      <ShieldOff className="mr-1.5 h-4 w-4" aria-hidden="true" /> Suspend
    </Button>
  );
}

export default function StaffAccessPage({ useAccess = useAdminAccess }: { useAccess?: StaffAccessHook } = {}) {
  const { toast } = useToast();
  const { isAdmin, role } = useAccess();
  const isOwner = role === "owner";
  const [, setLocation] = useLocation();
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [contactDirty, setContactDirty] = useState(false);
  const [selectedClerkUserId, setSelectedClerkUserId] = useState<string | null>(null);
  const [searchMatchedProfileIds, setSearchMatchedProfileIds] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<Record<string, AccessConflict>>({});
  const [pendingReloads, setPendingReloads] = useState<Record<string, number>>({});
  const [showAllAudit, setShowAllAudit] = useState(false);
  const [firstNameDraft, setFirstNameDraft] = useState("");
  const [lastNameDraft, setLastNameDraft] = useState("");
  const identityDrafts = useRef<Record<string, { firstName: string; lastName: string; dirty: boolean }>>({});
  const reloadRequestVersions = useRef<Record<string, number>>({});
  const handleMatchedProfileIds = useCallback((profileIds: string[]) => {
    setSearchMatchedProfileIds(profileIds);
  }, []);

  const staff = useQuery<StaffProfile[]>({
    queryKey: ["/api/staff-access"],
    queryFn: async (context) => {
      const data = await getQueryFn<unknown>({ on401: "throw" })(context);
      if (!Array.isArray(data) || !data.every(isUsableStaffProfile)) {
        throw new Error("Staff accounts response was unusable");
      }
      return data as StaffProfile[];
    },
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });

  const selectedDirectoryAccountQuery = useQuery<StaffAccountDirectoryEntry | null>({
    queryKey: ["/api/staff-access/accounts", "clerkUserId", selectedClerkUserId],
    queryFn: async () => {
      if (!selectedClerkUserId) return null;
      const params = new URLSearchParams({ clerkUserId: selectedClerkUserId });
      const response = await apiRequest("GET", `/api/staff-access/accounts?${params.toString()}`);
      const payload: unknown = await response.json();
      if (!isAccountsPage(payload)) throw new Error("Sign-in account response was unusable");
      return payload.accounts.find((account) => account.clerkUserId === selectedClerkUserId) ?? null;
    },
    enabled: isOwner && selectedClerkUserId !== null,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });

  const roleDefaults = useQuery<RoleFeatureDefaults>({
    queryKey: ["/api/staff-access/role-features"],
    staleTime: Infinity,
  });

  const audit = useQuery<AccessAuditEntry[]>({
    queryKey: ["/api/staff-access/audit"],
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });

  const activeAlerts = useQuery<StaffRecoveryAlert[]>({
    queryKey: ["/api/alerts/active"],
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });

  const recoveryAlerts = (activeAlerts.data ?? []).filter(
    (alert) => alert.alertSource === "staff-access-recovery",
  );

  const recordRecoveryOutcome = async (profileId: string, outcome: "succeeded" | "failed") => {
    try {
      await apiRequest("POST", `/api/staff-access/${encodeURIComponent(profileId)}/recovery-audit`, { outcome });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/audit"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/alerts/active"] }),
      ]);
    } catch {
      // Recovery logging must never replace the conflict warning or expose a
      // reload response to the administrator.
    }
  };

  const clients = useQuery<ClientOption[]>({ queryKey: ["/api/clients"], staleTime: 30_000 });
  const jobs = useQuery<JobOption[]>({ queryKey: ["/api/crm/jobs"], staleTime: 30_000 });
  const contacts = useQuery<ContactOption[]>({ queryKey: ["/api/crm/contacts"], staleTime: 30_000 });

  const updateAssignments = useMutation({
    mutationFn: async ({ profile, assignments }: { profile: StaffProfile; assignments: StaffProfile["assignments"] }) => {
      const response = await apiRequest("PUT", `/api/staff-access/${encodeURIComponent(profile.id)}/assignments`, {
        ...assignments,
        expectedUpdatedAt: profile.updatedAt,
      });
      return response.json();
    },
    onSuccess: async (_result, variables) => {
      setConflicts((current) => {
        const next = { ...current };
        delete next[variables.profile.id];
        return next;
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/audit"] }),
      ]);
      toast({ title: "Assignments updated" });
    },
    onError: async (error: Error, variables) => {
      const latest = conflictFromError(error);
      if (latest) {
        setConflicts((current) => ({
          ...current,
          [variables.profile.id]: { baseline: snapshotFromProfile(variables.profile), latest },
        }));
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] });
      toast({ title: "Assignments could not be updated", description: error.message, variant: "destructive" });
    },
  });

  const updateIdentity = useMutation({
    mutationFn: async ({ profile, firstName, lastName }: {
      profile: StaffProfile;
      firstName: string;
      lastName: string;
    }) => {
      const response = await apiRequest(
        "PATCH",
        `/api/staff-access/${encodeURIComponent(profile.id)}/identity`,
        { firstName, lastName },
      );
      return response.json();
    },
    onSuccess: async (_result, variables) => {
      identityDrafts.current[variables.profile.id] = {
        firstName: variables.firstName.trim(),
        lastName: variables.lastName.trim(),
        dirty: false,
      };
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/audit"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/eligible-assignees"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/audit"] }),
      ]);
      toast({ title: "Staff name saved" });
    },
    onError: (error: Error) => {
      toast({
        title: "Staff name could not be saved",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createHelpdeskAssignee = useMutation({
    mutationFn: async (userId: string) => {
      const response = await apiRequest("POST", `/api/staff-access/${encodeURIComponent(userId)}/helpdesk-assignee`);
      return response.json() as Promise<{ id: number; name: string; email: string }>;
    },
    onSuccess: async (assignee) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/audit"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/eligible-assignees"] }),
      ]);
      setLocation(`/staff?tab=dispatch&assigneeId=${assignee.id}`);
      toast({ title: "Helpdesk assignee ready", description: "Configure this approved assignee in Dispatch Settings." });
    },
    onError: (error: Error) => {
      toast({ title: "Could not link helpdesk assignee", description: error.message, variant: "destructive" });
    },
  });

  const deleteAccount = useMutation({
    mutationFn: async ({ id, email }: { id: string; email: string }) => {
      const response = await apiRequest("DELETE", `/api/staff-access/${encodeURIComponent(id)}/account`, { confirmEmail: email });
      return response.json() as Promise<{ deleted: true }>;
    },
    onSuccess: async () => {
      setDeleteTargetId(null);
      setDeleteConfirmation("");
      setSelectedProfileId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/audit"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/invites"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/eligible-assignees"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/audit"] }),
      ]);
      toast({ title: "Account permanently deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Account was not fully deleted", description: error.message, variant: "destructive" });
    },
  });

  const update = useMutation({
    mutationFn: async ({ profile, patch }: { profile: StaffProfile; patch: Partial<StaffProfile> }) => {
      if (profile.isOwner) {
        if (!isOwner || !patch.approvalStatus) throw new Error("Only an active owner can change owner status");
        const response = await apiRequest("PATCH", `/api/staff-access/${encodeURIComponent(profile.id)}/owner-status`, {
          approvalStatus: patch.approvalStatus,
          expectedUpdatedAt: profile.updatedAt,
        });
        return response.json();
      }
      const next = {
        ...profile,
        ...patch,
        features: { ...profile.features, ...patch.features },
        capabilities: { ...profile.capabilities, ...patch.capabilities },
      };
      const response = await apiRequest("PATCH", `/api/staff-access/${encodeURIComponent(profile.id)}`, {
        role: next.role,
        approvalStatus: next.approvalStatus,
        features: next.features,
        capabilities: next.capabilities,
        expectedUpdatedAt: profile.updatedAt,
      });
      return response.json();
    },
    onSuccess: async (_result, variables) => {
      setConflicts((current) => {
        const next = { ...current };
        delete next[variables.profile.id];
        return next;
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/audit"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/auth/access"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/eligible-assignees"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-dispatch/audit"] }),
      ]);
      toast({ title: "Access status updated" });
    },
    onError: async (error: Error, variables) => {
      const latest = conflictFromError(error);
      if (latest) {
        setConflicts((current) => ({
          ...current,
          [variables.profile.id]: { baseline: snapshotFromProfile(variables.profile), latest },
        }));
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] });
      toast({
        title: "Access could not be updated",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const pendingCount = staff.data?.filter((profile) => profile.approvalStatus === "pending" && !profile.isOwner).length ?? 0;
  const auditViewState = getAuditHistoryViewState(audit);

  const sortedStaff = useMemo(() => {
    if (!staff.data) return [];
    return [...staff.data].sort((a, b) => {
      if (a.approvalStatus === "pending" && b.approvalStatus !== "pending") return -1;
      if (b.approvalStatus === "pending" && a.approvalStatus !== "pending") return 1;

      if (a.isOwner && !b.isOwner) return 1;
      if (b.isOwner && !a.isOwner) return -1;

      if (a.approvalStatus === "suspended" && b.approvalStatus !== "suspended") return 1;
      if (b.approvalStatus === "suspended" && a.approvalStatus !== "suspended") return -1;

      return displayName(a).localeCompare(displayName(b));
    });
  }, [staff.data]);

  const searchFilteredStaff = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sortedStaff;
    return sortedStaff.filter((profile) =>
      `${displayName(profile)} ${profile.email ?? ""} ${roleLabel(profile.role)}`.toLowerCase().includes(query));
  }, [sortedStaff, searchQuery]);

  const filteredStaff = useMemo(() => {
    if (searchMatchedProfileIds.length === 0) return searchFilteredStaff;
    const includeIds = new Set(searchMatchedProfileIds);
    return sortedStaff.filter((profile) => includeIds.has(profile.id)
      || searchFilteredStaff.some((matched) => matched.id === profile.id));
  }, [searchFilteredStaff, searchMatchedProfileIds, sortedStaff]);

  useEffect(() => {
    if (!selectedProfileId && !selectedClerkUserId && filteredStaff.length > 0) {
      setSelectedProfileId(filteredStaff[0].id);
    }
  }, [filteredStaff, selectedProfileId, selectedClerkUserId]);

  const selectedDirectoryAccount = selectedClerkUserId
    ? selectedDirectoryAccountQuery.data ?? null
    : null;
  const selectedLinkedProfile = useMemo(
    () => selectedDirectoryAccount
      ? staff.data?.find((profile) =>
        profile.id === selectedDirectoryAccount.staffUserId
        || profile.id === selectedDirectoryAccount.clerkUserId) ?? null
      : null,
    [selectedDirectoryAccount, staff.data],
  );
  const selectedProfile = useMemo(
    () => sortedStaff.find((profile) => profile.id === selectedProfileId) ?? selectedLinkedProfile,
    [selectedLinkedProfile, selectedProfileId, sortedStaff],
  );
  const canManageInvitations = !selectedClerkUserId
    || Boolean(
      selectedDirectoryAccount
      && !selectedDirectoryAccount.staffUserId
      && !selectedLinkedProfile
      && !selectedDirectoryAccountQuery.isError
      && !selectedDirectoryAccountQuery.isFetching,
    );
  const lastLinkedAccountRefresh = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedDirectoryAccount || selectedLinkedProfile) return;
    const linkedUserId = selectedDirectoryAccount.staffUserId
      ?? (staff.data?.some((profile) => profile.id === selectedDirectoryAccount.clerkUserId)
        ? selectedDirectoryAccount.clerkUserId
        : null);
    if (!linkedUserId) return;
    const linkKey = `${selectedDirectoryAccount.clerkUserId}:${linkedUserId}`;
    if (lastLinkedAccountRefresh.current === linkKey) return;
    lastLinkedAccountRefresh.current = linkKey;
    void queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] });
  }, [selectedDirectoryAccount, selectedLinkedProfile, staff.data]);

  useEffect(() => {
    if (!selectedLinkedProfile) return;
    setSelectedProfileId(selectedLinkedProfile.id);
    setSelectedClerkUserId(null);
  }, [selectedLinkedProfile?.id]);
  const lastActiveOwner = (staff.data?.filter((profile) => profile.isOwner && profile.approvalStatus === "approved").length ?? 0) <= 1;

  useEffect(() => {
    setDeleteTargetId(null);
    setDeleteConfirmation("");
  }, [selectedProfileId, selectedClerkUserId]);

  useEffect(() => {
    if (!selectedProfile) return;
    const cachedDraft = identityDrafts.current[selectedProfile.id];
    if (cachedDraft?.dirty) {
      setFirstNameDraft(cachedDraft.firstName);
      setLastNameDraft(cachedDraft.lastName);
      return;
    }
    const firstName = selectedProfile.firstName ?? "";
    const lastName = selectedProfile.lastName ?? "";
    setFirstNameDraft(firstName);
    setLastNameDraft(lastName);
    identityDrafts.current[selectedProfile.id] = { firstName, lastName, dirty: false };
  }, [selectedProfile?.id, selectedProfile?.firstName, selectedProfile?.lastName]);

  const disabled = selectedProfile ? (update.isPending || updateAssignments.isPending || selectedProfile.isOwner) : false;
  const identityChanged = selectedProfile
    ? firstNameDraft.trim() !== (selectedProfile.firstName ?? "")
      || lastNameDraft.trim() !== (selectedProfile.lastName ?? "")
    : false;
  const conflict = selectedProfile ? conflicts[selectedProfile.id] : undefined;
  const reloadPending = selectedProfile ? pendingReloads[selectedProfile.id] !== undefined : false;
  const conflictChanges = conflict ? changedFields(conflict.baseline, conflict.latest) : [];

  const auditEntries = audit.data ?? [];
  const visibleAudit = showAllAudit ? auditEntries : auditEntries.slice(0, AUDIT_PREVIEW_COUNT);

  const reloadCurrentSettings = async (profile: StaffProfile) => {
    const reloadRequestVersion = (reloadRequestVersions.current[profile.id] ?? 0) + 1;
    reloadRequestVersions.current[profile.id] = reloadRequestVersion;
    setPendingReloads((current) => ({ ...current, [profile.id]: reloadRequestVersion }));
    let reloadedProfile: StaffProfile | null = null;
    try {
      const response = await apiRequest("GET", "/api/staff-access");
      reloadedProfile = profileFromReload(await response.json(), profile.id);
    } catch {
      reloadedProfile = null;
    }
    if (reloadRequestVersions.current[profile.id] !== reloadRequestVersion) return;
    const recoveryOutcome = reloadedProfile ? "succeeded" : "failed";
    void recordRecoveryOutcome(profile.id, recoveryOutcome);
    setPendingReloads((current) => {
      if (current[profile.id] !== reloadRequestVersion) return current;
      const next = { ...current };
      delete next[profile.id];
      return next;
    });
    if (recoveryOutcome === "failed") {
      toast({
        title: "Current settings could not be reloaded",
        description: "The conflict warning is still shown. Try reloading again before making another change.",
        variant: "destructive",
      });
      return;
    }
    queryClient.setQueryData<StaffProfile[]>(["/api/staff-access"], (current) =>
      current?.map((candidate) => candidate.id === profile.id ? reloadedProfile! : candidate),
    );
    setConflicts((current) => {
      const next = { ...current };
      delete next[profile.id];
      return next;
    });
  };

  const cancelReload = (profile: StaffProfile) => {
    reloadRequestVersions.current[profile.id] = (reloadRequestVersions.current[profile.id] ?? 0) + 1;
    setPendingReloads((current) => {
      if (current[profile.id] === undefined) return current;
      const next = { ...current };
      delete next[profile.id];
      return next;
    });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="page-title">Staff access</h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="page-description">
          Approve accounts, assign roles, and control which features and records each person can reach. Every change is logged.
        </p>
      </header>

      {pendingCount > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="alert-pending-count">
          <Clock3 className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>{pendingCount} account{pendingCount === 1 ? "" : "s"} awaiting approval. Pending accounts cannot access the app until approved.</span>
        </div>
      )}

      {recoveryAlerts.length > 0 && (
        <div role="alert" aria-live="polite" className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900" data-testid="alert-recovery-needed">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium">Staff access recovery needs attention</p>
            {recoveryAlerts.map((alert) => (
              <p key={alert.id}>{alert.description || alert.title}</p>
            ))}
          </div>
        </div>
      )}

      {staff.isLoading && (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading staff accounts…</p>
      )}

      {staff.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-800">
          <p>Staff accounts could not be loaded.</p>
          <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void staff.refetch()} data-testid="button-retry-staff-access">Try again</Button>
        </div>
      )}

      {!staff.isLoading && !staff.isError && sortedStaff.length === 0 && !isOwner && (
        <Card className="border-dashed shadow-none">
          <CardContent className="flex flex-col items-center p-12 text-center">
            <UsersRound className="mb-3 h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
            <p className="font-medium">No staff accounts yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Accounts appear here after a team member signs in for the first time.
            </p>
          </CardContent>
        </Card>
      )}

      {!staff.isLoading && (sortedStaff.length > 0 || isOwner) && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          {/* Staff list */}
          <Card className="self-start shadow-none">
            <div className="border-b p-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Search staff and sign-in accounts"
                  aria-label="Search staff and sign-in accounts"
                  className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-csd-red"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchMatchedProfileIds([]);
                  }}
                  data-testid="input-search-staff-roster"
                />
              </div>
            </div>
            <ul className="max-h-[70vh] divide-y overflow-y-auto" data-testid="list-staff-roster">
              {filteredStaff.length === 0 && (
                <li className="px-4 py-4 text-sm text-muted-foreground">
                  {searchQuery.trim() ? "No matching staff profiles." : "No staff profiles yet."}
                </li>
              )}
              {filteredStaff.map((p) => {
                const isSelected = selectedProfileId === p.id && !selectedDirectoryAccount;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      data-testid={`list-item-staff-${p.id}`}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => {
                        if ((p.id !== selectedProfileId || selectedClerkUserId) && contactDirty
                          && !window.confirm("Discard unsaved staff contact information?")) return;
                        if (p.id !== selectedProfileId || selectedClerkUserId) setContactDirty(false);
                        setSelectedClerkUserId(null);
                        setSelectedProfileId(p.id);
                      }}
                      className={cn(
                        "w-full px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-muted/50",
                        isSelected && "bg-muted/60 hover:bg-muted/60",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{displayName(p)}</span>
                        {p.isOwner ? (
                          <span className="text-xs text-muted-foreground">Owner</span>
                        ) : p.approvalStatus === "pending" ? (
                          <span className="text-xs font-medium text-amber-700">Pending approval</span>
                        ) : p.approvalStatus === "suspended" ? (
                          <span className="text-xs font-medium text-red-700">Suspended</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">{p.email && p.email !== displayName(p) ? p.email : roleLabel(p.role)}</div>
                    </button>
                  </li>
                );
              })}
              {isOwner && (
                <StaffAccountDirectoryRoster
                  searchQuery={searchQuery}
                  staffProfileIds={new Set((staff.data ?? []).map((profile) => profile.id))}
                  onMatchedProfileIds={handleMatchedProfileIds}
                  selectedClerkUserId={selectedClerkUserId}
                  onSelectAccount={(account) => {
                    if (contactDirty && !window.confirm("Discard unsaved staff contact information?")) return;
                    setContactDirty(false);
                    setSelectedProfileId(null);
                    setSelectedClerkUserId(account.clerkUserId);
                  }}
                />
              )}
            </ul>
          </Card>

          {/* Selected account */}
          <div className="min-w-0 space-y-4">
          {selectedProfile ? (
            <Card key={selectedProfile.id} className="min-w-0 shadow-none" data-testid={`card-staff-${selectedProfile.id}`}>
              <div className="flex flex-col gap-4 border-b p-5 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold">{displayName(selectedProfile)}</h2>
                    {selectedProfile.isOwner && <Badge variant="outline" className="shadow-none" data-testid="badge-status-owner">Owner</Badge>}
                    {statusBadge(selectedProfile.approvalStatus, selectedProfile.id)}
                  </div>
                  {selectedProfile.email && selectedProfile.email !== displayName(selectedProfile) && (
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">{selectedProfile.email}</p>
                  )}
                </div>
                {(!selectedProfile.isOwner || isOwner) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      className="bg-emerald-600 text-white hover:bg-emerald-700"
                      disabled={update.isPending || selectedProfile.approvalStatus === "approved" || (selectedProfile.requiresOwnerApproval && !isOwner)}
                      onClick={() => update.mutate({ profile: selectedProfile, patch: { approvalStatus: "approved" } })}
                      data-testid={`button-approve-${selectedProfile.id}`}
                    >
                      <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden="true" /> Approve
                    </Button>
                    {selectedProfile.requiresOwnerApproval && !isOwner && selectedProfile.approvalStatus !== "approved" && (
                      <span className="text-xs text-amber-800">The owner must approve invited accounts.</span>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={update.isPending || selectedProfile.approvalStatus === "pending" || (selectedProfile.isOwner && lastActiveOwner)}
                      onClick={() => update.mutate({ profile: selectedProfile, patch: { approvalStatus: "pending" } })}
                      data-testid={`button-pending-${selectedProfile.id}`}
                    >
                      Set pending
                    </Button>
                    <SuspendButton
                      onSuspend={() => update.mutate({ profile: selectedProfile, patch: { approvalStatus: "suspended" } })}
                      disabled={update.isPending || selectedProfile.approvalStatus === "suspended" || (selectedProfile.isOwner && lastActiveOwner)}
                      id={selectedProfile.id}
                    />
                    {selectedProfile.isOwner && lastActiveOwner && <span className="text-xs text-muted-foreground">The last active owner cannot be set pending or suspended.</span>}
                  </div>
                )}
              </div>

              <CardContent className="space-y-8 p-5">
                {isAdmin && !selectedProfile.isOwner && selectedProfile.email && (
                  <section className="rounded-lg border border-red-200 bg-red-50 p-4" aria-label="Remove staff account">
                    {deleteTargetId === selectedProfile.id ? (
                      <div className="space-y-3">
                        <p className="text-sm font-semibold text-red-950">Permanently delete this account?</p>
                        <p className="text-sm text-red-900">This removes the app sign-in, staff access, assignments, invitations, and staff-access audit history. This cannot be undone. A linked helpdesk assignee must be unlinked first.</p>
                        <label className="block text-sm font-medium text-red-950">
                          Type {selectedProfile.email} to confirm
                          <input
                            type="email"
                            autoComplete="off"
                            className="mt-1 block w-full rounded-md border border-red-300 bg-white px-3 py-2"
                            value={deleteConfirmation}
                            onChange={(event) => setDeleteConfirmation(event.target.value)}
                            data-testid="input-confirm-delete-account"
                          />
                        </label>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={deleteAccount.isPending || deleteConfirmation.trim().toLowerCase() !== selectedProfile.email.toLowerCase()}
                            onClick={() => deleteAccount.mutate({ id: selectedProfile.id, email: deleteConfirmation.trim() })}
                            data-testid="button-confirm-delete-account"
                          >
                            {deleteAccount.isPending ? "Deleting…" : "Permanently delete account"}
                          </Button>
                          <Button type="button" variant="outline" disabled={deleteAccount.isPending} onClick={() => setDeleteTargetId(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <Button type="button" variant="outline" className="text-red-800" onClick={() => setDeleteTargetId(selectedProfile.id)} data-testid="button-delete-account">
                        <Trash2 className="mr-2 h-4 w-4" /> Delete account permanently
                      </Button>
                    )}
                  </section>
                )}
                {conflict && (
                  <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-950" data-testid={`alert-conflict-${selectedProfile.id}`}>
                    <div className="flex items-center gap-2 font-medium">
                      <AlertTriangle className="h-4 w-4 text-orange-600" aria-hidden="true" />
                      Access changed while this page was open
                    </div>
                    <p className="mt-1 text-orange-800">
                      Your change was not applied. Review the current settings before trying again.
                    </p>
                    <ul className="mt-3 space-y-1">
                      {conflictChanges.length > 0 ? conflictChanges.map((change) => (
                        <li key={change.label}>
                          <span className="font-medium">{change.label}:</span>{" "}
                          <span className="text-muted-foreground line-through">{change.before}</span>
                          <span aria-hidden="true" className="mx-1.5 text-orange-400">→</span>
                          <span>{change.after}</span>
                        </li>
                      )) : (
                        <li className="text-orange-800">No role, approval, feature, or assignment values differed.</li>
                      )}
                    </ul>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <Button size="sm" variant="outline" disabled={reloadPending} onClick={() => reloadCurrentSettings(selectedProfile)} data-testid={`button-reload-${selectedProfile.id}`}>
                        Reload current settings
                      </Button>
                      {reloadPending && (
                        <>
                          <span className="text-xs text-orange-800">Reloading current settings…</span>
                          <Button size="sm" variant="ghost" onClick={() => cancelReload(selectedProfile)} data-testid={`button-cancel-reload-${selectedProfile.id}`}>
                            Cancel reload
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {!selectedProfile.isOwner && (
                  <section className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                    <SectionHeading
                      title="Helpdesk ticket assignee"
                      hint="A dispatch recipient uses this separate helpdesk identity when claiming a ticket. It does not grant login or change Staff Access permissions."
                    />
                    {selectedProfile.helpdeskAssigneeId ? (
                      <p className="text-sm text-emerald-800">
                        Assignee ready (#{selectedProfile.helpdeskAssigneeId}).{" "}
                        <Link href={`/staff?tab=dispatch&assigneeId=${selectedProfile.helpdeskAssigneeId}`} className="font-medium underline underline-offset-2" data-testid={`link-configure-dispatch-${selectedProfile.id}`}>Configure Dispatch</Link>
                      </p>
                    ) : selectedProfile.approvalStatus === "approved" && !selectedProfile.email?.trim() ? (
                      <div>
                        <p className="text-sm text-amber-900" data-testid={`text-helpdesk-email-required-${selectedProfile.id}`}>
                          This account is approved, but has no sign-in email on file.
                        </p>
                        <p className="mt-2 text-sm text-stone-600">
                          Staff enrollment is invitation-only. The recipient must accept an owner-issued invitation using the invited email account or Google account. An invitation does not automatically merge this legacy record with another account.
                        </p>
                        {isOwner ? (
                          <a href="#staff-invites-title" className="mt-3 inline-block text-sm font-medium underline underline-offset-2" data-testid="link-helpdesk-staff-invitation">Send a staff invitation</a>
                        ) : (
                          <p className="mt-2 text-sm text-stone-600">Ask an active owner to send the invitation.</p>
                        )}
                      </div>
                    ) : isAdmin && selectedProfile.approvalStatus === "approved" ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={createHelpdeskAssignee.isPending}
                        onClick={() => createHelpdeskAssignee.mutate(selectedProfile.id)}
                        data-testid={`button-link-helpdesk-${selectedProfile.id}`}
                      >
                        {createHelpdeskAssignee.isPending ? "Preparing assignee…" : "Create or link helpdesk assignee"}
                      </Button>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {selectedProfile.approvalStatus === "approved"
                          ? "Ask the owner to link this account to a helpdesk assignee."
                          : "Approve this account first, then link its helpdesk assignee."}
                      </p>
                    )}
                  </section>
                )}

                <section>
                  <SectionHeading
                    title="Staff name"
                    hint="This name identifies the person assigned to the role throughout Staff Access."
                  />
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <label className="space-y-1.5 text-sm">
                      <span className="font-medium">First name</span>
                      <input
                        type="text"
                        value={firstNameDraft}
                        maxLength={100}
                        onChange={(event) => {
                          const firstName = event.target.value;
                          setFirstNameDraft(firstName);
                          identityDrafts.current[selectedProfile.id] = {
                            firstName,
                            lastName: lastNameDraft,
                            dirty: firstName.trim() !== (selectedProfile.firstName ?? "")
                              || lastNameDraft.trim() !== (selectedProfile.lastName ?? ""),
                          };
                        }}
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-csd-red"
                        data-testid={`input-first-name-${selectedProfile.id}`}
                      />
                    </label>
                    <label className="space-y-1.5 text-sm">
                      <span className="font-medium">Last name</span>
                      <input
                        type="text"
                        value={lastNameDraft}
                        maxLength={100}
                        onChange={(event) => {
                          const lastName = event.target.value;
                          setLastNameDraft(lastName);
                          identityDrafts.current[selectedProfile.id] = {
                            firstName: firstNameDraft,
                            lastName,
                            dirty: firstNameDraft.trim() !== (selectedProfile.firstName ?? "")
                              || lastName.trim() !== (selectedProfile.lastName ?? ""),
                          };
                        }}
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-csd-red"
                        data-testid={`input-last-name-${selectedProfile.id}`}
                      />
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        updateIdentity.isPending
                        || !identityChanged
                        || (!firstNameDraft.trim() && !lastNameDraft.trim())
                      }
                      onClick={() => updateIdentity.mutate({
                        profile: selectedProfile,
                        firstName: firstNameDraft.trim(),
                        lastName: lastNameDraft.trim(),
                      })}
                      data-testid={`button-save-name-${selectedProfile.id}`}
                    >
                      {updateIdentity.isPending ? "Saving…" : "Save name"}
                    </Button>
                  </div>
                </section>

                <StaffContactEditor key={selectedProfile.id} userId={selectedProfile.id} onDirtyChange={setContactDirty} />

                <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
                  <div className="space-y-8">
                    <section>
                      <SectionHeading title="Role" hint="Changing the role resets features to that role's defaults." />
                      <select
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-csd-red disabled:opacity-50"
                        value={selectedProfile.role}
                        disabled={disabled}
                        onChange={(event) => {
                          const role = event.target.value as EditableRole;
                          update.mutate({
                            profile: selectedProfile,
                            patch: { role, features: roleDefaults.data?.[role] ?? selectedProfile.features },
                          });
                        }}
                        data-testid={`select-role-${selectedProfile.id}`}
                      >
                        {(Object.keys(ROLE_LABELS) as EditableRole[]).map((role) => (
                          <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                        ))}
                        {selectedProfile.isOwner && <option value="owner">Owner</option>}
                      </select>
                    </section>

                    <section>
                      <SectionHeading
                        title="Features"
                        hint="Sensitive features expose financial, compliance, or configuration data."
                        aside={
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {selectedProfile.approvalStatus === "approved"
                              ? `${Object.values(selectedProfile.effectiveFeatures).filter(Boolean).length} active`
                              : `${Object.values(selectedProfile.features).filter(Boolean).length} configured`}
                          </span>
                        }
                      />
                      <div className="divide-y rounded-lg border">
                        {FEATURE_OPTIONS.map((feature) => (
                          <label key={feature.key} className="flex cursor-pointer items-center justify-between gap-4 px-3 py-2.5" data-testid={`feature-toggle-${selectedProfile.id}-${feature.key}`}>
                            <span className={cn("text-sm", disabled && "opacity-50")}>
                              {feature.label}
                              {feature.sensitive && <span className="ml-2 text-xs text-muted-foreground">Sensitive</span>}
                              {feature.hint && <span className="mt-0.5 block max-w-xl text-xs font-normal text-muted-foreground">{feature.hint}</span>}
                            </span>
                            <Switch
                              checked={selectedProfile.features[feature.key]}
                              disabled={disabled}
                              onCheckedChange={(checked) =>
                                update.mutate({ profile: selectedProfile, patch: { features: { ...selectedProfile.features, [feature.key]: checked } } })
                              }
                              className="data-[state=checked]:bg-csd-red"
                            />
                          </label>
                        ))}
                        <label className="flex cursor-pointer items-center justify-between gap-4 px-3 py-2.5" data-testid={`feature-toggle-${selectedProfile.id}-voicemails`}>
                          <span className={cn("flex items-center gap-2 text-sm", disabled && "opacity-50")}>
                            <Voicemail className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> View voicemails
                          </span>
                          <Switch
                            checked={selectedProfile.capabilities.viewVoicemails}
                            disabled={disabled}
                            onCheckedChange={(checked) =>
                              update.mutate({ profile: selectedProfile, patch: { capabilities: { ...selectedProfile.capabilities, viewVoicemails: checked } } })
                            }
                            className="data-[state=checked]:bg-csd-red"
                          />
                        </label>
                        <div className="bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Communications tools
                          {!selectedProfile.features.communications && (
                            <span className="ml-2 font-normal normal-case tracking-normal">
                              (turn on Communications above for these to apply)
                            </span>
                          )}
                        </div>
                        {COMMUNICATION_TOOL_OPTIONS.map((tool) => (
                          <label key={tool.key} className="flex cursor-pointer items-center justify-between gap-4 px-3 py-2.5" data-testid={`feature-toggle-${selectedProfile.id}-${tool.key}`}>
                            <span className={cn("text-sm", (disabled || !selectedProfile.features.communications) && "opacity-50")}>
                              {tool.label}
                              <span className="mt-0.5 block max-w-xl text-xs font-normal text-muted-foreground">{tool.hint}</span>
                            </span>
                            <Switch
                              checked={selectedProfile.capabilities[tool.key] === true}
                              disabled={disabled}
                              aria-label={`${tool.label} access`}
                              onCheckedChange={(checked) =>
                                update.mutate({ profile: selectedProfile, patch: { capabilities: { ...selectedProfile.capabilities, [tool.key]: checked } } })
                              }
                              className="data-[state=checked]:bg-csd-red"
                            />
                          </label>
                        ))}
                      </div>
                    </section>
                  </div>

                  {selectedProfile.isOwner ? (
                    <section className="flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
                      <ShieldCheck className="mb-3 h-6 w-6 text-muted-foreground" aria-hidden="true" />
                      <p className="text-sm font-medium">Owner access cannot be restricted</p>
                      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                        The owner has full access to every feature, customer, job, and contact.
                      </p>
                    </section>
                  ) : (
                    <section>
                      <SectionHeading
                        title="Assignments"
                        hint="Limit this account to specific customers, jobs, and contacts. Administrators are never limited."
                      />
                      {selectedProfile.approvalStatus !== "approved" && (
                        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                          You can save assignments now, but this employee cannot use them until their staff account is approved.
                        </p>
                      )}
                      <div className="space-y-4">
                        <AssignmentList
                          title="Customers"
                          count={clients.data?.length ?? 0}
                          emptyText="No customers available."
                          isLoading={clients.isLoading}
                          error={clients.isError && !clients.data?.length ? "Customers could not be loaded." : undefined}
                          onRetry={() => { void clients.refetch(); }}
                        >
                          {clients.data?.map((client) => (
                            <label key={client.id} className={assignmentRowClass} data-testid={`assignment-client-${selectedProfile.id}-${client.id}`}>
                              <input
                                type="checkbox"
                                className={checkboxClass}
                                checked={selectedProfile.assignments.clientIds.includes(client.id)}
                                disabled={disabled}
                                onChange={(event) => updateAssignments.mutate({ profile: selectedProfile, assignments: {
                                  ...selectedProfile.assignments,
                                  clientIds: event.target.checked
                                    ? [...selectedProfile.assignments.clientIds, client.id]
                                    : selectedProfile.assignments.clientIds.filter((id) => id !== client.id),
                                } })}
                              />
                              <span className={cn(disabled && "opacity-50")}>{client.name}</span>
                            </label>
                          ))}
                        </AssignmentList>

                        <AssignmentList
                          title="Jobs"
                          count={jobs.data?.length ?? 0}
                          emptyText="No jobs available."
                          isLoading={jobs.isLoading}
                          error={jobs.isError && !jobs.data?.length ? "Jobs could not be loaded." : undefined}
                          onRetry={() => { void jobs.refetch(); }}
                        >
                          {jobs.data?.map((job) => (
                            <label key={job.id} className={assignmentRowClass} data-testid={`assignment-job-${selectedProfile.id}-${job.id}`}>
                              <input
                                type="checkbox"
                                className={checkboxClass}
                                checked={selectedProfile.assignments.jobIds.includes(job.id)}
                                disabled={disabled}
                                onChange={(event) => updateAssignments.mutate({ profile: selectedProfile, assignments: {
                                  ...selectedProfile.assignments,
                                  jobIds: event.target.checked
                                    ? [...selectedProfile.assignments.jobIds, job.id]
                                    : selectedProfile.assignments.jobIds.filter((id) => id !== job.id),
                                } })}
                              />
                              <span className={cn("min-w-0", disabled && "opacity-50")}>
                                {job.jobNumber}
                                {job.clientName && <span className="ml-2 text-xs text-muted-foreground">{job.clientName}</span>}
                              </span>
                            </label>
                          ))}
                        </AssignmentList>

                        <AssignmentList
                          title="Contacts"
                          count={contacts.data?.length ?? 0}
                          emptyText="No contacts available."
                          isLoading={contacts.isLoading}
                          error={contacts.isError && !contacts.data?.length ? "Contacts could not be loaded." : undefined}
                          onRetry={() => { void contacts.refetch(); }}
                        >
                          {contacts.data?.map((contact) => {
                            const assignment = selectedProfile.assignments.contactAssignments.find((item) => item.contactId === contact.id);
                            const replaceContact = (next: { contactId: number; canEdit: boolean } | null) => {
                              const remaining = selectedProfile.assignments.contactAssignments.filter((item) => item.contactId !== contact.id);
                              updateAssignments.mutate({
                                profile: selectedProfile,
                                assignments: { ...selectedProfile.assignments, contactAssignments: next ? [...remaining, next] : remaining },
                              });
                            };
                            return (
                              <div key={contact.id} className={cn(assignmentRowClass, "items-center justify-between")} data-testid={`assignment-contact-row-${selectedProfile.id}-${contact.id}`}>
                                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                                  <input
                                    type="checkbox"
                                    className={checkboxClass}
                                    checked={Boolean(assignment)}
                                    disabled={disabled}
                                    onChange={(event) => replaceContact(event.target.checked ? { contactId: contact.id, canEdit: false } : null)}
                                  />
                                  <span className={cn("min-w-0", disabled && "opacity-50")}>
                                    <span className="block truncate">{contact.fullName}</span>
                                    {contact.email && <span className="block truncate text-xs text-muted-foreground">{contact.email}</span>}
                                  </span>
                                </label>
                                {assignment && (
                                  <label className={cn("flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground", disabled && "opacity-50")}>
                                    Can edit
                                    <Switch
                                      checked={assignment.canEdit}
                                      disabled={disabled}
                                      onCheckedChange={(checked) => replaceContact({ contactId: contact.id, canEdit: checked })}
                                      className="scale-90 data-[state=checked]:bg-csd-red"
                                      data-testid={`assignment-contact-edit-${selectedProfile.id}-${contact.id}`}
                                    />
                                  </label>
                                )}
                              </div>
                            );
                          })}
                        </AssignmentList>
                      </div>
                    </section>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : selectedClerkUserId && selectedDirectoryAccountQuery.isLoading ? (
            <Card className="min-h-48 shadow-none" data-testid="loading-selected-clerk-account">
              <CardContent className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">Refreshing sign-in account details…</CardContent>
            </Card>
          ) : selectedClerkUserId && selectedDirectoryAccountQuery.isError ? (
            <Card className="shadow-none" data-testid="error-selected-clerk-account">
              <CardContent className="space-y-3 p-5">
                <p className="text-sm text-red-800" role="alert">Sign-in account details could not be refreshed. The invitation action is unavailable until the account can be verified.</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void selectedDirectoryAccountQuery.refetch()} data-testid="button-retry-selected-clerk-account">Try again</Button>
              </CardContent>
            </Card>
          ) : selectedClerkUserId && !selectedDirectoryAccount ? (
            <Card className="shadow-none" data-testid="notice-selected-clerk-account-missing">
              <CardContent className="p-5">
                <h2 className="font-semibold">Sign-in account no longer found</h2>
                <p className="mt-1 text-sm text-muted-foreground">This account is no longer present in the owner sign-in directory. Its previous details and invitation action are no longer available.</p>
              </CardContent>
            </Card>
          ) : selectedDirectoryAccount && selectedDirectoryAccount.staffUserId && !selectedLinkedProfile ? (
            <Card className="shadow-none" data-testid="notice-linked-staff-profile-loading">
              <CardContent className="p-5">
                <h2 className="font-semibold">Staff profile found</h2>
                <p className="mt-1 text-sm text-muted-foreground">Refreshing the staff roster to load its current access controls…</p>
              </CardContent>
            </Card>
          ) : selectedDirectoryAccount ? (
            <Card key={selectedDirectoryAccount.clerkUserId} className="min-w-0 shadow-none" data-testid={`card-clerk-account-${selectedDirectoryAccount.clerkUserId}`}>
              <div className="border-b p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="break-words text-lg font-semibold" data-testid="text-selected-clerk-account-name">{accountLabel(selectedDirectoryAccount)}</h2>
                  <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900 shadow-none" data-testid="badge-clerk-enrollment-status">
                    {selectedDirectoryAccount.invitationStatus === "pending"
                      ? "Invitation pending"
                      : selectedDirectoryAccount.invitationStatus === "accepted"
                        ? "Invitation accepted · not enrolled"
                        : "Not enrolled"}
                  </Badge>
                </div>
                {selectedDirectoryAccount.email && accountLabel(selectedDirectoryAccount) !== selectedDirectoryAccount.email && (
                  <p className="mt-1 break-all text-sm text-muted-foreground">{selectedDirectoryAccount.email}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge className={selectedDirectoryAccount.emailVerified ? "border-emerald-200 bg-emerald-50 text-emerald-800 shadow-none hover:bg-emerald-50" : "border-amber-200 bg-amber-50 text-amber-900 shadow-none hover:bg-amber-50"} data-testid={`status-email-verification-${selectedDirectoryAccount.clerkUserId}`}>
                    {selectedDirectoryAccount.emailVerified ? "Email verified" : "Email unverified"}
                  </Badge>
                  <Badge variant="outline" className="font-normal" data-testid={`status-invitation-${selectedDirectoryAccount.clerkUserId}`}>
                    {selectedDirectoryAccount.invitationStatus ? `Invite ${selectedDirectoryAccount.invitationStatus}` : "No invitation"}
                  </Badge>
                </div>
                <Button type="button" size="sm" variant="ghost" className="mt-2 px-0" disabled={selectedDirectoryAccountQuery.isFetching} onClick={() => void selectedDirectoryAccountQuery.refetch()} data-testid="button-refresh-selected-clerk-account">
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{selectedDirectoryAccountQuery.isFetching ? "Refreshing…" : "Refresh account status"}
                </Button>
              </div>
              <CardContent className="p-5">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" data-testid="notice-clerk-account-no-access">
                  This sign-in account is not enrolled in staff access and has no app permissions. Selecting it does not create a staff profile or link identities. Access requires an invitation accepted with the verified email, complete first and last names, and explicit owner approval.
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="flex min-h-[320px] flex-col items-center justify-center border-dashed p-12 text-center shadow-none" data-testid="panel-no-staff-selection">
              <UsersRound className="mb-3 h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="font-medium">Select a person to review staff access</p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {isOwner
                  ? "Search this roster for staff profiles and existing sign-in accounts. Accounts without a staff profile have no app access."
                  : "Choose a staff profile from the roster to review its current access."}
              </p>
            </Card>
          )}
          {isOwner && (
            <div className={cn("min-w-0", !canManageInvitations && "hidden")} aria-hidden={!canManageInvitations}>
              <StaffInviteManager
                useAccess={useAccess}
                showDirectory={false}
                initialEmail={selectedDirectoryAccount?.email}
                targetLabel={selectedDirectoryAccount ? accountLabel(selectedDirectoryAccount) : undefined}
              />
            </div>
          )}
          </div>
        </div>
      )}

      <Card className="shadow-none" data-testid="card-audit-history">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Access history
          </CardTitle>
          <CardDescription>Recent access changes and conflict-recovery outcomes.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {auditViewState === "loading" && (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading access history…</p>
          )}
          {auditViewState === "error" && (
            <div className="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-800">
              Access history could not be loaded. Please refresh the page.
            </div>
          )}
          {auditViewState === "empty" && (
            <p className="py-10 text-center text-sm text-muted-foreground">No access changes recorded yet.</p>
          )}
          {auditViewState === "populated" && (
            <>
              <ol className="divide-y">
                {visibleAudit.map((entry) => {
                  const recovery = isRecoveryAuditAction(entry.action);
                  return (
                    <li key={entry.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6" data-testid={`audit-entry-${entry.id}`}>
                      <div className="min-w-0 text-sm">
                        <p>
                          <span className="font-medium">{entry.targetEmail || "Unknown staff member"}</span>
                          <span className="text-muted-foreground"> · by {entry.actorEmail || "System"}</span>
                          {recovery && (
                            <Badge variant={entry.action === "conflict_recovery_failed" ? "destructive" : "secondary"} className="ml-2 align-middle shadow-none">
                              {entry.action === "conflict_recovery_failed" ? "Recovery failed" : "Recovery succeeded"}
                            </Badge>
                          )}
                        </p>
                        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          {describeAuditChange(entry).map((change, idx) => (
                            <li key={idx}>{change}</li>
                          ))}
                        </ul>
                      </div>
                      <time className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </time>
                    </li>
                  );
                })}
              </ol>
              {auditEntries.length > AUDIT_PREVIEW_COUNT && (
                <div className="border-t px-5 py-3">
                  <Button variant="ghost" size="sm" onClick={() => setShowAllAudit((value) => !value)} data-testid="button-toggle-audit">
                    {showAllAudit ? "Show fewer" : `Show all ${auditEntries.length} entries`}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
