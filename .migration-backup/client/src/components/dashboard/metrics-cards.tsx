import { Card, CardContent } from "@/components/ui/card";
import { Monitor, AlertTriangle, Ticket, CheckCircle } from "lucide-react";

interface MetricsCardsProps {
  metrics: {
    totalDevices: number;
    activeAlerts: number;
    openTickets: number;
    uptime: number;
    onlineDevices: number;
  };
}

export default function MetricsCards({ metrics }: MetricsCardsProps) {
  const cards = [
    {
      title: "Total Devices",
      value: metrics.totalDevices,
      icon: Monitor,
      iconBg: "bg-blue-100",
      iconColor: "text-blue-600",
      change: "+12%",
      changeText: "from last month",
      changeColor: "text-green-600",
    },
    {
      title: "Active Alerts",
      value: metrics.activeAlerts,
      icon: AlertTriangle,
      iconBg: "bg-red-100",
      iconColor: "text-red-600",
      change: "3 Critical",
      changeText: "5 Warning",
      changeColor: "text-red-600",
    },
    {
      title: "Open Tickets",
      value: metrics.openTickets,
      icon: Ticket,
      iconBg: "bg-yellow-100",
      iconColor: "text-yellow-600",
      change: "Avg resolution:",
      changeText: "2.4 hours",
      changeColor: "text-gray-600",
    },
    {
      title: "System Uptime",
      value: `${metrics.uptime}%`,
      icon: CheckCircle,
      iconBg: "bg-green-100",
      iconColor: "text-green-600",
      change: "Excellent",
      changeText: "performance",
      changeColor: "text-green-600",
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {cards.map((card, index) => {
        const Icon = card.icon;
        return (
          <Card key={index} className="bg-white shadow-sm border border-gray-200">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">{card.title}</p>
                  <p className="text-3xl font-bold text-gray-900">{card.value}</p>
                </div>
                <div className={`p-3 rounded-full ${card.iconBg}`}>
                  <Icon className={`h-5 w-5 ${card.iconColor}`} />
                </div>
              </div>
              <div className="mt-4 flex items-center text-sm">
                <span className={`font-medium ${card.changeColor}`}>
                  {card.change}
                </span>
                <span className="text-gray-500 ml-2">{card.changeText}</span>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
