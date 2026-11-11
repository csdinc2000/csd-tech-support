import { Router } from "express";
import { storage } from "../storage";
import { getStaffAssignmentScope } from "../staff-access";

const router = Router();

// Map a managed RMM device row to the NetworkDevice shape the discovery UI expects.
function deviceToNetworkDevice(device: any) {
  // Risk derived from vulnerabilities + critical posture fields.
  const failureFlags =
    (device.antivirusStatus === "unprotected" ? 1 : 0) +
    (device.firewallStatus === "disabled" ? 1 : 0) +
    (device.patchStatus === "critical" ? 1 : 0) +
    (device.patchStatus === "outdated" ? 1 : 0);
  let riskLevel: "low" | "medium" | "high" | "critical" = "low";
  if (failureFlags >= 3) riskLevel = "critical";
  else if (failureFlags === 2) riskLevel = "high";
  else if (failureFlags === 1) riskLevel = "medium";

  return {
    id: `dev_${device.id}`,
    deviceId: device.id,
    ipAddress: device.ipAddress ?? "",
    macAddress: device.macAddress ?? "",
    hostname: device.name ?? "",
    deviceType: device.type ?? "workstation",
    vendor: "",
    operatingSystem: device.operatingSystem ?? "",
    openPorts: [] as number[],
    lastSeen: device.lastSeen ? new Date(device.lastSeen).toISOString() : new Date().toISOString(),
    status: device.status === "online" ? "online" : "offline",
    vulnerabilities: failureFlags,
    riskLevel,
  };
}

// In-memory tracker for the lifetime of one scan. Completion is persisted to
// the network_scans table; this map is just for the "active" tab.
type ActiveScan = {
  id: number;
  networkRange: string;
  startTime: string;
  endTime: string | null;
  status: "running" | "completed" | "failed";
  progress: number;
  devicesFound: number;
  vulnerabilitiesFound: number;
};
const activeScans = new Map<number, ActiveScan>();

router.get("/devices", async (req, res) => {
  try {
    const scope = await getStaffAssignmentScope(req);
    const devices = (await storage.getDevices()).filter((device) =>
      scope.unrestricted || (device.clientId != null && scope.clientIds.has(device.clientId))
    );
    res.json(devices.map(deviceToNetworkDevice));
  } catch (error) {
    console.error("Error fetching network devices:", error);
    res.status(500).json({ error: "Failed to fetch network devices" });
  }
});

router.get("/scans/active", async (_req, res) => {
  try {
    res.json(Array.from(activeScans.values()));
  } catch (error) {
    console.error("Error fetching active scans:", error);
    res.status(500).json({ error: "Failed to fetch active scans" });
  }
});

router.get("/scans/history", async (_req, res) => {
  try {
    const scans = await storage.getNetworkScans();
    res.json(scans.map(s => ({
      id: `scan_${s.id}`,
      scanId: s.id,
      networkRange: s.networkRange,
      startTime: s.createdAt ? new Date(s.createdAt).toISOString() : new Date().toISOString(),
      endTime: s.completedAt ? new Date(s.completedAt).toISOString() : null,
      status: s.status,
      progress: s.status === "completed" ? 100 : 0,
      devicesFound: s.devicesFound ?? 0,
      vulnerabilitiesFound: 0,
    })));
  } catch (error) {
    console.error("Error fetching scan history:", error);
    res.status(500).json({ error: "Failed to fetch scan history" });
  }
});

router.post("/scans", async (req, res) => {
  try {
    const { networkRange } = req.body ?? {};
    if (!networkRange || typeof networkRange !== "string") {
      res.status(400).json({ error: "Network range is required" });
      return;
    }
    const validRange = /^[\d.]+\/\d{1,2}$/.test(networkRange);
    if (!validRange) {
      res.status(400).json({ error: "Network range must be CIDR notation (e.g. 192.168.1.0/24)" });
      return;
    }

    // Persist the scan row first so it shows in history immediately.
    const scan = await storage.createNetworkScan({
      networkRange,
      status: "running",
      devicesFound: 0,
    });

    const startTime = new Date().toISOString();
    const tracker: ActiveScan = {
      id: scan.id,
      networkRange,
      startTime,
      endTime: null,
      status: "running",
      progress: 0,
      devicesFound: 0,
      vulnerabilitiesFound: 0,
    };
    activeScans.set(scan.id, tracker);

    // Real "scan": enumerate the devices we already track. A future MeshCentral
    // network-probe integration can replace this with an actual nmap/probe call.
    const devices = await storage.getDevices();
    const matched = devices.filter(d => {
      if (!d.ipAddress) return false;
      const prefix = networkRange.split("/")[0].split(".").slice(0, 3).join(".");
      return d.ipAddress.startsWith(prefix + ".");
    });

    // Simulate brief progress so the UI animation runs, then mark completed.
    let progress = 0;
    const tick = setInterval(async () => {
      progress += 25;
      tracker.progress = Math.min(progress, 100);
      tracker.devicesFound = Math.floor(matched.length * (tracker.progress / 100));
      if (tracker.progress >= 100) {
        clearInterval(tick);
        tracker.status = "completed";
        tracker.endTime = new Date().toISOString();
        tracker.devicesFound = matched.length;
        try {
          await storage.updateNetworkScan(scan.id, {
            status: "completed",
            devicesFound: matched.length,
            completedAt: new Date(),
          });
        } catch (err) {
          console.error("Failed to finalize network scan:", err);
        }
        // Keep the active tracker around briefly so the UI catches the final
        // state, then drop it.
        setTimeout(() => activeScans.delete(scan.id), 5000);
      }
    }, 1000);

    res.status(201).json({
      id: `scan_${scan.id}`,
      scanId: scan.id,
      networkRange,
      startTime,
      endTime: null,
      status: "running",
      progress: 0,
      devicesFound: 0,
      vulnerabilitiesFound: 0,
    });
  } catch (error) {
    console.error("Error starting network scan:", error);
    res.status(500).json({ error: "Failed to start network scan" });
  }
});

router.post("/export", async (req, res) => {
  try {
    const scope = await getStaffAssignmentScope(req);
    const devices = (await storage.getDevices()).filter((device) =>
      scope.unrestricted || (device.clientId != null && scope.clientIds.has(device.clientId))
    );
    const rows = devices.map(deviceToNetworkDevice);
    const csvData = [
      "IP Address,MAC Address,Hostname,Device Type,Vendor,Operating System,Status,Risk Level,Vulnerabilities",
      ...rows.map(d =>
        `${d.ipAddress},${d.macAddress},${d.hostname},${d.deviceType},${d.vendor},${d.operatingSystem || ""},${d.status},${d.riskLevel},${d.vulnerabilities}`
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="network_devices.csv"');
    res.send(csvData);
  } catch (error) {
    console.error("Error exporting network devices:", error);
    res.status(500).json({ error: "Failed to export network devices" });
  }
});

export default router;
