import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type DispatchRecipient = {
  id: number;
  name: string;
  role: "staff" | "technician";
  phone: string;
  enabled: boolean;
  onDuty: boolean;
  receiveCalls: boolean;
  receiveMessages: boolean;
  canUseCommands: boolean;
  linkedUserId: number | null;
  staffAccessApproved?: boolean;
  updatedAt: string;
};

export type EligibleAssignee = {
  id: number;
  name: string;
  email?: string | null;
  staffRole?: string | null;
  approvalStatus?: "approved" | "pending" | "suspended" | null;
};

export type DispatchSettings = {
  recipients: DispatchRecipient[];
  routing: { activeCallRecipients: number[]; activeMessageRecipients: number[] };
};

export type DispatchAuditEntry = {
  id?: number;
  action?: string;
  message?: string;
  actorName?: string;
  actorIdentity?: string;
  outcome?: string;
  createdAt?: string;
  timestamp?: string;
  [key: string]: unknown;
};

const settingsKey = ["/api/staff-dispatch/settings"];
const auditKey = ["/api/staff-dispatch/audit"];

export function useStaffDispatch() {
  const client = useQueryClient();
  const freshnessOptions = {
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnMount: "always",
  } as const;
  const settings = useQuery<DispatchSettings>({ queryKey: settingsKey, ...freshnessOptions });
  const audit = useQuery<DispatchAuditEntry[]>({ queryKey: auditKey, ...freshnessOptions });
  const eligibleAssignees = useQuery<EligibleAssignee[]>({ queryKey: ["/api/staff-dispatch/eligible-assignees"], ...freshnessOptions });
  const refresh = () => {
    client.invalidateQueries({ queryKey: settingsKey });
    client.invalidateQueries({ queryKey: auditKey });
  };
  const create = useMutation({
    mutationFn: (data: Omit<DispatchRecipient, "id" | "updatedAt">) => apiRequest("POST", "/api/staff-dispatch/settings", data),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<DispatchRecipient> }) => apiRequest("PATCH", `/api/staff-dispatch/settings/${id}`, data),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/staff-dispatch/settings/${id}`),
    onSuccess: refresh,
  });
  return { settings, audit, eligibleAssignees, create, update, remove };
}