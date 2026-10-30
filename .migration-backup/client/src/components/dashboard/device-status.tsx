import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Server, Monitor, Laptop, Network } from "lucide-react";
import { Device } from "@shared/schema";

interface DeviceStatusProps {
  devices: Device[];
}

export default function DeviceStatus({ devices }: DeviceStatusProps) {
  const getDeviceStats = () => {
    const stats = {
      servers: { total: 0, online: 0 },
      workstations: { total: 0, online: 0 },
      laptops: { total: 0, online: 0 },
      network: { total: 0, online: 0 },
    };

    devices.forEach((device) => {
      const type = device.type as keyof typeof stats;
      if (stats[type]) {
        stats[type].total++;
        if (device.status === "online") {
          stats[type].online++;
        }
      }
    });

    return stats;
  };

  const stats = getDeviceStats();
  const totalDevices = devices.length;
  const onlineDevices = devices.filter(d => d.status === "online").length;
  const healthScore = totalDevices > 0 ? Math.round((onlineDevices / totalDevices) * 100) : 100;

  const deviceTypes = [
    {
      name: "Servers",
      description: "Critical infrastructure",
      icon: Server,
      iconBg: "bg-blue-100",
      iconColor: "text-blue-600",
      ...stats.servers,
    },
    {
      name: "Workstations",
      description: "Employee computers",
      icon: Monitor,
      iconBg: "bg-purple-100",
      iconColor: "text-purple-600",
      ...stats.workstations,
    },
    {
      name: "Laptops",
      description: "Mobile devices",
      icon: Laptop,
      iconBg: "bg-green-100",
      iconColor: "text-green-600",
      ...stats.laptops,
    },
    {
      name: "Network Devices",
      description: "Routers, switches, etc.",
      icon: Network,
      iconBg: "bg-orange-100",
      iconColor: "text-orange-600",
      ...stats.network,
    },
  ];

  return (
    <Card className="bg-white shadow-sm border border-gray-200">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg font-semibold text-gray-900">
          Device Status Overview
        </CardTitle>
        <p className="text-sm text-gray-600">Monitored endpoints by category</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {deviceTypes.map((type, index) => {
          const Icon = type.icon;
          return (
            <div
              key={index}
              className="flex items-center justify-between p-3 border border-gray-200 rounded-lg"
            >
              <div className="flex items-center space-x-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${type.iconBg}`}>
                  <Icon className={`h-5 w-5 ${type.iconColor}`} />
                </div>
                <div>
                  <p className="font-medium text-gray-900">{type.name}</p>
                  <p className="text-sm text-gray-500">{type.description}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-gray-900">{type.total}</p>
                <div className="flex items-center space-x-1">
                  <span className="w-2 h-2 bg-green-500 rounded-full" />
                  <span className="text-xs text-green-600">
                    {type.online} Online
                  </span>
                </div>
              </div>
            </div>
          );
        })}

        <div className="mt-6 p-4 bg-gray-50 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">
              Overall Health Score
            </span>
            <span className="text-lg font-bold text-green-600">{healthScore}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-green-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${healthScore}%` }}
            />
          </div>
          <p className="text-xs text-gray-600 mt-1">
            {healthScore >= 90 ? "Excellent" : healthScore >= 70 ? "Good" : "Needs Attention"} system performance across all monitored devices
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
