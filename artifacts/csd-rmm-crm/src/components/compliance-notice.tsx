import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface ComplianceNoticeProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Compact authorization/consent callout used on pages that expose
 * monitoring, remote access, messaging, or recording capabilities.
 */
export default function ComplianceNotice({ title, children, className }: ComplianceNoticeProps) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-gray-600",
        className,
      )}
    >
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-csd-red" aria-hidden="true" />
      <div>
        {title && <span className="font-semibold text-gray-800">{title} — </span>}
        {children}
      </div>
    </div>
  );
}
