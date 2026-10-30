import { useLocation } from "wouter";
import { Code, LayoutDashboard, Zap } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Automation from "@/pages/automation";
import AutomationDashboard from "@/components/advanced/automation-dashboard";

type AutomationTab = "overview" | "scripts";

export default function AutomationWorkspace() {
  const [location, navigate] = useLocation();
  const activeTab: AutomationTab = location === "/automation-hub" ? "overview" : "scripts";

  const handleTabChange = (value: string) => {
    navigate(value === "overview" ? "/automation-hub" : "/automation");
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="border-b border-gray-200 bg-white px-4 py-5 md:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-csd-red">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Automation</h1>
            <p className="text-sm text-gray-600">
              Run, create, and manage IT automation from one workspace.
            </p>
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="p-4 md:p-6">
        <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg p-1">
          <TabsTrigger value="overview" className="shrink-0" data-testid="tab-automation-overview">
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="scripts" className="shrink-0" data-testid="tab-automation-scripts">
            <Code className="mr-2 h-4 w-4" />
            Scripts &amp; Library
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <AutomationDashboard embedded />
        </TabsContent>
        <TabsContent value="scripts" className="mt-4">
          <Automation embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}