import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gift, X } from "lucide-react";
import { clearStoredReferralCode, storedReferralCode } from "@/lib/utm-capture";

type CodeLookup = { valid: false } | { valid: true; code: string; referrerFirstName: string; friendReward: string };

/**
 * Greets a friend who arrived through a customer's share link. Only shown when
 * the stored code is valid and the program is active; the friend can dismiss
 * it, which also drops the code so the request isn't credited.
 */
export function ReferralBanner() {
  const [code, setCode] = useState<string | undefined>();
  useEffect(() => setCode(storedReferralCode()), []);
  const { data } = useQuery<CodeLookup>({
    queryKey: [`/api/portal/referrals/code/${encodeURIComponent(code ?? "")}`],
    enabled: !!code,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!code || !data?.valid) return null;
  return (
    <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-xl border border-red-200 bg-white p-4 shadow-sm" data-testid="referral-banner">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
        <Gift className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-gray-900">{data.referrerFirstName} referred you!</p>
        <p className="text-sm text-gray-600">
          You'll get <strong>{data.friendReward}</strong>. Code <span className="font-mono text-gray-800">{data.code}</span> is applied to this request.
        </p>
      </div>
      <button
        type="button"
        onClick={() => { clearStoredReferralCode(); setCode(undefined); }}
        className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        aria-label="Remove referral code"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
