import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import type { CrmLead } from "@shared/schema";

const STORAGE_KEY = "newLeadNotifier:lastSeenId";
const POLL_INTERVAL_MS = 10_000;

function formatService(s?: string | null) {
  if (!s) return "Service";
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function NewLeadNotifier() {
  const { toast } = useToast();
  const initializedRef = useRef(false);

  const { data: leads } = useQuery<CrmLead[]>({
    queryKey: ["/api/crm/leads"],
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  useEffect(() => {
    if (!leads || leads.length === 0) return;

    const maxId = leads.reduce((m, l) => (l.id > m ? l.id : m), 0);
    const stored = Number(localStorage.getItem(STORAGE_KEY) || "0");

    // First load: just seed the baseline so we don't toast historical leads.
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (stored < maxId) {
        localStorage.setItem(STORAGE_KEY, String(maxId));
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

    localStorage.setItem(STORAGE_KEY, String(maxId));
  }, [leads, toast]);

  return null;
}
