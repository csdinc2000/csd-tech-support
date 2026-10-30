import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { DealStage } from "@shared/schema";

export interface PipelineStats {
  openTickets: number;
  activeDeals: number;
  pipelineMrr: number;
  wonThisMonth: number;
  wonMrrThisMonth: number;
  byStage: { stage: DealStage; count: number; mrr: number }[];
}

/**
 * Live pipeline metrics. Fetches stats through react-query and keeps them
 * (plus the deal list) fresh by listening to the server-sent event stream at
 * /api/crm/pipeline/stream — any deal create/move/delete from another
 * technician invalidates the caches immediately, no polling.
 */
export function usePipelineSync() {
  const statsQuery = useQuery<PipelineStats>({
    queryKey: ["/api/crm/pipeline/stats"],
  });

  useEffect(() => {
    const es = new EventSource("/api/crm/pipeline/stream");
    const onPipeline = () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/deals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/pipeline/stats"] });
    };
    es.addEventListener("pipeline", onPipeline);
    return () => {
      es.removeEventListener("pipeline", onPipeline);
      es.close();
    };
  }, []);

  return {
    stats: statsQuery.data,
    isLoading: statsQuery.isLoading,
    refetch: statsQuery.refetch,
  };
}
