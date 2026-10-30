import { useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Mail, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import MarketplaceShell from "@/components/marketplace/portal-shell";
import ListingForm, { type ListingSubmitPayload } from "@/components/marketplace/listing-form";

export default function MarketplaceSellPage() {
  const [result, setResult] = useState<{ managePath: string; emailed: boolean; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async (payload: ListingSubmitPayload) => {
      const { addImages: _a, removeImageIds: _r, ...body } = payload;
      const res = await apiRequest("POST", "/api/portal/marketplace/listings", body);
      return { ...(await res.json()) as { id: number; managePath: string; emailed: boolean }, email: payload.sellerEmail };
    },
    onSuccess: (data) => { setResult(data); window.scrollTo({ top: 0 }); },
    onError: (e: Error) => setError(e.message.replace(/^\d+:\s*/, "")),
  });

  return (
    <MarketplaceShell backHref="/portal/marketplace" backLabel="All listings" showSell={false} width="narrow">
      {result ? (
        <div className="cyber-panel rounded-xl p-8 text-center border-emerald-500/40" data-testid="text-listing-submitted">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" />
          <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-400">[ Status: Pending review ]</p>
          <h1 className="mt-2 text-2xl font-black text-white">Listing submitted!</h1>
          <p className="mt-2 text-zinc-400">
            Our team reviews every listing before it goes live — usually within one business day. We'll email you when it's published.
          </p>
          <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-left text-sm">
            <p className="flex items-center gap-2 font-medium text-white"><Mail className="h-4 w-4 text-red-500" /> Your private manage link</p>
            <p className="mt-1 text-zinc-400">
              {result.emailed
                ? <>We sent it to <span className="font-medium text-zinc-200">{result.email}</span>. Use it any time to edit your listing, mark it sold, or remove it.</>
                : <>We couldn't send the email right now — save this link somewhere safe. It's the only way to edit or remove your listing.</>}
            </p>
            <Link href={result.managePath} className="mt-2 block break-all font-mono text-xs text-red-400 hover:text-red-300 hover:underline" data-testid="link-manage-listing">
              {window.location.origin}{import.meta.env.BASE_URL.replace(/\/$/, "")}{result.managePath}
            </Link>
          </div>
          <div className="mt-6 flex flex-col sm:flex-row justify-center gap-3">
            <Button asChild variant="outline" className="border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-white"><Link href="/portal/marketplace">Browse listings</Link></Button>
            <Button asChild className="bg-red-600 hover:bg-red-500 glow-red"><Link href={result.managePath}>Open my listing</Link></Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-6">
            <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-400"><Zap className="h-3.5 w-3.5 text-red-500" /> New listing</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight text-white">Sell your <span className="text-red-500 text-glow-red">rig</span>.</h1>
            <p className="mt-1 text-zinc-400">
              Three quick steps. Scan the label or type the model number and we fill in the specs; our team reviews it before it goes live.
            </p>
          </div>
          <div className="cyber-panel rounded-xl p-5 sm:p-8">
            <ListingForm
              audience="seller"
              layout="funnel"
              submitLabel="Launch listing"
              submitting={create.isPending}
              onSubmit={(payload) => { setError(null); create.mutate(payload); }}
            />
            {error && <p className="mt-4 rounded-md border border-red-500/50 bg-red-950/50 p-3 text-sm text-red-200" data-testid="text-submit-error">{error}</p>}
          </div>
        </>
      )}
    </MarketplaceShell>
  );
}
