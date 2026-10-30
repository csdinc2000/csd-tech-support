import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";

export type StaffRole =
  | "owner" | "administrator" | "field_technician" | "software_developer"
  | "accounting" | "it_manager" | "legal_team" | "secretary";
export type ApprovalStatus = "pending" | "approved" | "suspended";
export type StaffFeature =
  | "dashboard" | "crm" | "communications" | "scheduling" | "operations"
  | "helpdesk" | "invoices" | "reports" | "automation" | "compliance"
  | "helpdeskAdmin" | "dispatchAdmin" | "staffAdmin" | "billing" | "marketplace";
export type AccessProfile = {
  isAdmin: boolean;
  role: StaffRole;
  approvalStatus: ApprovalStatus;
  features: Record<StaffFeature, boolean>;
  capabilities: { viewVoicemails: boolean };
};

/** Local authorization is evaluated by the server against verified Clerk claims. */
export function useAdminAccess() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const query = useQuery<AccessProfile>({
    queryKey: ["/api/auth/access"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: isLoaded && isSignedIn && Boolean(userId),
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
  return {
    isAdmin: query.data?.isAdmin === true,
    role: query.data?.role,
    approvalStatus: query.data?.approvalStatus,
    features: query.data?.features,
    can: (feature: StaffFeature) => query.data?.features?.[feature] === true,
    capabilities: query.data?.capabilities ?? { viewVoicemails: false },
    isLoading: !isLoaded || query.isLoading,
  };
}