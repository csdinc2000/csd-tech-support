import { useState } from "react";
import { PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";

export function CallViaCsdButton({
  phone,
  contactId,
  label,
  size = "sm",
}: {
  phone: string;
  contactId?: number;
  label?: string;
  size?: "sm" | "default";
}) {
  const { can, isLoading } = useAdminAccess();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  if (isLoading || !can("communications") || !phone.trim()) return null;

  async function startCall() {
    setPending(true);
    try {
      await apiRequest("POST", "/api/twilio/calls/outbound", {
        to: phone,
        ...(contactId != null ? { contactId } : {}),
      });
      toast({
        title: "Call started",
        description: "Your configured phone will ring first. Answer it and press 1 to connect to the customer.",
      });
    } catch (error) {
      const message = error instanceof ApiRequestError && typeof error.payload === "object" && error.payload && "error" in error.payload
        ? String(error.payload.error)
        : error instanceof Error
          ? error.message.replace(/^\d+:\s*/, "")
          : "Could not start the call.";
      toast({ title: "Call not started", description: message, variant: "destructive" });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      onClick={startCall}
      disabled={pending}
      aria-label={`Call ${label || phone} from the CSD business line`}
      data-testid={contactId != null ? `call-contact-${contactId}` : "call-via-csd"}
    >
      <PhoneCall className="mr-1.5 h-4 w-4" />
      {pending ? "Calling…" : label || "Call"}
    </Button>
  );
}
