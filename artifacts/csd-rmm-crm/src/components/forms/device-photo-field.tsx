import { useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compressPhoto, type PendingPhoto } from "@/lib/marketplace";

interface DevicePhotoFieldProps {
  value: PendingPhoto | null;
  onChange: (photo: PendingPhoto | null) => void;
  disabled?: boolean;
}

// One photo of the front of the customer's device. It becomes the customer's
// profile picture so technicians can match the machine at drop-off.
export function DevicePhotoField({ value, onChange, disabled }: DevicePhotoFieldProps) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      onChange(await compressPhoto(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That photo could not be read");
    } finally {
      setProcessing(false);
      if (cameraInput.current) cameraInput.current.value = "";
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const busy = disabled || processing;

  return (
    <div className="space-y-2" data-testid="field-device-photo">
      <div>
        <p className="text-sm font-medium leading-none">Photo of your device</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Take one picture of the front of your computer, laptop or device so our technicians can recognize it.
        </p>
      </div>
      {value ? (
        <div className="flex items-center gap-4">
          <img
            src={value.previewUrl}
            alt="Front of your device"
            className="h-28 w-28 rounded-lg border object-cover"
            data-testid="img-device-photo-preview"
          />
          <div className="flex flex-col gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => cameraInput.current?.click()} data-testid="button-retake-device-photo">
              <Camera className="mr-2 h-4 w-4" />
              Retake
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onChange(null)} data-testid="button-remove-device-photo">
              <X className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Button type="button" variant="outline" className="h-20 flex-col gap-1" disabled={busy} onClick={() => cameraInput.current?.click()} data-testid="button-take-device-photo">
            {processing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
            {processing ? "Preparing…" : "Take a photo"}
          </Button>
          <Button type="button" variant="outline" className="h-20 flex-col gap-1" disabled={busy} onClick={() => fileInput.current?.click()} data-testid="button-upload-device-photo">
            <ImagePlus className="h-5 w-5" />
            Upload a photo
          </Button>
        </div>
      )}
      {error && <p className="text-sm font-medium text-destructive">{error}</p>}
      {/* `capture` opens the rear camera straight away on phones and tablets; desktop browsers fall back to a file picker. */}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files)} data-testid="input-device-photo-camera" />
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files)} data-testid="input-device-photo-file" />
    </div>
  );
}
