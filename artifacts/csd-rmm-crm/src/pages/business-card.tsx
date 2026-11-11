import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Loader2 } from "lucide-react";
import { BusinessCardView } from "@/components/business-card/business-card-view";
import type { BusinessCardData } from "@/lib/business-card";

// Public digital business card: /card/<token>. No sign-in required.
export default function BusinessCardPage() {
  const { token = "" } = useParams<{ token: string }>();
  const { data: card, isLoading, isError } = useQuery<BusinessCardData>({
    queryKey: [`/api/portal/business-card/${encodeURIComponent(token)}`],
    retry: false,
  });

  useEffect(() => {
    if (card) document.title = `${card.name} | ${card.company.name}`;
  }, [card]);

  return (
    <main className="flex min-h-dvh items-start justify-center bg-gradient-to-b from-gray-100 to-gray-200 px-4 py-8 sm:items-center">
      {isLoading ? (
        <Loader2 className="mt-24 h-8 w-8 animate-spin text-gray-400" aria-label="Loading card" />
      ) : isError || !card ? (
        <div className="mt-24 max-w-sm rounded-2xl bg-white p-6 text-center shadow" data-testid="card-unavailable">
          <h1 className="text-lg font-semibold">This card is no longer available</h1>
          <p className="mt-2 text-sm text-gray-600">The link may have been replaced. Please ask your technician for a new one.</p>
        </div>
      ) : (
        <BusinessCardView card={card} />
      )}
    </main>
  );
}
