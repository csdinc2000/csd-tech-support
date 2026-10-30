import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Camera, ImagePlus, Loader2, Monitor, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { compressPhoto } from "@/lib/marketplace";

export interface CustomerAvatarInfo {
  url: string;
  source: "intake" | "staff";
  updatedAt: string;
}

interface CustomerAvatarProps {
  clientId: number;
  name: string;
  avatar: CustomerAvatarInfo | null | undefined;
}

// Profile picture for a customer account: the photo of their device taken on
// the intake form, or a placeholder a technician can replace with the camera.
export function CustomerAvatar({ clientId, name, avatar }: CustomerAvatarProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/overview`] });

  const upload = useMutation({
    mutationFn: async (dataBase64: string) => apiRequest("PUT", `/api/clients/${clientId}/avatar`, { dataBase64 }),
    onSuccess: async () => {
      await refresh();
      setOpen(false);
      toast({ title: "Photo saved", description: `Updated the profile photo for ${name}.` });
    },
    onError: (error: Error) => toast({ title: "Could not save photo", description: error.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/clients/${clientId}/avatar`),
    onSuccess: async () => {
      await refresh();
      setOpen(false);
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

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-blue-200 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        aria-label={avatar ? "View or change customer photo" : "Add customer photo"}
        data-testid="button-customer-avatar"
      >
        {avatar ? (
          <>
            <img src={avatar.url} alt={`${name}'s device`} className="h-full w-full object-cover" data-testid="img-customer-avatar" />
            <span className="absolute bottom-0.5 right-0.5 rounded-full bg-white/90 p-1 text-gray-700 shadow">
              <Camera className="h-3 w-3" />
            </span>
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 bg-blue-50 text-blue-600" data-testid="placeholder-customer-avatar">
            <Monitor className="h-6 w-6" />
            <span className="text-[10px] font-medium leading-tight">Add photo</span>
          </div>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Customer photo</DialogTitle>
            <DialogDescription>
              {avatar
                ? avatar.source === "intake"
                  ? "Submitted by the customer on the intake form."
                  : "Taken by a technician."
                : "No photo yet. Take a picture of the front of the customer's device."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border bg-gray-50">
            {avatar ? (
              <img src={avatar.url} alt={`${name}'s device`} className="h-full w-full object-contain" />
            ) : (
              <Monitor className="h-20 w-20 text-gray-300" />
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => cameraInput.current?.click()} disabled={busy} data-testid="button-avatar-camera">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
              {avatar ? "Retake photo" : "Take photo"}
            </Button>
            <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy} data-testid="button-avatar-upload">
              <ImagePlus className="mr-2 h-4 w-4" />
              Upload
            </Button>
          </div>
          {avatar && (
            <Button variant="ghost" className="text-destructive" onClick={() => remove.mutate()} disabled={busy} data-testid="button-avatar-remove">
              <Trash2 className="mr-2 h-4 w-4" />
              Remove photo
            </Button>
          )}
          {/* `capture` opens the rear camera straight away on phones and tablets; desktop browsers fall back to a file picker. */}
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files)} data-testid="input-avatar-camera" />
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files)} data-testid="input-avatar-file" />
        </DialogContent>
      </Dialog>
    </>
  );
}
