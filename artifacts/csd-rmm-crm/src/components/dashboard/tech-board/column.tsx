import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";

/**
 * Framing shared by the three board columns: a fixed header, an optional
 * toolbar row, and a scrolling body so long lists never push the other
 * columns around.
 */
export function BoardColumn({
  icon: Icon,
  title,
  subtitle,
  count,
  toolbar,
  children,
  className,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  count?: number;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={cn(
        "flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white shadow-sm",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-csd-red/10 text-csd-red ring-1 ring-csd-red/15">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-gray-900">{title}</h2>
            {subtitle && <p className="truncate text-xs text-gray-500">{subtitle}</p>}
          </div>
        </div>
        {count != null && (
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-gray-700">
            {count}
          </span>
        )}
      </header>
      {toolbar && <div className="border-b border-gray-100 px-3 py-2">{toolbar}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/** Sub-heading inside a column (e.g. one job status bucket). */
export function BoardGroupHeader({
  label,
  count,
  dot,
}: {
  label: string;
  count: number;
  dot?: string;
}) {
  return (
    <div className="sticky top-0 z-[1] flex items-center gap-2 bg-gray-50/95 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-600 backdrop-blur">
      {dot && <span className={cn("h-2 w-2 rounded-full", dot)} />}
      <span>{label}</span>
      <span className="tabular-nums text-gray-400">{count}</span>
    </div>
  );
}

/**
 * One clickable row. Every row on the board is a real button so keyboard
 * users can open the detail window too.
 */
export function BoardRow({
  onClick,
  leading,
  title,
  meta,
  trailing,
  testId,
  className,
}: {
  onClick: () => void;
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "group flex w-full items-center gap-3 border-b border-gray-100 px-4 py-2.5 text-left transition-colors last:border-b-0",
        "hover:bg-red-50/60 focus-visible:bg-red-50/60 focus-visible:outline-none",
        className,
      )}
    >
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-900">{title}</div>
        {meta && <div className="mt-0.5 truncate text-xs text-gray-500">{meta}</div>}
      </div>
      {trailing && <div className="shrink-0 text-right">{trailing}</div>}
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-300 transition-colors group-hover:text-csd-red" />
    </button>
  );
}

export function BoardEmpty({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <Icon className="h-8 w-8 text-gray-300" />
      <p className="text-sm text-gray-500">{text}</p>
    </div>
  );
}

export function BoardSkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {[...Array(rows)].map((_, i) => (
        <div key={i} className="h-11 animate-pulse rounded-md bg-gray-100" />
      ))}
    </div>
  );
}

export function Pill({ tone, children, className }: { tone: string; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", tone, className)}>
      {children}
    </span>
  );
}
