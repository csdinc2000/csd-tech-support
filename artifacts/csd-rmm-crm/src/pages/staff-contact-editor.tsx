import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { StaffContactProfile, StaffContactUpdate } from "@workspace/api-client-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";

export function StaffContactEditor({ userId, onDirtyChange }: { userId: string; onDirtyChange: (dirty: boolean) => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<StaffContactUpdate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState(false);
  useUnsavedChangesGuard(dirty, "Discard unsaved staff contact information?");
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const path = `/api/staff-access/${encodeURIComponent(userId)}/profile`;
  const profile = useQuery<StaffContactProfile>({
    queryKey: ["/api/staff-access", userId, "profile"],
    queryFn: async () => (await apiRequest("GET", path)).json(),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!profile.data || dirty) return;
    setDraft({
      phone: profile.data.phone ?? "",
      jobTitle: profile.data.jobTitle ?? "",
      department: profile.data.department ?? "",
      ...(profile.data.email ? { email: profile.data.email } : {}),
      expectedEmail: profile.data.email,
      expectedUpdatedAt: profile.data.updatedAt,
    });
    setConfirmEmail(false);
  }, [profile.data, dirty]);

  const save = useMutation({
    mutationFn: async (input: StaffContactUpdate) => {
      const response = await apiRequest("PATCH", path, input);
      return response.json();
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/audit"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/calendar/meeting-staff"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] }),
      ]);
      setDirty(false);
      toast({ title: "Staff contact information saved" });
    },
    onError: (error: Error) => toast({
      title: "Staff information was not confirmed",
      description: error.message,
      variant: "destructive",
    }),
  });
  const edit = (field: "phone" | "email" | "jobTitle" | "department", value: string) => {
    setDraft((current) => current ? { ...current, [field]: value } : current);
    setDirty(true);
    if (field === "email") setConfirmEmail(false);
  };
  const emailChanged = Boolean(draft?.email && draft.email !== draft.expectedEmail);

  return (
    <section className="space-y-4 border-b pb-6" data-testid="staff-contact-editor">
      <div>
        <h3 className="font-semibold">Contact & employment information</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Update staff contact details without changing their role, approval, or assignments.
        </p>
      </div>
      {profile.isLoading && <p className="text-sm text-muted-foreground">Loading staff information…</p>}
      {profile.isError && (
        <div role="alert" className="text-sm text-red-700">
          Could not load staff contact information.
          <Button type="button" variant="link" onClick={() => void profile.refetch()}>Retry</Button>
        </div>
      )}
      {profile.data && draft && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-medium sm:col-span-2">
              Sign-in / meeting email
              <select
                aria-label="Sign-in / meeting email"
                data-testid="staff-profile-email"
                value={draft.email ?? ""}
                disabled={!profile.data.emailChangeAvailable || save.isPending}
                onChange={(event) => edit("email", event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"
              >
                {!profile.data.verifiedEmails.includes(draft.expectedEmail ?? "") && (
                  <option value={draft.expectedEmail ?? ""}>{draft.expectedEmail || "No email listed"}</option>
                )}
                {profile.data.verifiedEmails.map((email) => <option key={email} value={email}>{email}</option>)}
              </select>
              <span className="block text-xs font-normal text-muted-foreground">{profile.data.emailMessage}</span>
            </label>
            <label className="space-y-2 text-sm font-medium">
              Contact phone
              <Input type="tel" value={draft.phone} maxLength={64} disabled={save.isPending}
                onChange={(event) => edit("phone", event.target.value)} data-testid="staff-profile-phone" />
            </label>
            <label className="space-y-2 text-sm font-medium">
              Job title
              <Input value={draft.jobTitle} maxLength={100} disabled={save.isPending}
                onChange={(event) => edit("jobTitle", event.target.value)} data-testid="staff-profile-job-title" />
            </label>
            <label className="space-y-2 text-sm font-medium sm:col-span-2">
              Department
              <Input value={draft.department} maxLength={100} disabled={save.isPending}
                onChange={(event) => edit("department", event.target.value)} data-testid="staff-profile-department" />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Contact phone edits do not change call forwarding. Manage call routing separately in Dispatch.
          </p>
          {emailChanged && (
            <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <input type="checkbox" className="mt-1" checked={confirmEmail}
                onChange={(event) => setConfirmEmail(event.target.checked)} />
              I understand this changes this account’s primary sign-in email and future meeting invitation address.
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" data-testid="staff-profile-save"
              disabled={!dirty || save.isPending || (emailChanged && !confirmEmail)}
              onClick={() => save.mutate(draft)}>
              {save.isPending ? "Saving…" : "Save contact information"}
            </Button>
            <Button type="button" variant="outline" disabled={save.isPending || profile.isFetching}
              onClick={async () => { await profile.refetch(); setDirty(false); }}>
              {dirty ? "Discard changes & reload" : "Refresh verified addresses"}
            </Button>
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          </div>
        </>
      )}
    </section>
  );
}
