import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { StaffFeature } from "@/hooks/use-admin-access";
import { TECH_LINK_GROUPS, TECH_LINKS_BY_ID, canOpenLink } from "@/lib/tech-support-links";

// The pages technicians open most from the board, in the order they appear.
const PINNED_LINK_IDS = [
  "jobs", "helpdesk", "remote-access", "customers", "service-logs", "comms", "tech-tools", "training",
];

/**
 * One-click row of the most-used support pages, plus an "All links" drawer
 * with the full catalog. Links the technician's role can't open are hidden.
 */
export function BoardQuickLinks({ can }: { can: (feature: StaffFeature) => boolean }) {
  const [open, setOpen] = useState(false);
  const pinned = PINNED_LINK_IDS.map((id) => TECH_LINKS_BY_ID[id]).filter((link) => canOpenLink(link, can));
  const groups = TECH_LINK_GROUPS
    .map((group) => ({ ...group, links: group.links.filter((link) => canOpenLink(link, can)) }))
    .filter((group) => group.links.length > 0);

  return (
    <nav aria-label="Tech support quick links" className="flex flex-wrap items-center gap-1.5" data-testid="board-quick-links">
      <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Quick links</span>
      {pinned.map((link) => {
        const Icon = link.icon;
        return (
          <Link
            key={link.id}
            href={link.href}
            title={link.description}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:border-csd-red/40 hover:text-csd-red"
            data-testid={`board-link-${link.id}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {link.label}
          </Link>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 rounded-full px-3 text-xs text-gray-600"
        onClick={() => setOpen(true)}
        data-testid="board-all-links"
      >
        <LayoutGrid className="mr-1 h-3.5 w-3.5" />
        All links
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md" data-testid="board-links-sheet">
          <SheetHeader>
            <SheetTitle>Tech support links</SheetTitle>
            <SheetDescription>Every page a technician works from, grouped by task.</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-5">
            {groups.map((group) => (
              <section key={group.id}>
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{group.title}</h3>
                <div className="space-y-1">
                  {group.links.map((link) => {
                    const Icon = link.icon;
                    return (
                      <Link
                        key={link.id}
                        href={link.href}
                        onClick={() => setOpen(false)}
                        className="flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-red-50/60"
                      >
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-csd-red/10 text-csd-red">
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-gray-900">{link.label}</span>
                          <span className="block text-xs text-gray-500">{link.description}</span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </nav>
  );
}
