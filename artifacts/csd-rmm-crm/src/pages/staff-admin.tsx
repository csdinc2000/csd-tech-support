import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useAdminAccess } from "@/hooks/use-admin-access";
import StaffAccessPage from "./staff-access";
import DispatchSettingsPage from "./dispatch-settings";
import { ShieldAlert, Users, Radio } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type StaffAdminAccess = {
  canAccess: boolean;
  canDispatch: boolean;
  isLoading: boolean;
};

type StaffAdminViewProps = StaffAdminAccess & {
  AccessPage?: React.ComponentType;
  DispatchPage?: React.ComponentType<{ onDirtyChange?: (dirty: boolean) => void }>;
};

export function StaffAdminView({
  canAccess,
  canDispatch,
  isLoading,
  AccessPage = StaffAccessPage,
  DispatchPage = DispatchSettingsPage,
}: StaffAdminViewProps) {
  const [location, setLocation] = useLocation();
  const search = useSearch();

  const [activeTab, setActiveTab] = useState<string>("access");
  const [dispatchDirty, setDispatchDirty] = useState(false);

  useEffect(() => {
    const searchParams = new URLSearchParams(search);
    const tabParam = searchParams.get("tab");
    const nextTab = tabParam === "dispatch" && canDispatch
      ? "dispatch"
      : tabParam === "access" && canAccess
        ? "access"
        : canAccess ? "access" : "dispatch";
    if (nextTab === activeTab) return;
    if (activeTab === "dispatch" && nextTab !== "dispatch" && dispatchDirty
      && !window.confirm("You have unsaved dispatch recipient changes. Leave this page and discard them?")) {
      searchParams.set("tab", activeTab);
      const restoredSearch = searchParams.toString();
      window.history.replaceState(window.history.state, "", `${location}${restoredSearch ? `?${restoredSearch}` : ""}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    setActiveTab(nextTab);
  }, [search, canAccess, canDispatch, activeTab, dispatchDirty, location]);

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Checking access…</div>;

  if (!canAccess && !canDispatch) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md rounded-xl border bg-white p-8 text-center shadow-sm">
          <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-csd-red" />
          <h1 className="text-xl font-semibold">Feature approval required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your role does not currently include staff administration features. Ask the account owner
            to approve access.
          </p>
        </div>
      </div>
    );
  }

  const handleTabChange = (value: string) => {
    if (activeTab === "dispatch" && value !== "dispatch" && dispatchDirty &&
        !window.confirm("You have unsaved dispatch recipient changes. Leave this page and discard them?")) return;
    setActiveTab(value);
    const searchParams = new URLSearchParams(search);
    searchParams.set("tab", value);
    const nextSearch = searchParams.toString();
    setLocation(`${location}${nextSearch ? `?${nextSearch}` : ""}`);
  };

  // If they can only see one view, we don't necessarily need to render tabs,
  // but it's simpler to just render the content directly if there's only one.
  if (canAccess && !canDispatch) {
    return <AccessPage />;
  }

  if (canDispatch && !canAccess) {
    return <DispatchPage onDirtyChange={setDispatchDirty} />;
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-4rem)] bg-stone-50/50">
      <div className="flex-1">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <div className="border-b border-stone-200 bg-white pt-4 sticky top-16 z-10 shadow-sm">
            <div className="mx-auto max-w-6xl px-4 md:px-8">
              <TabsList className="h-auto p-0 bg-transparent gap-8">
                <TabsTrigger 
                  value="access" 
                  className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-csd-red rounded-none border-b-2 border-transparent px-2 pb-3 pt-2 text-sm font-semibold text-stone-500 hover:text-stone-700 data-[state=active]:text-stone-950 transition-colors"
                >
                  <Users className="mr-2 h-4 w-4" />
                  Roles &amp; Access
                </TabsTrigger>
                <TabsTrigger 
                  value="dispatch" 
                  className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-csd-red rounded-none border-b-2 border-transparent px-2 pb-3 pt-2 text-sm font-semibold text-stone-500 hover:text-stone-700 data-[state=active]:text-stone-950 transition-colors"
                >
                  <Radio className="mr-2 h-4 w-4" />
                  Dispatch Settings
                </TabsTrigger>
              </TabsList>
            </div>
          </div>
          
          <div className="flex-1">
            <TabsContent value="access" className="m-0 border-none p-0 focus-visible:outline-none focus-visible:ring-0">
              <AccessPage />
            </TabsContent>
            
            <TabsContent value="dispatch" className="m-0 border-none p-0 focus-visible:outline-none focus-visible:ring-0">
               <DispatchPage onDirtyChange={setDispatchDirty} />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}

export default function StaffAdminPage() {
  const { can, isAdmin, isLoading } = useAdminAccess();

  return (
    <StaffAdminView
      canAccess={can("staffAdmin")}
      // Staff dispatch endpoints are owner-only on the server. Keep the tab
      // aligned with that stricter boundary instead of exposing controls that
      // would fail.
      canDispatch={isAdmin}
      isLoading={isLoading}
    />
  );
}
