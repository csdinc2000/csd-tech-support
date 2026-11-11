import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import type { CrmLead } from "@shared/schema";
import { useAdminAccess } from "@/hooks/use-admin-access";

// Per signed-in user, so on a shared shop PC one person seeing a lead doesn't
// silence it for the next person.
const storageKey = (userId: string) => `newLeadNotifier:lastSeenId:${userId}`;
// Toasts only matter in a visible tab; on refocus the query refetches and any
// leads that arrived meanwhile are announced together.
const POLL_INTERVAL_MS = 30_000;

function readLastSeenId(userId: string) {
  try {
    const value = Number(window.localStorage.getItem(storageKey(userId)) || "0");
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    console.warn("New lead notifier could not read browser storage:", error);
    return 0;
  }
}

function writeLastSeenId(userId: string, id: number) {
  try {
    window.localStorage.setItem(storageKey(userId), String(id));
  } catch (error) {
    console.warn("New lead notifier could not update browser storage:", error);
  }
}

function formatService(s?: string | null) {
  if (!s) return "Service";
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function NewLeadNotifier() {
  const { toast } = useToast();
  // The user whose baseline has been seeded (reset on account switch).
  const initializedFor = useRef<string | null>(null);

  const { can, approvalStatus } = useAdminAccess();
  const { userId } = useAuth();

  const { data: leads } = useQuery<CrmLead[]>({
    queryKey: ["/api/crm/leads"],
    // Staff without CRM access would only get 403s.
    enabled: Boolean(userId) && approvalStatus === "approved" && can("crm"),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  useEffect(() => {
    if (!userId || !leads || leads.length === 0) return;

    const maxId = leads.reduce((m, l) => (l.id > m ? l.id : m), 0);
    const stored = readLastSeenId(userId);

    // First load: just seed the baseline so we don't toast historical leads.
    if (initializedFor.current !== userId) {
      initializedFor.current = userId;
      if (stored < maxId) {
        writeLastSeenId(userId, maxId);
      }
      return;
    }

    if (maxId <= stored) return;

    const fresh = leads
      .filter((l) => l.id > stored)
      .sort((a, b) => b.id - a.id);

    // Aggregate to a single toast — global TOAST_LIMIT is 1, so multiple
    // toast() calls would overwrite each other and only the last lead
    // would be visible.
    const newest = fresh[0];
    const title =
      fresh.length === 1
        ? "New intake submitted"
        : `${fresh.length} new intakes submitted`;
    const serviceLabel = formatService(newest.serviceType);
    const snippet = newest.problemDescription
      ? ` — ${newest.problemDescription.slice(0, 80)}${
          newest.problemDescription.length > 80 ? "…" : ""
        }`
      : "";
    const description =
      fresh.length === 1
        ? `${serviceLabel}${newest.deviceType ? ` • ${newest.deviceType}` : ""}${snippet}`
        : `Latest: ${serviceLabel}${newest.deviceType ? ` • ${newest.deviceType}` : ""}${snippet}`;

    toast({
      title,
      description,
      action: (
        <Link href="/crm/leads">
          <Button size="sm" variant="outline">
            <Sparkles className="h-3 w-3 mr-1" />
            View
          </Button>
        </Link>
      ),
    });

    writeLastSeenId(userId, maxId);
  }, [leads, toast, userId]);

  return null;
}
