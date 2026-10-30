import { Bell, User, LogIn, LogOut, Search, Settings, CreditCard, ShieldAlert, Activity, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

type Alert = {
  id: number;
  title?: string;
  message?: string;
  severity?: string;
  createdAt?: string;
};

function severityClasses(severity?: string) {
  switch ((severity || "").toLowerCase()) {
    case "critical":
    case "high":
      return "bg-red-50 text-red-700 border-red-200";
    case "medium":
    case "warning":
      return "bg-amber-50 text-amber-700 border-amber-200";
    default:
      return "bg-blue-50 text-blue-700 border-blue-200";
  }
}

export default function Header() {
  const { user, isLoading, isAuthenticated, isAdmin, logout } = useAuth();
  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ["/api/alerts/active"],
    staleTime: 1000 * 30,
    retry: false,
  });

  const alertCount = Array.isArray(alerts) ? alerts.length : 0;
  const displayAlerts = (Array.isArray(alerts) ? alerts : []).slice(0, 6);

  const userInitials = (() => {
    if (!user) return "?";
    const f = user.firstName?.[0] ?? "";
    const l = user.lastName?.[0] ?? "";
    return (f + l).toUpperCase() || (user.email?.[0] ?? "U").toUpperCase();
  })();

  return (
    <header className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="flex h-16 items-center gap-3 px-4 pl-16 lg:px-6 lg:pl-6">
        {/* Brand */}
        <Link href="/dashboard" className="flex shrink-0 items-center gap-3">
          <img src={csdLogo} alt="Computer Systems Depot" className="h-9 w-auto" />
          <div className="hidden md:block leading-tight">
            <div className="text-sm font-semibold text-gray-900">CSD Platform</div>
            <div className="text-[11px] uppercase tracking-wide text-gray-500">RMM · CRM · Helpdesk</div>
          </div>
        </Link>

        {/* Global Search */}
        <div className="ml-4 hidden flex-1 max-w-md md:flex">
          <div className="relative w-full">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search devices, tickets, contacts…"
              className="h-9 pl-9"
              type="search"
              aria-label="Global search"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 select-none rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 sm:inline-block">
              ⌘K
            </kbd>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {/* System status pill */}
          <div className="hidden items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-medium text-green-700 lg:flex">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
            </span>
            <Activity className="h-3 w-3" />
            Operational
          </div>

          {/* Notifications */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="relative h-9 w-9 p-0" aria-label="Notifications">
                <Bell className="h-4 w-4 text-gray-600" />
                {alertCount > 0 && (
                  <Badge
                    variant="destructive"
                    className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px]"
                  >
                    {alertCount > 9 ? "9+" : alertCount}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel className="flex items-center justify-between">
                <span>Active Alerts</span>
                <span className="text-xs font-normal text-gray-500">{alertCount} total</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {displayAlerts.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-gray-500">
                  <ShieldAlert className="mx-auto mb-2 h-5 w-5 text-gray-400" />
                  No active alerts
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  {displayAlerts.map((a) => (
                    <div
                      key={a.id}
                      className={`mx-2 my-1 rounded-md border px-2.5 py-2 text-xs ${severityClasses(a.severity)}`}
                    >
                      <div className="font-semibold">{a.title || "Alert"}</div>
                      {a.message && <div className="mt-0.5 line-clamp-2 opacity-80">{a.message}</div>}
                    </div>
                  ))}
                </div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/monitoring" className="cursor-pointer">
                  <ExternalLink className="mr-2 h-3.5 w-3.5" />
                  View all in Monitoring
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* User / Auth */}
          {isLoading ? (
            <div className="h-9 w-9 animate-pulse rounded-full bg-gray-200" />
          ) : isAuthenticated && user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="flex h-9 items-center gap-2 px-2" aria-label="Account menu">
                  {user.profileImageUrl ? (
                    <img
                      src={user.profileImageUrl}
                      alt={user.firstName || "User"}
                      className="h-7 w-7 rounded-full object-cover ring-2 ring-white"
                    />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-csd-red to-red-700 text-[11px] font-semibold text-white ring-2 ring-white">
                      {userInitials}
                    </div>
                  )}
                  <span className="hidden text-sm font-medium text-gray-700 sm:inline-block">
                    {user.firstName || (user.email ? user.email.split("@")[0] : "User")}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="text-sm">
                    {user.firstName ? `${user.firstName} ${user.lastName ?? ""}`.trim() : "Account"}
                  </span>
                  {user.email && (
                    <span className="truncate text-xs font-normal text-gray-500">{user.email}</span>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {isAdmin && (
                  <>
                    <DropdownMenuItem asChild>
                      <Link href="/billing" className="cursor-pointer">
                        <CreditCard className="mr-2 h-4 w-4" />
                        Billing &amp; Plans
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/admin/phone" className="cursor-pointer">
                        <Settings className="mr-2 h-4 w-4" />
                        Main Line Setup
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => logout()} className="cursor-pointer text-red-600 focus:text-red-700">
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              size="sm"
              onClick={() => (window.location.href = "/api/login")}
              className="bg-csd-red hover:bg-red-700"
            >
              <LogIn className="mr-1 h-4 w-4" />
              Sign In
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
