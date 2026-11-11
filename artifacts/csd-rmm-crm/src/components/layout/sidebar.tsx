import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import { Menu, X, ChevronDown, LifeBuoy, PhoneCall, MapPin, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAdminAccess, type StaffFeature } from "@/hooks/use-admin-access";
import { NAV_GROUPS, canAccessRoute, navItemsByGroup, type NavGroupMeta, type NavItem } from "@/app-routes";
import csdIcon from "@assets/CSD_ICON_Favicon_Logo_1765066839385.png";

// Menu entries come from STAFF_ROUTES in app-routes.tsx, the same list that
// gates the routes, so what's shown here is exactly what the user can open.
type NavGroup = NavGroupMeta & { items: NavItem[] };

const NAV_ITEMS = navItemsByGroup();

function isItemActive(item: NavItem, location: string) {
  const { href } = item;
  if (href === "/dashboard" && location === "/") return true;
  if (location === href) return true;
  // Sibling sub-views that share this item's hub tab but carry their own URL.
  if (item.match?.includes(location)) return true;
  // Items with their own sub-pages in the menu (dashboard, marketing hub) only
  // match exactly; others stay active on nested routes like /invoices/42.
  if (!item.exact && location.startsWith(href + "/")) return true;
  return false;
}

function NavLink({ item, location, onClick }: { item: NavItem; location: string; onClick?: () => void }) {
  const Icon = item.icon;
  const active = isItemActive(item, location);
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all",
        active
          ? "bg-red-500/10 text-white"
          : "text-gray-300 hover:bg-white/5 hover:text-white",
      )}
      data-testid={`nav-${item.href.replace(/\//g, "-")}`}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full transition-all",
          active ? "bg-csd-red opacity-100" : "opacity-0 group-hover:opacity-30 group-hover:bg-gray-400",
        )}
        aria-hidden="true"
      />
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          active ? "text-csd-red" : "text-gray-400 group-hover:text-gray-200",
        )}
      />
      <span className="truncate">{item.name}</span>
    </Link>
  );
}

function NavGroupBlock({
  group,
  location,
  open,
  onToggle,
  onItemClick,
}: {
  group: NavGroup;
  location: string;
  open: boolean;
  onToggle: () => void;
  onItemClick?: () => void;
}) {
  const GroupIcon = group.icon;
  const hasActive = group.items.some((i) => isItemActive(i, location));
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
          hasActive ? "text-gray-200" : "text-gray-400 hover:text-gray-200",
        )}
        aria-expanded={open}
      >
        <GroupIcon className="h-3.5 w-3.5 text-gray-500 group-hover:text-gray-300" />
        <span className="flex-1 text-left">{group.title}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-gray-500 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <nav className="mt-1 space-y-0.5 pl-1">
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} location={location} onClick={onItemClick} />
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

function SidebarBody({
  location,
  openGroups,
  toggleGroup,
  onItemClick,
  can,
  isAdmin,
}: {
  location: string;
  openGroups: Record<string, boolean>;
  toggleGroup: (id: string) => void;
  onItemClick?: () => void;
  can: (feature: StaffFeature) => boolean;
  isAdmin: boolean;
}) {
  const visibleGroups: NavGroup[] = NAV_GROUPS
    .map((group) => ({
      ...group,
      items: (NAV_ITEMS.get(group.id) ?? [])
        .filter((item) => canAccessRoute(item.access, { can, isAdmin }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    }))
    .filter((group) => group.items.length > 0);
  visibleGroups.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1">
        <div className="p-3">
          {visibleGroups.map((group) => (
            <NavGroupBlock
              key={group.id}
              group={group}
              location={location}
              open={openGroups[group.id] ?? true}
              onToggle={() => toggleGroup(group.id)}
              onItemClick={onItemClick}
            />
          ))}

          <div className="mt-6 rounded-lg border border-white/5 bg-gradient-to-br from-white/[0.03] to-transparent p-3">
            <div className="mb-2 flex items-center gap-2">
              <img src={csdIcon} alt="CSD" className="h-8 w-8 rounded" />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-white">Computer Systems Depot</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">Since 1996</div>
              </div>
            </div>
            <a
              href="tel:954-637-7300"
              className="mb-2 flex items-center gap-2 rounded-md bg-csd-red/10 px-2 py-1.5 text-sm font-semibold text-red-300 transition-colors hover:bg-csd-red hover:text-white"
            >
              <PhoneCall className="h-3.5 w-3.5" />
              954-637-7300
            </a>
            <div className="space-y-1.5 text-[11px] text-gray-400">
              <div className="flex items-start gap-1.5">
                <Clock className="mt-0.5 h-3 w-3 shrink-0 text-gray-500" />
                <span>Mon–Fri 5:00 PM – 11:00 PM</span>
              </div>
              <div className="flex items-start gap-1.5">
                <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-gray-500" />
                <span>
                  5601 NW 13 Street
                  <br />
                  Lauderhill, FL 33313
                </span>
              </div>
            </div>
          </div>

          <a
            href="/intake"
            className="mt-3 flex items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-medium text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <LifeBuoy className="h-3.5 w-3.5" />
            New Service Intake
          </a>
        </div>
      </ScrollArea>
    </div>
  );
}

const STORAGE_KEY = "csd:sidebar-groups";

function useGroupState() {
  const initial: Record<string, boolean> = NAV_GROUPS.reduce(
    (acc, g) => ({ ...acc, [g.id]: true }),
    {} as Record<string, boolean>,
  );
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(initial);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setOpenGroups({ ...initial, ...JSON.parse(stored) });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  return { openGroups, toggleGroup };
}

export default function Sidebar() {
  const [location] = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const isMobile = useIsMobile();
  const { openGroups, toggleGroup } = useGroupState();
  const { can, isAdmin } = useAdminAccess();

  // Close mobile drawer on route change
  useEffect(() => {
    setIsOpen(false);
  }, [location]);

  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="fixed left-3 top-3 z-50 h-10 w-10 bg-gray-900 p-0 text-white shadow-lg hover:bg-gray-800 lg:hidden"
          onClick={() => setIsOpen(!isOpen)}
          aria-label={isOpen ? "Close menu" : "Open menu"}
        >
          {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>

        {isOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />
        )}

        <aside
          className={cn(
            "fixed left-0 top-0 z-40 h-full w-72 transform bg-gray-950 text-white shadow-2xl transition-transform duration-300 ease-out lg:hidden",
            isOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-16 items-center border-b border-white/10 px-4 pl-16">
            <img src={csdIcon} alt="CSD" className="h-7 w-7 rounded" />
            <span className="ml-2 text-sm font-semibold">CSD Platform</span>
          </div>
          <SidebarBody
            location={location}
            openGroups={openGroups}
            toggleGroup={toggleGroup}
            can={can}
            isAdmin={isAdmin}
            onItemClick={() => setIsOpen(false)}
          />
        </aside>
      </>
    );
  }

  return (
    <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-64 shrink-0 flex-col border-r border-white/5 bg-gray-950 text-white lg:flex">
      <SidebarBody location={location} openGroups={openGroups} toggleGroup={toggleGroup} can={can} isAdmin={isAdmin} />
    </aside>
  );
}
