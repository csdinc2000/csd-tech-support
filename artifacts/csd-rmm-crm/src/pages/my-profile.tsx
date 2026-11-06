import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { Briefcase, Building2, Camera, ImagePlus, Loader2, Mail, Phone, ShieldCheck, Trash2, UserCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent, PageShell } from "@/components/layout/page-shell";
import { ShareCardPanel } from "@/components/business-card/share-card-panel";
import { useToast } from "@/hooks/use-toast";
import { MY_STAFF_PROFILE_KEY, useMyStaffProfile } from "@/hooks/use-my-staff-profile";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { compressPhoto } from "@/lib/marketplace";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  administrator: "Administrator",
  field_technician: "Field Technician",
  software_developer: "Software Developer",
  accounting: "Accounting",
  it_manager: "IT Manager",
  legal_team: "Legal Team",
  secretary: "Secretary",
};

function initialsOf(first: string | null | undefined, last: string | null | undefined, email: string | null | undefined) {
  const value = `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase();
  return value || (email?.[0] ?? "?").toUpperCase();
}

export default function MyProfilePage() {
  const { toast } = useToast();
  const { user } = useUser();
  const { data: profile, isLoading, isError } = useMyStaffProfile();
  const [processing, setProcessing] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: MY_STAFF_PROFILE_KEY }),
    queryClient.invalidateQueries({ queryKey: ["/api/staff-profile/me/card"] }),
  ]);

  const upload = useMutation({
    mutationFn: async (dataBase64: string) => apiRequest("PUT", "/api/staff-profile/me/avatar", { dataBase64 }),
    onSuccess: async () => {
      await refresh();
      toast({ title: "Profile picture updated" });
    },
    onError: (error: Error) => toast({ title: "Could not save photo", description: error.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", "/api/staff-profile/me/avatar"),
    onSuccess: async () => {
      await refresh();
      toast({ title: "Profile picture removed" });
    },
    onError: (error: Error) => toast({ title: "Could not remove photo", description: error.message, variant: "destructive" }),
  });

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setProcessing(true);
    try {
      const photo = await compressPhoto(file);
      upload.mutate(photo.dataBase64);
    } catch (e) {
      toast({ title: "Could not read photo", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setProcessing(false);
      if (cameraInput.current) cameraInput.current.value = "";
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const busy = processing || upload.isPending || remove.isPending;
  const firstName = profile?.firstName ?? user?.firstName ?? null;
  const lastName = profile?.lastName ?? user?.lastName ?? null;
  const email = profile?.email ?? user?.primaryEmailAddress?.emailAddress ?? null;
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || email || "Your profile";
  const avatar = profile?.avatar ?? null;

  const details: Array<{ icon: typeof Mail; label: string; value: string | null | undefined }> = [
    { icon: ShieldCheck, label: "Role", value: profile ? ROLE_LABEL[profile.role] ?? profile.role : null },
    { icon: Briefcase, label: "Job title", value: profile?.jobTitle },
    { icon: Building2, label: "Department", value: profile?.department },
    { icon: Mail, label: "Email", value: email },
    { icon: Phone, label: "Phone", value: profile?.phone },
  ];

  return (
    <PageShell>
      <PageHeader
        title="My Profile"
        description="Your technician profile, profile picture and digital business card."
        icon={UserCircle}
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "My Profile" }]}
      />
      <PageContent>
        <div className="grid gap-6 md:grid-cols-[320px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Profile picture</CardTitle>
              <CardDescription>Shown to your team next to your name.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-4">
              <div
                className="flex h-40 w-40 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-gradient-to-br from-csd-red to-red-700 shadow-md ring-1 ring-gray-200"
                data-testid="staff-profile-avatar"
              >
                {isLoading ? (
                  <Loader2 className="h-8 w-8 animate-spin text-white" />
                ) : avatar ? (
                  <img src={avatar.url} alt={fullName} className="h-full w-full object-cover" data-testid="img-staff-avatar" />
                ) : (
                  <span className="text-4xl font-semibold text-white">{initialsOf(firstName, lastName, email)}</span>
                )}
              </div>
              <div className="grid w-full grid-cols-2 gap-2">
                <Button onClick={() => cameraInput.current?.click()} disabled={busy || isError} data-testid="button-staff-avatar-camera">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
                  Take photo
                </Button>
                <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy || isError} data-testid="button-staff-avatar-upload">
                  <ImagePlus className="mr-2 h-4 w-4" />
                  Upload
                </Button>
              </div>
              {avatar && (
                <Button variant="ghost" className="w-full text-destructive" onClick={() => remove.mutate()} disabled={busy} data-testid="button-staff-avatar-remove">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove photo
                </Button>
              )}
              {/* `capture="user"` opens the front (selfie) camera on phones; desktop browsers fall back to a file picker. */}
              <input ref={cameraInput} type="file" accept="image/*" capture="user" hidden onChange={(e) => pick(e.target.files)} data-testid="input-staff-avatar-camera" />
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files)} data-testid="input-staff-avatar-file" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle data-testid="text-staff-profile-name">{fullName}</CardTitle>
              <CardDescription>
                Contact details are managed by an administrator under Staff. Ask them if something is out of date.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isError ? (
                <p className="text-sm text-destructive">Could not load your profile. Try refreshing the page.</p>
              ) : (
                <dl className="divide-y divide-gray-100">
                  {details.map(({ icon: Icon, label, value }) => (
                    <div key={label} className="flex items-center gap-3 py-3">
                      <Icon className="h-4 w-4 shrink-0 text-gray-400" />
                      <dt className="w-28 shrink-0 text-sm text-gray-500">{label}</dt>
                      <dd className="min-w-0 truncate text-sm font-medium text-gray-900">{value || <span className="font-normal text-gray-400">Not set</span>}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="mt-6">
          <ShareCardPanel />
        </div>
      </PageContent>
    </PageShell>
  );
}
