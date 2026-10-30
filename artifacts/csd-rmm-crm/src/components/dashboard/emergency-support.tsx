import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Shield, Clock, RefreshCw } from "lucide-react";

type Device = { id: number; status: string };
type Alert = { id: number; status: string };

export default function SystemStatus({
  devices,
  alerts,
  lastUpdatedAt,
}: {
  devices: Device[];
  alerts: Alert[];
  lastUpdatedAt?: string;
}) {
  const [, navigate] = useLocation();

  const totalDevices = devices.length;
  const onlineDevices = devices.filter(d => d.status === "online").length;
  const openAlerts = alerts.filter(a => a.status !== "resolved").length;

  return (
    <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-lg shadow-lg text-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-bold mb-2">Current Monitoring Snapshot</h3>
          <p className="text-blue-100 mb-4">
            Real-time monitoring and automated alerts for optimal performance
          </p>
          <div className="flex items-center space-x-6 text-sm">
            <div className="flex items-center space-x-2">
              <Shield className="h-4 w-4" />
              <span className="font-semibold">{openAlerts === 0 ? "All Clear" : `${openAlerts} Active Alert${openAlerts === 1 ? "" : "s"}`}</span>
            </div>
            <div className="flex items-center space-x-2">
              <Clock className="h-4 w-4" />
              <span>
                {totalDevices === 0
                  ? "No devices monitored"
                  : `${onlineDevices}/${totalDevices} devices online`}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <RefreshCw className="h-4 w-4" />
              <span>
                {lastUpdatedAt
                  ? `Updated ${new Date(lastUpdatedAt).toLocaleTimeString()}`
                  : "Waiting for live data"}
              </span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <Button
            className="bg-white text-blue-600 px-6 py-3 font-semibold hover:bg-gray-100 transition-colors"
            onClick={() => navigate("/monitoring")}
          >
            View System Status
          </Button>
          <p className="text-xs text-blue-100 mt-2">Based on current stored monitoring data</p>
        </div>
      </div>
    </div>
  );
}
