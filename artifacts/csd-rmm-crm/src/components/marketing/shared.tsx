import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { DEFAULT_BRAND_KIT, type BrandKit } from "@/lib/marketing";

/** White card with a titled header, used by every Marketing hub section. */
export function MarketingCard({
  icon: Icon,
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  testId,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className={cn("flex min-w-0 flex-col rounded-lg border border-gray-200 bg-white shadow-sm", className)}>
      <header className="flex flex-col gap-2 border-b border-gray-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-csd-red/10 text-csd-red ring-1 ring-csd-red/15">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            {description && <p className="text-xs text-gray-600">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("min-w-0 flex-1 p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  hint?: string;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 shadow-sm" data-testid={testId}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-xl font-bold leading-tight tabular-nums text-gray-900">{value}</span>
        <span className="block truncate text-xs font-medium text-gray-700">{label}</span>
        {hint && <span className="block truncate text-[11px] text-gray-400">{hint}</span>}
      </span>
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className, disabled }: { text: string; label?: string; className?: string; disabled?: boolean }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy", description: "Select the text and copy it manually.", variant: "destructive" });
    }
  };
  return (
    <Button type="button" variant="outline" size="sm" className={className} onClick={copy} disabled={disabled || !text}>
      {copied ? <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-600" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

const BRAND_KIT_KEY = "csd:marketing:brand-kit";

/**
 * Business details the copy tools fill in. Kept in this browser only — it's
 * convenience data (name, phone, links), not a system of record.
 */
export function useBrandKit(): [BrandKit, (next: Partial<BrandKit>) => void] {
  const [kit, setKit] = useState<BrandKit>(DEFAULT_BRAND_KIT);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(BRAND_KIT_KEY);
      if (stored) setKit({ ...DEFAULT_BRAND_KIT, ...JSON.parse(stored) });
    } catch { /* fall back to defaults */ }
  }, []);
  const update = useCallback((next: Partial<BrandKit>) => {
    setKit((prev) => {
      const merged = { ...prev, ...next };
      try { localStorage.setItem(BRAND_KIT_KEY, JSON.stringify(merged)); } catch { /* not persisted */ }
      return merged;
    });
  }, []);
  return [kit, update];
}

export const currency = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const percent = (value: number | null) => (value == null ? "—" : `${Math.round(value * 100)}%`);
