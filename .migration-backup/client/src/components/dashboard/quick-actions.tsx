import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Monitor, RotateCcw, Search, Settings, Ticket } from "lucide-react";

export default function QuickActions() {
  const [, navigate] = useLocation();

  const actions = [
    {
      name: "Remote Desktop",
      description: "Connect to client machines",
      icon: Monitor,
      iconBg: "bg-red-100",
      iconColor: "text-primary",
      onClick: () => navigate("/remote-access"),
    },
    {
      name: "Patch & Update",
      description: "Patch policies and rollouts",
      icon: RotateCcw,
      iconBg: "bg-blue-100",
      iconColor: "text-blue-600",
      onClick: () => navigate("/patches"),
    },
    {
      name: "Network Discovery",
      description: "Scan for new devices",
      icon: Search,
      iconBg: "bg-green-100",
      iconColor: "text-green-600",
      onClick: () => navigate("/network-discovery"),
    },
    {
      name: "Run Script",
      description: "Execute automation scripts",
      icon: Settings,
      iconBg: "bg-purple-100",
      iconColor: "text-purple-600",
      onClick: () => navigate("/automation"),
    },
    {
      name: "Create Ticket",
      description: "New support request",
      icon: Ticket,
      iconBg: "bg-yellow-100",
      iconColor: "text-yellow-600",
      onClick: () => navigate("/tickets"),
    },
  ];

  return (
    <Card className="bg-white shadow-sm border border-gray-200">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg font-semibold text-gray-900">
          Quick Actions
        </CardTitle>
        <p className="text-sm text-gray-600">Common IT tasks</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {actions.map((action, index) => {
          const Icon = action.icon;
          return (
            <Button
              key={index}
              variant="ghost"
              className="w-full justify-start p-3 h-auto border border-gray-200 hover:border-primary hover:bg-red-50"
              onClick={action.onClick}
            >
              <div className="flex items-center space-x-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${action.iconBg}`}>
                  <Icon className={`h-4 w-4 ${action.iconColor}`} />
                </div>
                <div className="text-left">
                  <p className="font-medium text-gray-900">{action.name}</p>
                  <p className="text-xs text-gray-500">{action.description}</p>
                </div>
              </div>
            </Button>
          );
        })}
      </CardContent>
    </Card>
  );
}
