import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";

export type Crumb = { label: string; href?: string };

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  actions?: React.ReactNode;
  breadcrumbs?: Crumb[];
  className?: string;
  /**
   * When rendered inside a hub tab, the surrounding hub already provides the
   * page title. Set `embedded` to drop the title block, icon, and framing and
   * render just the action toolbar so we don't stack two headers.
   */
  embedded?: boolean;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  icon: Icon,
  actions,
  breadcrumbs,
  className,
  embedded = false,
}: PageHeaderProps) {
  if (embedded) {
    if (!actions) return null;
    return (
      <div className={cn("mb-4 flex flex-wrap items-center justify-end gap-2", className)}>
        {actions}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "border-b border-gray-200 bg-white",
        className,
      )}
    >
      <div className="px-4 py-4 md:px-6 md:py-5">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-xs text-gray-500">
            {breadcrumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="flex items-center gap-1">
                {c.href ? (
                  <Link href={c.href} className="hover:text-csd-red">
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
                {i < breadcrumbs.length - 1 && <ChevronRight className="h-3 w-3 text-gray-400" />}
              </span>
            ))}
          </nav>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            {Icon && (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-csd-red/10 to-red-100 text-csd-red ring-1 ring-csd-red/15">
                <Icon className="h-5 w-5" />
              </div>
            )}
            <div className="min-w-0">
              {eyebrow && (
                <div className="text-[11px] font-semibold uppercase tracking-wider text-csd-red">
                  {eyebrow}
                </div>
              )}
              <h1 className="truncate text-xl font-bold text-gray-900 md:text-2xl">{title}</h1>
              {description && (
                <p className="mt-1 text-sm text-gray-600 md:text-[15px]">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
        </div>
      </div>
    </div>
  );
}
