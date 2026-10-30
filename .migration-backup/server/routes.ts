import type { Express } from "express";
import express from "express";
import path from "node:path";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setGreetingAudio, clearGreetingAudio, getGreetingAudioInfo } from "./greeting-store";
import networkRoutes from "./routes/network";
import crmPipelineRoutes from "./routes/crm";
import { 
  insertDeviceSchema, insertAlertSchema, insertTicketSchema, 
  insertClientSchema, insertNetworkScanSchema, insertAutomationScriptSchema,
  insertCsdIntakeSchema,
  insertCrmContactSchema, insertCrmLeadSchema, insertCrmJobSchema, insertCrmInteractionSchema,
  insertServiceLogSchema
} from "@shared/schema";
import { z } from "zod";
import { sendTicketNotification, sendDeviceAlert, sendAutomationNotification, sendLeadNotification } from "./slack";
import { getMeshCentralClient } from "./meshcentral";
import { meshCentralService } from "./meshcentral-service";
import { buildTeamviewerLaunchUrl, normalizeTeamviewerId } from "./teamviewer";
import { createSupportCode, redeemSupportCode } from "./support-codes";
import { REMOTE_SUPPORT_WIDGET_HTML } from "./remote-support-widget";
import { emergencyAlertService } from "./emergency-alerts";
import { sendIntakeNotificationEmail, sendCustomerConfirmationEmail } from "./csd-notifications";
import { googleContactsService } from "./google-contacts";
import { isAuthenticated } from "./replit_integrations/auth";
import { rateLimit } from "./security";

// Rate limiter for public, unauthenticated write endpoints (intake form,
// support-code redemption). Generous enough for real customers, tight enough to
// blunt abuse.
const publicWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: "Too many requests. Please wait a minute and try again.",
});

// Public, unauthenticated GET endpoints (e.g. the agent download) — looser than
// the write limiter but still capped so a burst can't be used to hammer the
// upstream MeshCentral server.
const publicReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: "Too many requests. Please wait a minute and try again.",
});

// Zod schemas for the public endpoints.
const intakeSchema = z
  .object({
    full_name: z.string().trim().min(1),
    service_type: z.string().trim().min(1),
    device_type: z.string().trim().min(1),
    problem_description: z.string().trim().min(1),
    mobile_phone: z.string().trim().optional(),
    email: z.string().trim().email().optional().or(z.literal("")),
  })
  .refine((d) => !!(d.mobile_phone && d.mobile_phone.length) || !!(d.email && d.email.length), {
    message: "Either mobile_phone or email is required",
  });

const redeemCodeSchema = z.object({
  code: z.string().trim().min(1),
});
import { ariaService } from "./aria-service";
import { registerAriaMultiCamRoutes } from "./aria-multicam";
import { v4 as uuidv4 } from "uuid";
import { registerBookingRoutes, startSlotLockSweeper } from "./booking/booking-routes";
import { seedBookingDefaults } from "./booking/seed";
import { sendSms, getTwilioFromPhoneNumber, isTwilioConfigured } from "./twilio";
import { getTwilioSettings, updateTwilioSettings } from "./twilio-settings-storage";
import { googleCalendarService } from "./google-calendar";
import { registerBillingRoutes } from "./billing-routes";
import { registerHelpdeskRoutes, enrichNewTicket } from "./routes/helpdesk";
import { registerPttRoutes } from "./ptt";
import { dispatchNewTicketToStaff, recordSmsConsentState, registerStaffDispatchRoutes } from "./staff-dispatch";
import { ensureInvoiceSchema, registerInvoiceRoutes } from "./invoice-routes";

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth/session and the global /api auth gate are configured in index.ts before
  // this runs, so every /api route registered here is protected by default
  // unless its path is on the public allowlist.
  registerBillingRoutes(app);
  registerHelpdeskRoutes(app);
  registerPttRoutes(app);
  registerStaffDispatchRoutes(app);
  await ensureInvoiceSchema();
  registerInvoiceRoutes(app);

  // Health check for Fly.io (and any other uptime monitor). Must be cheap
  // and dependency-free — no DB query, no external API call.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), ts: Date.now() });
  });

  // ---- Technician toolbox: network checker (DNS / HTTP / TCP port) ----
  // Browsers can't resolve DNS, open raw TCP sockets, or ICMP-ping, so the
  // technician network tool calls this endpoint. Read-only, no DB.
  app.post("/api/tech-tools/network-check", async (req, res) => {
    const { default: dns } = await import("node:dns");
    const net = await import("node:net");
    const dnsp = dns.promises;

    // ---- SSRF guard: reject any non-public destination -------------------
    // This endpoint connects to a user-supplied host, so it must never be
    // usable to probe internal/private/cloud-metadata addresses. We resolve
    // the host ONCE, verify every resolved IP is publicly routable, then
    // connect only to that validated IP (closing the DNS-rebinding window).
    const isPublicIpv4 = (ip: string): boolean => {
      const o = ip.split(".").map(Number);
      if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
      const [a, b] = o;
      if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
      if (a === 169 && b === 254) return false; // link-local (incl. 169.254.169.254 metadata)
      if (a === 172 && b >= 16 && b <= 31) return false; // private
      if (a === 192 && b === 168) return false; // private
      if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
      if (a === 192 && b === 0) return false; // 192.0.0.0/24, 192.0.2.0/24 reserved/TEST-NET
      if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
      if (a === 198 && b === 51) return false; // TEST-NET-2
      if (a === 203 && b === 0) return false; // TEST-NET-3
      if (a >= 224) return false; // multicast + reserved (224.0.0.0+)
      return true;
    };
    const isPublicIp = (raw: string): boolean => {
      const fam = net.isIP(raw);
      if (fam === 4) return isPublicIpv4(raw);
      if (fam === 6) {
        const ip = raw.toLowerCase();
        if (ip === "::1" || ip === "::") return false; // loopback / unspecified
        if (ip.startsWith("fe80") || ip.startsWith("fc") || ip.startsWith("fd")) return false; // link-local / ULA
        if (ip.startsWith("ff")) return false; // multicast
        const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
        if (mapped) return isPublicIpv4(mapped[1]);
        if (mapped === null && /::ffff:[0-9a-f:]+$/.test(ip)) return false;
        return true;
      }
      return false;
    };

    const rawHost = String(req.body?.host ?? "").trim();
    const portRaw = req.body?.port;
    if (!rawHost) return res.status(400).json({ error: "Host is required" });

    // Normalize: strip scheme + path so users can paste a full URL.
    let host = rawHost;
    try {
      if (/^https?:\/\//i.test(rawHost)) host = new URL(rawHost).hostname;
      else host = rawHost.replace(/^[a-z]+:\/\//i, "").split("/")[0].split(":")[0];
    } catch {
      host = rawHost;
    }
    host = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    if (!/^[a-zA-Z0-9.\-:_]+$/.test(host)) {
      return res.status(400).json({ error: "That doesn't look like a valid hostname or IP." });
    }
    if (/^localhost$/i.test(host)) {
      return res.status(400).json({ error: "Refusing to scan localhost or internal addresses." });
    }

    const result: any = { host, checkedAt: Date.now() };

    // DNS resolution (or accept an IP literal), with timing.
    const dnsStart = Date.now();
    let resolved: { address: string; family: number }[] = [];
    if (net.isIP(host)) {
      resolved = [{ address: host, family: net.isIP(host) }];
      result.dns = { ok: true, ms: 0, addresses: resolved.map((a) => ({ address: a.address, family: `IPv${a.family}` })) };
    } else {
      try {
        resolved = await dnsp.lookup(host, { all: true });
        result.dns = {
          ok: true,
          ms: Date.now() - dnsStart,
          addresses: resolved.map((a) => ({ address: a.address, family: `IPv${a.family}` })),
        };
      } catch (e: any) {
        result.dns = { ok: false, ms: Date.now() - dnsStart, error: e?.code || e?.message || "DNS lookup failed" };
      }
    }

    // SSRF gate: refuse if anything resolves to a non-public address.
    if (resolved.length > 0 && !resolved.every((a) => isPublicIp(a.address))) {
      return res.status(400).json({
        error: "Refusing to scan a private, loopback, or internal address. Only public hosts are allowed.",
      });
    }

    // All connections go to this validated public IP (no re-resolution).
    const targetIp = resolved.find((a) => isPublicIp(a.address))?.address;

    // Raw TCP reachability probe against the already-validated IP.
    const tcpProbe = (ip: string, port: number, timeoutMs = 6000) =>
      new Promise<{ open: boolean; ms: number; error?: string }>((resolve) => {
        const start = Date.now();
        const socket = new net.Socket();
        let done = false;
        const finish = (open: boolean, error?: string) => {
          if (done) return;
          done = true;
          try { socket.destroy(); } catch {}
          resolve({ open, ms: Date.now() - start, ...(error ? { error } : {}) });
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false, "Connection timed out (port closed or filtered)"));
        socket.once("error", (err: any) => finish(false, err?.code || "Connection refused"));
        try { socket.connect(port, ip); } catch (e: any) { finish(false, e?.message || "Could not connect"); }
      });

    // Web-server reachability: test HTTPS (443) then HTTP (80) on the IP.
    if (targetIp) {
      const httpsProbe = await tcpProbe(targetIp, 443);
      if (httpsProbe.open) {
        result.http = { ok: true, ms: httpsProbe.ms, scheme: "https" };
      } else {
        const httpProbe = await tcpProbe(targetIp, 80);
        result.http = httpProbe.open
          ? { ok: true, ms: httpProbe.ms, scheme: "http" }
          : { ok: false, ms: httpProbe.ms, error: "No web server responded on port 443 or 80" };
      }
    }

    // Optional explicit TCP port check.
    const port = Number(portRaw);
    if (portRaw !== undefined && portRaw !== null && String(portRaw).trim() !== "") {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        result.port = { ok: false, error: "Port must be a whole number between 1 and 65535." };
      } else if (!targetIp) {
        result.port = { ok: false, port, error: "Could not resolve host to a public address." };
      } else {
        const probe = await tcpProbe(targetIp, port);
        result.port = { ok: probe.open, port, ms: probe.ms, ...(probe.error ? { error: probe.error } : {}) };
      }
    }

    res.json(result);
  });

  app.get("/api/tech-tools/windows-optimization-script", (_req, res) => {
    const scriptPath = path.resolve(process.cwd(), "scripts", "Optimize-WindowsEndpoint.ps1");
    res.download(scriptPath, "Optimize-WindowsEndpoint.ps1", (error) => {
      if (error && !res.headersSent) {
        console.error("[tech-tools] Windows optimization script download failed:", error);
        res.status(500).json({ error: "Windows optimization script is unavailable" });
      }
    });
  });

  // Users list (for helpdesk assignment dropdowns)
  app.get("/api/users", async (_req, res) => {
    try {
      const list = await storage.getUsers();
      res.json(list.map(({ password, ...u }) => u));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Dashboard metrics
  app.get("/api/dashboard/metrics", async (req, res) => {
    try {
      const devices = await storage.getDevices();
      const alerts = await storage.getActiveAlerts();
      const tickets = await storage.getOpenTickets();
      
      const onlineDevices = devices.filter(d => d.status === "online").length;
      const totalDevices = devices.length;
      const uptime = totalDevices > 0 ? Math.round((onlineDevices / totalDevices) * 100 * 10) / 10 : 100;
      
      res.json({
        totalDevices,
        activeAlerts: alerts.length,
        openTickets: tickets.length,
        uptime,
        onlineDevices,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch dashboard metrics" });
    }
  });

  // Device endpoints
  app.get("/api/devices", async (req, res) => {
    try {
      const devices = await storage.getDevices();
      res.json(devices);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch devices" });
    }
  });

  app.get("/api/devices/:id", async (req, res) => {
    try {
      const device = await storage.getDevice(parseInt(req.params.id));
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.json(device);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch device" });
    }
  });

  app.post("/api/devices", async (req, res) => {
    try {
      const deviceData = insertDeviceSchema.parse(req.body);
      const device = await storage.createDevice(deviceData);
      res.status(201).json(device);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid device data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create device" });
    }
  });

  app.put("/api/devices/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const device = await storage.updateDevice(id, req.body);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.json(device);
    } catch (error) {
      res.status(500).json({ error: "Failed to update device" });
    }
  });

  app.delete("/api/devices/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteDevice(id);
      if (!deleted) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete device" });
    }
  });

  // Alert endpoints
  app.get("/api/alerts", async (req, res) => {
    try {
      const alerts = await storage.getAlerts();
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch alerts" });
    }
  });

  app.get("/api/alerts/active", async (req, res) => {
    try {
      const alerts = await storage.getActiveAlerts();
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch active alerts" });
    }
  });

  app.post("/api/alerts", async (req, res) => {
    try {
      const alertData = insertAlertSchema.parse(req.body);
      const alert = await storage.createAlert(alertData);

      // Emergency-alert dispatch (SMS/email/Slack cascade) — record any
      // failure on the response so callers know the alert was stored but
      // notifications didn't go out.
      const warnings: string[] = [];
      try {
        await emergencyAlertService.processAlert({
          id: alert.id,
          title: alert.title,
          description: alert.description || '',
          severity: alert.severity,
          category: alert.category || 'general',
          deviceId: alert.deviceId ?? undefined,
          clientId: alert.clientId ?? undefined,
          isEmergency: alert.isEmergency || false,
          businessImpact: alert.businessImpact || 'unknown'
        });
      } catch (emergencyError: any) {
        const msg = emergencyError?.message ?? String(emergencyError);
        console.error("Emergency alert dispatch failed:", msg);
        warnings.push(`Emergency notification dispatch failed: ${msg}`);
      }

      res.status(201).json(warnings.length ? { ...alert, warnings } : alert);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid alert data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create alert" });
    }
  });

  app.put("/api/alerts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const alert = await storage.updateAlert(id, req.body);
      if (!alert) {
        return res.status(404).json({ error: "Alert not found" });
      }
      res.json(alert);
    } catch (error) {
      res.status(500).json({ error: "Failed to update alert" });
    }
  });

  // Ticket endpoints
  app.get("/api/tickets", async (req, res) => {
    try {
      const tickets = await storage.getTickets();
      res.json(tickets);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tickets" });
    }
  });

  app.get("/api/tickets/open", async (req, res) => {
    try {
      const tickets = await storage.getOpenTickets();
      res.json(tickets);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch open tickets" });
    }
  });

  app.get("/api/tickets/:id", async (req, res) => {
    try {
      const ticket = await storage.getTicket(parseInt(req.params.id));
      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }
      res.json(ticket);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch ticket" });
    }
  });

  app.post("/api/tickets", async (req, res) => {
    try {
      const ticketData = insertTicketSchema.parse(req.body);
      const ticket = await storage.createTicket(ticketData);

      // Helpdesk pipeline: assign ticket #, access token, defaults,
      // filter routing, SLA due date, autoresponder, staff notice, activity log.
      const enriched = await enrichNewTicket(ticket);

      // Send Slack notification for new ticket
      try {
        const client = ticketData.clientId ? await storage.getClient(ticketData.clientId) : null;
        await sendTicketNotification(enriched, client);
      } catch (slackError) {
        console.warn("Failed to send Slack notification for ticket:", slackError);
      }

      res.status(201).json(enriched);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid ticket data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create ticket" });
    }
  });

  app.put("/api/tickets/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const ticket = await storage.updateTicket(id, req.body);
      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }
      res.json(ticket);
    } catch (error) {
      res.status(500).json({ error: "Failed to update ticket" });
    }
  });

  // Client endpoints
  app.get("/api/clients", async (req, res) => {
    try {
      const clients = await storage.getClients();
      res.json(clients);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch clients" });
    }
  });

  app.get("/api/clients/:id", async (req, res) => {
    try {
      const client = await storage.getClient(parseInt(req.params.id));
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      res.json(client);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch client" });
    }
  });

  app.post("/api/clients", async (req, res) => {
    try {
      const clientData = insertClientSchema.parse(req.body);
      const client = await storage.createClient(clientData);
      res.status(201).json(client);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid client data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create client" });
    }
  });

  app.put("/api/clients/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const client = await storage.updateClient(id, req.body);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      res.json(client);
    } catch (error) {
      res.status(500).json({ error: "Failed to update client" });
    }
  });

  // Network scan endpoints
  app.get("/api/network-scans", async (req, res) => {
    try {
      const scans = await storage.getNetworkScans();
      res.json(scans);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch network scans" });
    }
  });

  app.post("/api/network-scans", async (req, res) => {
    try {
      const scanData = insertNetworkScanSchema.parse(req.body);
      const scan = await storage.createNetworkScan(scanData);
      res.status(201).json(scan);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid scan data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create network scan" });
    }
  });

  // Automation script endpoints
  app.get("/api/automation-scripts", async (req, res) => {
    try {
      const scripts = await storage.getAutomationScripts();
      res.json(scripts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch automation scripts" });
    }
  });

  app.get("/api/automation-scripts/:id", async (req, res) => {
    try {
      const script = await storage.getAutomationScript(parseInt(req.params.id));
      if (!script) {
        return res.status(404).json({ error: "Script not found" });
      }
      res.json(script);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch script" });
    }
  });

  app.post("/api/automation-scripts", async (req, res) => {
    try {
      const scriptData = insertAutomationScriptSchema.parse(req.body);
      const script = await storage.createAutomationScript(scriptData);
      res.status(201).json(script);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.warn("[automation-scripts] validation failed:", error.errors);
        return res.status(400).json({ error: "Invalid script data", details: error.errors });
      }
      console.error("[automation-scripts] create failed:", error);
      res.status(500).json({ error: "Failed to create script" });
    }
  });

  app.put("/api/automation-scripts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const script = await storage.updateAutomationScript(id, req.body);
      if (!script) {
        return res.status(404).json({ error: "Script not found" });
      }
      res.json(script);
    } catch (error) {
      res.status(500).json({ error: "Failed to update script" });
    }
  });

  // Real-time monitoring — returns the most recent telemetry from each device
  // row. Values are whatever the agent last reported (0 / null if no agent).
  // Active alerts per device are joined in for the UI.
  app.get("/api/monitoring/realtime", async (req, res) => {
    try {
      const [devices, activeAlerts] = await Promise.all([
        storage.getDevices(),
        storage.getActiveAlerts(),
      ]);
      const alertsByDevice = new Map<number, typeof activeAlerts>();
      for (const a of activeAlerts) {
        if (a.deviceId == null) continue;
        const list = alertsByDevice.get(a.deviceId) ?? [];
        list.push(a);
        alertsByDevice.set(a.deviceId, list);
      }
      const monitoringData = devices.map(device => ({
        deviceId: device.id,
        deviceName: device.name,
        status: device.status,
        cpuUsage: device.cpuUsage ?? null,
        memoryUsage: device.memoryUsage ?? null,
        diskUsage: device.diskUsage ?? null,
        networkLatency: device.networkLatency ?? null,
        uptimeHours: device.uptimeHours ?? null,
        antivirusStatus: device.antivirusStatus ?? "unknown",
        firewallStatus: device.firewallStatus ?? "unknown",
        patchStatus: device.patchStatus ?? "unknown",
        backupStatus: device.backupStatus ?? "unknown",
        lastSeen: device.lastSeen,
        alerts: alertsByDevice.get(device.id) ?? [],
      }));
      res.json(monitoringData);
    } catch (error) {
      console.error("monitoring/realtime error:", error);
      res.status(500).json({ error: "Failed to fetch monitoring data" });
    }
  });

  // Patch management — patches surface what device agents have reported into
  // device_patches. Empty until a MeshCentral agent posts inventory.
  app.get("/api/patches", async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const deviceId = req.query.deviceId ? parseInt(String(req.query.deviceId), 10) : undefined;
      const patches = await storage.getDevicePatches({ status, deviceId });
      // Group identical KBs across devices so the UI can show one row per patch.
      const byKb = new Map<string, any>();
      for (const p of patches) {
        const existing = byKb.get(p.kbId);
        if (existing) {
          if (p.deviceId != null) existing.deviceIds.push(p.deviceId);
        } else {
          byKb.set(p.kbId, {
            id: p.kbId,
            title: p.title,
            description: p.description,
            severity: p.severity,
            category: p.category,
            size: p.sizeBytes,
            installTime: p.installTimeMinutes,
            requiresReboot: p.requiresReboot,
            status: p.status,
            releaseDate: p.releaseDate,
            deviceIds: p.deviceId != null ? [p.deviceId] : [],
          });
        }
      }
      res.json(Array.from(byKb.values()));
    } catch (error) {
      console.error("/api/patches error:", error);
      res.status(500).json({ error: "Failed to fetch patches" });
    }
  });

  app.post("/api/patches/install", async (req, res) => {
    try {
      const { patchIds, deviceIds, scheduleTime } = req.body ?? {};
      if (!Array.isArray(patchIds) || patchIds.length === 0) {
        return res.status(400).json({ error: "patchIds (array) is required" });
      }
      if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
        return res.status(400).json({ error: "deviceIds (array) is required" });
      }
      const scheduledFor = scheduleTime ? new Date(scheduleTime) : new Date();
      const job = await storage.createPatchJob({
        jobType: "install",
        patchIds: patchIds.join(","),
        deviceIds: deviceIds.join(","),
        status: scheduleTime && scheduledFor > new Date() ? "scheduled" : "running",
        scheduledFor,
        createdBy: null,
      } as any);
      // Mark the targeted patches as "installing" so the UI reflects intent.
      for (const did of deviceIds) {
        const existing = await storage.getDevicePatches({ deviceId: Number(did) });
        for (const dp of existing) {
          if (patchIds.includes(dp.kbId)) {
            await storage.updateDevicePatch(dp.id, { status: "installing" });
          }
        }
      }
      // Fire-and-forget Slack — bubble up failures via console only.
      sendAutomationNotification(
        { name: "Patch Installation", type: "patch-install" } as any,
        "success",
        `Queued ${patchIds.length} patch(es) on ${deviceIds.length} device(s)`,
      ).catch(e => console.warn("Slack notification failed:", e?.message ?? e));
      res.json({
        installationId: job.id,
        patchIds,
        deviceIds,
        status: job.status,
        scheduledTime: job.scheduledFor,
      });
    } catch (error) {
      console.error("/api/patches/install error:", error);
      res.status(500).json({ error: "Failed to install patches" });
    }
  });

  app.post("/api/patches/download", async (req, res) => {
    try {
      const { patchIds, deviceIds = [] } = req.body ?? {};
      if (!Array.isArray(patchIds) || patchIds.length === 0) {
        return res.status(400).json({ error: "patchIds (array) is required" });
      }
      const job = await storage.createPatchJob({
        jobType: "download",
        patchIds: patchIds.join(","),
        deviceIds: Array.isArray(deviceIds) ? deviceIds.join(",") : "",
        status: "running",
        scheduledFor: new Date(),
        createdBy: null,
      } as any);
      res.json({
        downloadId: job.id,
        patchIds,
        status: job.status,
        progress: job.progress ?? 0,
      });
    } catch (error) {
      console.error("/api/patches/download error:", error);
      res.status(500).json({ error: "Failed to download patches" });
    }
  });

  app.get("/api/patch-policies", async (_req, res) => {
    try {
      const policies = await storage.getPatchPolicies();
      res.json(policies.map(p => ({
        ...p,
        severityFilter: (p.severityFilter ?? "").split(",").filter(Boolean),
        excludePatches: (p.excludePatches ?? "").split(",").filter(Boolean),
      })));
    } catch (error) {
      console.error("/api/patch-policies error:", error);
      res.status(500).json({ error: "Failed to fetch patch policies" });
    }
  });

  app.post("/api/patch-policies", async (req, res) => {
    try {
      const body = req.body ?? {};
      const policy = await storage.createPatchPolicy({
        name: String(body.name ?? "").trim() || "New Policy",
        autoInstall: !!body.autoInstall,
        maintenanceWindow: body.maintenanceWindow ?? "02:00-06:00",
        severityFilter: Array.isArray(body.severityFilter) ? body.severityFilter.join(",") : (body.severityFilter ?? "critical"),
        excludePatches: Array.isArray(body.excludePatches) ? body.excludePatches.join(",") : (body.excludePatches ?? ""),
        testGroupPercentage: typeof body.testGroupPercentage === "number" ? body.testGroupPercentage : 10,
        isActive: body.isActive !== false,
      });
      res.status(201).json(policy);
    } catch (error) {
      console.error("POST /api/patch-policies error:", error);
      res.status(500).json({ error: "Failed to create patch policy" });
    }
  });

  app.put("/api/patch-policies/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const body = req.body ?? {};
      const update: any = { ...body };
      if (Array.isArray(body.severityFilter)) update.severityFilter = body.severityFilter.join(",");
      if (Array.isArray(body.excludePatches)) update.excludePatches = body.excludePatches.join(",");
      const policy = await storage.updatePatchPolicy(id, update);
      if (!policy) return res.status(404).json({ error: "Patch policy not found" });
      res.json(policy);
    } catch (error) {
      res.status(500).json({ error: "Failed to update patch policy" });
    }
  });

  app.delete("/api/patch-policies/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await storage.deletePatchPolicy(id);
      if (!ok) return res.status(404).json({ error: "Patch policy not found" });
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete patch policy" });
    }
  });

  // Script execution — runs the stored script through MeshCentral on the
  // requested device (or all devices that match the script's target type).
  // Without a configured MeshCentral, the request is rejected with 503 rather
  // than fabricating success.
  app.post("/api/automation-scripts/:id/execute", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const script = await storage.getAutomationScript(id);
      if (!script) {
        return res.status(404).json({ error: "Script not found" });
      }
      if (!meshCentralService.isConfigured()) {
        return res.status(503).json({
          error: "MeshCentral is not configured (MESHCENTRAL_URL missing); cannot execute scripts on devices.",
        });
      }

      const { deviceIds } = req.body ?? {};
      const targets: number[] = Array.isArray(deviceIds) ? deviceIds.map(Number).filter(Number.isFinite) : [];
      if (targets.length === 0) {
        return res.status(400).json({ error: "deviceIds (array) is required" });
      }

      const meshClient = getMeshCentralClient();
      if (!meshClient) {
        return res.status(503).json({ error: "MeshCentral client unavailable" });
      }

      const startTime = new Date();
      const results: { deviceId: number; status: string; output: string }[] = [];
      for (const deviceId of targets) {
        const device = await storage.getDevice(deviceId);
        if (!device?.meshNodeId) {
          results.push({ deviceId, status: "failed", output: "Device has no MeshCentral node id" });
          continue;
        }
        try {
          const cmdResult = await meshClient.executeCommand(device.meshNodeId, script.scriptContent);
          const ok = cmdResult && !cmdResult.error;
          results.push({
            deviceId,
            status: ok ? "completed" : "failed",
            output: ok ? "Dispatched to device" : (cmdResult?.error ?? "Unknown error"),
          });
        } catch (err: any) {
          results.push({ deviceId, status: "failed", output: err?.message ?? String(err) });
        }
      }
      const endTime = new Date();
      const anyFailed = results.some(r => r.status === "failed");
      const allFailed = results.every(r => r.status === "failed");

      // Best-effort Slack notification — never blocks the response.
      sendAutomationNotification(
        script,
        allFailed ? "failure" : "success",
        results.map(r => `Device ${r.deviceId}: ${r.status}`).join("; "),
      ).catch(e => console.warn("Slack notification failed:", e?.message ?? e));

      res.json({
        scriptId: id,
        status: allFailed ? "failed" : anyFailed ? "partial" : "completed",
        results,
        startTime,
        endTime,
      });
    } catch (error: any) {
      console.error("Script execution error:", error);
      res.status(500).json({ error: error?.message ?? "Failed to execute script" });
    }
  });

  // Remote access session endpoints
  app.get("/api/remote-sessions/active", async (req, res) => {
    try {
      const sessions = await storage.getActiveRemoteSessions();
      res.json(sessions);
    } catch (error) {
      console.error("Failed to fetch active sessions:", error);
      res.status(500).json({ error: "Failed to fetch active sessions" });
    }
  });

  // Start a MeshCentral session
  app.post("/api/remote-sessions/start", async (req, res) => {
    try {
      const { deviceId, sessionType = "desktop", recording = true, sourceType, sourceId } = req.body;

      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      if (device.status !== "online") {
        return res.status(400).json({ error: "Device is offline" });
      }
      if (!device.meshNodeId) {
        return res.status(400).json({
          error: "MeshCentral is not configured for this device",
          hint: "Set the device's meshNodeId or use the TeamViewer launcher instead.",
        });
      }

      const meshClient = getMeshCentralClient();
      let sessionUrl: string | null = null;

      if (meshClient) {
        try {
          await meshClient.authenticate();
          switch (sessionType) {
            case "desktop":
              sessionUrl = await meshClient.startRemoteDesktop(device.meshNodeId, recording);
              break;
            case "terminal":
              sessionUrl = await meshClient.startTerminal(device.meshNodeId);
              break;
            case "files":
              sessionUrl = await meshClient.startFileManager(device.meshNodeId);
              break;
            case "chat":
              await meshClient.sendChatMessage(
                device.meshNodeId,
                "A technician has initiated a chat session.",
              );
              sessionUrl = `${process.env.MESHCENTRAL_URL}/chat/${device.meshNodeId}`;
              break;
          }
        } catch (meshError) {
          console.warn("MeshCentral session failed:", meshError);
        }
      }

      if (!sessionUrl) {
        return res.status(502).json({ error: "MeshCentral did not return a session URL" });
      }

      const session = await storage.createRemoteSession({
        deviceId: device.id,
        clientId: device.clientId ?? null,
        userId: (req as any).user?.id ?? null,
        provider: "meshcentral",
        sessionType,
        meshSessionId: sessionUrl,
        sourceType: sourceType ?? "manual",
        sourceId: sourceId ?? null,
        status: "active",
        recordingEnabled: recording,
        userAgent: req.get("user-agent") ?? null,
        clientIpAddress: req.ip ?? null,
      } as any);

      res.json({
        id: session.id,
        deviceId: device.id,
        deviceName: device.name,
        provider: "meshcentral",
        sessionType,
        sessionUrl,
        launchUrl: sessionUrl,
        recordingEnabled: recording,
        startTime: session.startTime,
      });
    } catch (error) {
      console.error("Failed to start MeshCentral session:", error);
      res.status(500).json({ error: "Failed to start remote session" });
    }
  });

  // Start a TeamViewer session via deep-link
  app.post("/api/remote-sessions/teamviewer/start", async (req, res) => {
    try {
      const { deviceId, sessionType = "desktop", sourceType, sourceId, password } = req.body;

      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      const tvId = normalizeTeamviewerId(device.teamviewerId);
      if (!tvId) {
        return res.status(400).json({
          error: "Device has no TeamViewer ID configured",
          code: "TEAMVIEWER_ID_MISSING",
        });
      }

      const launchUrl = buildTeamviewerLaunchUrl({
        teamviewerId: tvId,
        sessionType: sessionType === "files" ? "filetransfer" : "control",
        password,
      });

      const session = await storage.createRemoteSession({
        deviceId: device.id,
        clientId: device.clientId ?? null,
        userId: (req as any).user?.id ?? null,
        provider: "teamviewer",
        sessionType,
        teamviewerSessionCode: tvId,
        teamviewerLaunchUrl: launchUrl,
        sourceType: sourceType ?? "manual",
        sourceId: sourceId ?? null,
        status: "active",
        recordingEnabled: false,
        userAgent: req.get("user-agent") ?? null,
        clientIpAddress: req.ip ?? null,
      } as any);

      res.json({
        id: session.id,
        deviceId: device.id,
        deviceName: device.name,
        provider: "teamviewer",
        sessionType,
        launchUrl,
        sessionUrl: launchUrl,
        teamviewerId: tvId,
        startTime: session.startTime,
      });
    } catch (error) {
      console.error("Failed to start TeamViewer session:", error);
      res.status(500).json({ error: "Failed to start TeamViewer session" });
    }
  });

  // --- Phone-to-remote support codes ---------------------------------------
  // A technician generates a short, single-use 6-digit code for a device; the
  // customer types it into the public Remote Support widget (served below at
  // /remote-support) to be dropped straight into a MeshCentral session on
  // remote.computersystemsdepot.com. See server/support-codes.ts for the lifecycle.

  // Public: the customer-facing widget page. Served same-origin so its
  // redeem-code fetch needs no CORS. Embedded into the WordPress site via an
  // iframe (the [csd_remote_support] shortcode), so allow framing from there.
  app.get(["/remote-support", "/support"], (_req, res) => {
    res
      .type("html")
      .setHeader(
        "Content-Security-Policy",
        "frame-ancestors 'self' https://*.computersystemsdepot.com https://computersystemsdepot.com",
      );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(REMOTE_SUPPORT_WIDGET_HTML);
  });

  // Technician-only: mint a code for a device's MeshCentral session.
  app.post("/api/support/generate-code", isAuthenticated, async (req, res) => {
    try {
      const { deviceId, sessionType = "desktop" } = req.body ?? {};

      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      if (!device.meshNodeId) {
        return res.status(400).json({
          error: "MeshCentral is not configured for this device",
          hint: "Set the device's meshNodeId before generating a support code.",
        });
      }

      const redirectUrl = await meshCentralService.createRemoteSession(
        device.meshNodeId,
        sessionType,
      );
      if (!redirectUrl) {
        return res.status(502).json({ error: "MeshCentral did not return a session URL" });
      }

      const record = createSupportCode({
        redirectUrl,
        deviceId: device.id,
        meshNodeId: device.meshNodeId,
        sessionType,
      });

      res.json({
        code: record.code,
        deviceId: device.id,
        deviceName: device.name,
        sessionType: record.sessionType,
        expiresAt: new Date(record.expiresAt).toISOString(),
      });
    } catch (error) {
      console.error("Failed to generate support code:", error);
      res.status(500).json({ error: "Failed to generate support code" });
    }
  });

  // Public: the customer-facing widget redeems a code for a redirect URL.
  // Intentionally vague on failure so the 6-digit space can't be probed.
  app.post("/api/support/redeem-code", publicWriteLimiter, async (req, res) => {
    try {
      const parsed = redeemCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          message: "A valid code is required.",
        });
      }
      const clientKey = req.ip || req.get("x-forwarded-for") || "unknown";
      const result = redeemSupportCode(parsed.data.code, clientKey);

      if (!result.ok) {
        if (result.reason === "throttled") {
          return res.status(429).json({
            ok: false,
            message: "Too many attempts. Please wait a minute, then call 954-637-7300.",
          });
        }
        return res.status(200).json({
          ok: false,
          message: "That code wasn't recognized or has expired. Please call us at 954-637-7300.",
        });
      }

      // Record the redemption as an active session for audit/visibility.
      try {
        await storage.createRemoteSession({
          deviceId: result.record.deviceId ?? null,
          provider: "meshcentral",
          sessionType: result.record.sessionType,
          meshSessionId: result.record.redirectUrl,
          sourceType: "support_code",
          status: "active",
          recordingEnabled: true,
          userAgent: req.get("user-agent") ?? null,
          clientIpAddress: req.ip ?? null,
        } as any);
      } catch (sessionError) {
        // Don't block the customer's connection on a bookkeeping failure.
        console.warn("Could not record support-code session:", sessionError);
      }

      res.json({ ok: true, redirectUrl: result.record.redirectUrl });
    } catch (error) {
      console.error("Failed to redeem support code:", error);
      res.status(500).json({ ok: false, message: "Something went wrong. Please call 954-637-7300." });
    }
  });

  app.post("/api/remote-sessions/:id/end", async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id);
      if (Number.isNaN(sessionId)) {
        return res.status(400).json({ error: "Invalid session id" });
      }
      const session = await storage.endRemoteSession(sessionId, {
        status: req.body?.status ?? "ended",
      });
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json(session);
    } catch (error) {
      console.error("Failed to end session:", error);
      res.status(500).json({ error: "Failed to end session" });
    }
  });

  app.delete("/api/remote-sessions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid session id" });
      }
      const deleted = await storage.deleteRemoteSession(id);
      if (!deleted) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete session:", error);
      res.status(500).json({ error: "Failed to delete session" });
    }
  });

  app.get("/api/remote-sessions/recordings", async (_req, res) => {
    try {
      const recordings = await storage.getRemoteSessionRecordings();
      const devices = await storage.getDevices();
      const deviceById = new Map(devices.map(d => [d.id, d]));
      res.json(recordings.map(r => ({
        id: r.id,
        deviceId: r.deviceId,
        deviceName: deviceById.get(r.deviceId)?.name ?? `Device #${r.deviceId}`,
        sessionType: r.sessionType,
        provider: r.provider,
        startTime: r.startTime,
        endTime: r.endTime,
        duration: r.duration,
        recordingPath: r.recordingPath,
      })));
    } catch (error) {
      console.error("/api/remote-sessions/recordings error:", error);
      res.status(500).json({ error: "Failed to fetch session recordings" });
    }
  });

  // Emergency alert management
  app.post("/api/alerts/:id/acknowledge", async (req, res) => {
    try {
      const alertId = parseInt(req.params.id);
      const { userId } = req.body;
      
      const alert = await storage.updateAlert(alertId, {
        status: 'acknowledged',
        acknowledgedBy: userId,
        acknowledgedAt: new Date()
      });

      if (alert) {
        res.json({ message: "Alert acknowledged successfully" });
      } else {
        res.status(404).json({ error: "Alert not found" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to acknowledge alert" });
    }
  });

  app.get("/api/emergency-contacts", async (_req, res) => {
    try {
      const contacts = await storage.getEmergencyContacts();
      res.json(contacts);
    } catch (error) {
      console.error("/api/emergency-contacts error:", error);
      res.status(500).json({ error: "Failed to fetch emergency contacts" });
    }
  });

  app.get("/api/emergency-contacts/:clientId", async (req, res) => {
    try {
      const clientId = parseInt(req.params.clientId, 10);
      if (Number.isNaN(clientId)) {
        return res.status(400).json({ error: "Invalid clientId" });
      }
      const contacts = await storage.getEmergencyContacts(clientId);
      res.json(contacts);
    } catch (error) {
      console.error("/api/emergency-contacts/:clientId error:", error);
      res.status(500).json({ error: "Failed to fetch emergency contacts" });
    }
  });

  app.post("/api/emergency-contacts", async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body.clientId || !body.name || !body.phone || !body.email) {
        return res.status(400).json({ error: "clientId, name, phone, email are required" });
      }
      const contact = await storage.createEmergencyContact({
        clientId: Number(body.clientId),
        name: String(body.name),
        role: body.role ?? null,
        phone: String(body.phone),
        email: String(body.email),
        priority: typeof body.priority === "number" ? body.priority : 1,
        availableHours: body.availableHours ?? "24/7",
        notificationMethods: body.notificationMethods ?? "phone,sms,email",
        isActive: body.isActive !== false,
      });
      res.status(201).json(contact);
    } catch (error) {
      console.error("POST /api/emergency-contacts error:", error);
      res.status(500).json({ error: "Failed to create emergency contact" });
    }
  });

  app.put("/api/emergency-contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const contact = await storage.updateEmergencyContact(id, req.body ?? {});
      if (!contact) return res.status(404).json({ error: "Emergency contact not found" });
      res.json(contact);
    } catch (error) {
      res.status(500).json({ error: "Failed to update emergency contact" });
    }
  });

  app.delete("/api/emergency-contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await storage.deleteEmergencyContact(id);
      if (!ok) return res.status(404).json({ error: "Emergency contact not found" });
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete emergency contact" });
    }
  });

  // MeshCentral integration endpoints — backed by a real, externally-hosted
  // MeshCentral server (see docs/meshcentral-setup.md). When MESHCENTRAL_URL
  // is not set, /status reports not_configured and /devices returns [].
  app.get("/api/meshcentral/status", async (req, res) => {
    try {
      if (!meshCentralService.isConfigured()) {
        return res.json({
          status: "not_configured",
          isConfigured: false,
          url: null,
          message: "MeshCentral is not configured. Set MESHCENTRAL_URL plus credentials.",
        });
      }
      const meshClient = getMeshCentralClient();
      const isAuthenticated = meshClient ? await meshClient.authenticate() : false;
      const reason = meshClient?.getLastAuthError();
      const unreachable = !isAuthenticated && !!reason && /unreachable/i.test(reason);
      res.json({
        status: isAuthenticated ? "connected" : unreachable ? "unreachable" : "authentication_failed",
        isConfigured: true,
        url: process.env.MESHCENTRAL_URL || null,
        message: isAuthenticated ? undefined : reason,
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        message: "Failed to check MeshCentral status",
      });
    }
  });

  app.get("/api/meshcentral/devices", async (req, res) => {
    try {
      const devices = await meshCentralService.getDevices();
      res.json(devices);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch MeshCentral devices" });
    }
  });

  // Pull machines from the configured MeshCentral server into the local devices
  // table so Device Management, Monitoring and Network Discovery show them.
  app.post("/api/meshcentral/sync", async (req, res) => {
    try {
      const result = await meshCentralService.syncDevices();
      if (!result.configured) {
        return res.status(503).json({
          error: "MeshCentral is not configured (set MESHCENTRAL_URL plus credentials).",
        });
      }
      if (result.error) {
        return res.status(502).json({ error: result.error });
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to sync MeshCentral devices" });
    }
  });

  // Helpdesk integrations (Zendesk, Freshdesk, ServiceNow, etc.)
  app.get("/api/helpdesk/integrations", async (req, res) => {
    try {
      const clientId = req.query.clientId ? parseInt(String(req.query.clientId), 10) : undefined;
      const integrations = await storage.getHelpdeskIntegrations(clientId);
      res.json(integrations.map(i => ({
        id: i.id,
        clientId: i.clientId,
        type: i.integrationType,
        status: i.syncStatus,
        isActive: i.isActive,
        syncEnabled: i.syncEnabled,
        lastSync: i.lastSyncAt,
        syncedTickets: i.syncedTicketsCount ?? 0,
        apiEndpoint: i.apiEndpoint,
        authMethod: i.authMethod,
      })));
    } catch (error) {
      console.error("/api/helpdesk/integrations error:", error);
      res.status(500).json({ error: "Failed to fetch helpdesk integrations" });
    }
  });

  app.post("/api/helpdesk/integrations", async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body.integrationType) {
        return res.status(400).json({ error: "integrationType is required" });
      }
      const integration = await storage.createHelpdeskIntegration({
        clientId: body.clientId ?? null,
        integrationType: body.integrationType,
        apiEndpoint: body.apiEndpoint ?? null,
        authMethod: body.authMethod ?? null,
        isActive: body.isActive !== false,
        syncEnabled: body.syncEnabled !== false,
        syncStatus: body.syncStatus ?? "pending",
      });
      res.status(201).json(integration);
    } catch (error) {
      console.error("POST /api/helpdesk/integrations error:", error);
      res.status(500).json({ error: "Failed to create helpdesk integration" });
    }
  });

  app.put("/api/helpdesk/integrations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const integration = await storage.updateHelpdeskIntegration(id, req.body ?? {});
      if (!integration) return res.status(404).json({ error: "Integration not found" });
      res.json(integration);
    } catch (error) {
      res.status(500).json({ error: "Failed to update integration" });
    }
  });

  app.delete("/api/helpdesk/integrations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await storage.deleteHelpdeskIntegration(id);
      if (!ok) return res.status(404).json({ error: "Integration not found" });
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete integration" });
    }
  });

  // Additional missing endpoints
  app.delete("/api/alerts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const alert = await storage.getAlert(id);
      if (!alert) {
        return res.status(404).json({ error: "Alert not found" });
      }
      // Mark alert as resolved instead of deleting
      const updatedAlert = await storage.updateAlert(id, { status: "resolved", resolvedAt: new Date() });
      res.json(updatedAlert);
    } catch (error) {
      res.status(500).json({ error: "Failed to resolve alert" });
    }
  });

  app.delete("/api/tickets/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const ticket = await storage.getTicket(id);
      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }
      // Mark ticket as closed instead of deleting
      const updatedTicket = await storage.updateTicket(id, { status: "closed", updatedAt: new Date() });
      res.json(updatedTicket);
    } catch (error) {
      res.status(500).json({ error: "Failed to close ticket" });
    }
  });

  app.delete("/api/clients/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const client = await storage.getClient(id);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      try {
        const ok = await storage.deleteClient(id);
        if (!ok) return res.status(404).json({ error: "Client not found" });
        res.status(200).json({ message: "Client deleted", id });
      } catch (err: any) {
        // Foreign-key violation: client still has devices / tickets / contacts.
        if (err?.code === "23503" || /foreign key|violates/i.test(err?.message ?? "")) {
          return res.status(409).json({
            error: "Cannot delete client: dependent records exist (devices, tickets, or emergency contacts). Reassign or remove them first.",
          });
        }
        throw err;
      }
    } catch (error) {
      console.error("DELETE /api/clients/:id error:", error);
      res.status(500).json({ error: "Failed to delete client" });
    }
  });

  app.put("/api/network-scans/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const scan = await storage.updateNetworkScan(id, req.body);
      if (!scan) {
        return res.status(404).json({ error: "Network scan not found" });
      }
      res.json(scan);
    } catch (error) {
      res.status(500).json({ error: "Failed to update network scan" });
    }
  });

  app.delete("/api/network-scans/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid network scan id" });
      }
      const deleted = await storage.deleteNetworkScan(id);
      if (!deleted) {
        return res.status(404).json({ error: "Network scan not found" });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete network scan" });
    }
  });

  app.delete("/api/automation-scripts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const script = await storage.getAutomationScript(id);
      if (!script) {
        return res.status(404).json({ error: "Script not found" });
      }
      // Mark script as inactive instead of deleting
      const updatedScript = await storage.updateAutomationScript(id, { isActive: false });
      res.json(updatedScript);
    } catch (error) {
      res.status(500).json({ error: "Failed to deactivate script" });
    }
  });

  // MeshCentral agent installer URLs (from configured server)
  app.get("/api/meshcentral/agents", async (req, res) => {
    try {
      const agents = await meshCentralService.getAgentInstallers();
      res.json(agents);
    } catch (error) {
      res.status(500).json({ error: "Failed to get agent installers" });
    }
  });

  // ---- Public customer agent download (no login) ----
  // Whether the one-click download is currently available, so the public page
  // can show buttons vs. a "call us" fallback.
  app.get("/api/download/status", publicReadLimiter, async (_req, res) => {
    try {
      const meshId = await meshCentralService.resolveAgentMeshId();
      res.json({ available: Boolean(meshId) });
    } catch {
      res.json({ available: false });
    }
  });

  // Direct download: customer clicks a CSD link, we resolve the agent URL on the
  // MeshCentral server and redirect their browser straight to the installer.
  // They never see the MeshCentral dashboard.
  app.get("/api/download/agent", publicReadLimiter, async (req, res) => {
    const platform = String(req.query.platform || "windows").toLowerCase();
    if (!["windows", "mac", "linux"].includes(platform)) {
      return res.status(400).json({ error: "Unknown platform" });
    }
    try {
      const url = await meshCentralService.getAgentDownloadUrl(
        platform as "windows" | "mac" | "linux",
      );
      if (!url) {
        return res.status(503).json({
          error:
            "The remote support download isn't available right now. Please call us at 954-637-7300 and we'll connect you.",
        });
      }
      res.redirect(302, url);
    } catch (error) {
      res.status(502).json({ error: "Could not reach the remote support server." });
    }
  });

  app.post("/api/meshcentral/create-session", async (req, res) => {
    try {
      const { deviceId, sessionType } = req.body;
      const sessionUrl = await meshCentralService.createRemoteSession(deviceId, sessionType);
      if (sessionUrl) {
        res.json({ success: true, sessionUrl });
      } else {
        res.status(400).json({ error: "MeshCentral is not configured (MESHCENTRAL_URL missing)" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to create remote session" });
    }
  });

  // CSD Intake endpoints
  app.get("/api/intake", async (req, res) => {
    try {
      const { startDate, endDate, source, page = 1, limit = 50 } = req.query;
      
      let intakes;
      
      if (startDate && endDate) {
        const start = new Date(startDate as string);
        const end = new Date(endDate as string);
        intakes = await storage.getCsdIntakesByDateRange(start, end);
      } else if (source) {
        intakes = await storage.getCsdIntakesBySource(source as string);
      } else {
        intakes = await storage.getCsdIntakes();
      }
      
      // Simple pagination
      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const startIndex = (pageNum - 1) * limitNum;
      const paginatedIntakes = intakes.slice(startIndex, startIndex + limitNum);
      
      res.json({
        intakes: paginatedIntakes,
        total: intakes.length,
        page: pageNum,
        totalPages: Math.ceil(intakes.length / limitNum)
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch intake records" });
    }
  });

  app.get("/api/intake/:id", async (req, res) => {
    try {
      const intake = await storage.getCsdIntake(parseInt(req.params.id));
      if (!intake) {
        return res.status(404).json({ error: "Intake record not found" });
      }
      res.json(intake);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch intake record" });
    }
  });

  app.put("/api/intake/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const intake = await storage.updateCsdIntake(id, req.body);
      if (!intake) {
        return res.status(404).json({ error: "Intake record not found" });
      }
      res.json(intake);
    } catch (error) {
      res.status(500).json({ error: "Failed to update intake record" });
    }
  });

  app.delete("/api/intake/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid intake id" });
      }
      const deleted = await storage.deleteCsdIntake(id);
      if (!deleted) {
        return res.status(404).json({ error: "Intake record not found" });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete intake record" });
    }
  });

  // CSD analytics endpoints
  app.get("/api/intake/analytics/sources", async (req, res) => {
    try {
      const intakes = await storage.getCsdIntakes();
      
      const sourceStats = intakes.reduce((acc, intake) => {
        const source = intake.source || 'Unknown';
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      const last7Days = await storage.getCsdIntakesByDateRange(sevenDaysAgo, now);
      const last30Days = await storage.getCsdIntakesByDateRange(thirtyDaysAgo, now);
      
      res.json({
        allTime: sourceStats,
        last7Days: last7Days.length,
        last30Days: last30Days.length,
        total: intakes.length
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  // ========================================
  // CRM ENDPOINTS
  // ========================================

  // CRM Contacts
  app.get("/api/crm/contacts", async (req, res) => {
    try {
      const { search } = req.query;
      let contacts;
      if (search && typeof search === 'string') {
        contacts = await storage.searchCrmContacts(search);
      } else {
        contacts = await storage.getCrmContacts();
      }
      res.json(contacts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.get("/api/crm/contacts/:id", async (req, res) => {
    try {
      const contact = await storage.getCrmContact(parseInt(req.params.id));
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      res.json(contact);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch contact" });
    }
  });

  app.post("/api/crm/contacts", async (req, res) => {
    try {
      const contactData = insertCrmContactSchema.parse(req.body);
      const contact = await storage.createCrmContact(contactData);
      res.status(201).json(contact);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid contact data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  app.put("/api/crm/contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const contact = await storage.updateCrmContact(id, req.body);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      res.json(contact);
    } catch (error) {
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  // Frontend uses PATCH for updates — accept it too.
  app.patch("/api/crm/contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const contact = await storage.updateCrmContact(id, req.body);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      res.json(contact);
    } catch (error) {
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/crm/contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const ok = await storage.deleteCrmContact(id);
      if (!ok) {
        return res.status(404).json({ error: "Contact not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Delete contact error:", error);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  app.post("/api/crm/contacts/find-or-create", async (req, res) => {
    try {
      const { fullName, mobilePhone, email, ...rest } = req.body;
      
      // Try to find existing contact by phone or email
      let contact = await storage.getCrmContactByPhoneOrEmail(mobilePhone, email);
      
      if (!contact) {
        // Create new contact
        const contactData = insertCrmContactSchema.parse({ fullName, mobilePhone, email, ...rest });
        contact = await storage.createCrmContact(contactData);
      }
      
      res.json(contact);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid contact data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to find or create contact" });
    }
  });

  // CRM Leads
  app.get("/api/crm/leads", async (req, res) => {
    try {
      const { status, contactId } = req.query;
      let leads;
      
      if (status && typeof status === 'string') {
        leads = await storage.getCrmLeadsByStatus(status);
      } else if (contactId) {
        leads = await storage.getCrmLeadsByContact(parseInt(contactId as string));
      } else {
        leads = await storage.getCrmLeads();
      }
      res.json(leads);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  app.get("/api/crm/leads/:id", async (req, res) => {
    try {
      const lead = await storage.getCrmLead(parseInt(req.params.id));
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }
      res.json(lead);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch lead" });
    }
  });

  app.post("/api/crm/leads", async (req, res) => {
    try {
      const leadData = insertCrmLeadSchema.parse(req.body);
      const lead = await storage.createCrmLead(leadData);
      res.status(201).json(lead);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid lead data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create lead" });
    }
  });

  // Accept both PUT and PATCH — the client edit dialog sends PATCH.
  const updateCrmLeadHandler = async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id);
      const lead = await storage.updateCrmLead(id, req.body);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }
      res.json(lead);
    } catch (error) {
      res.status(500).json({ error: "Failed to update lead" });
    }
  };
  app.put("/api/crm/leads/:id", updateCrmLeadHandler);
  app.patch("/api/crm/leads/:id", updateCrmLeadHandler);

  // CRM Lead stats for dashboard
  app.get("/api/crm/leads/stats/pipeline", async (req, res) => {
    try {
      const leads = await storage.getCrmLeads();
      
      const pipeline = {
        new: leads.filter(l => l.status === 'new').length,
        contacted: leads.filter(l => l.status === 'contacted').length,
        qualified: leads.filter(l => l.status === 'qualified').length,
        quoted: leads.filter(l => l.status === 'quoted').length,
        won: leads.filter(l => l.status === 'won').length,
        lost: leads.filter(l => l.status === 'lost').length,
      };
      
      const totalValue = leads
        .filter(l => l.estimatedValue && l.status !== 'lost')
        .reduce((sum, l) => sum + (l.estimatedValue || 0), 0);
      
      res.json({ pipeline, totalValue, total: leads.length });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch lead pipeline stats" });
    }
  });

  // CRM Jobs/Work Orders
  app.get("/api/crm/jobs", async (req, res) => {
    try {
      const { status, leadId } = req.query;
      let jobs;
      
      if (status && typeof status === 'string') {
        jobs = await storage.getCrmJobsByStatus(status);
      } else if (leadId) {
        jobs = await storage.getCrmJobsByLead(parseInt(leadId as string));
      } else {
        jobs = await storage.getCrmJobs();
      }
      res.json(jobs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  app.get("/api/crm/jobs/:id", async (req, res) => {
    try {
      const job = await storage.getCrmJob(parseInt(req.params.id));
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      res.json(job);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch job" });
    }
  });

  app.post("/api/crm/jobs", async (req, res) => {
    try {
      // Generate job number
      const jobNumber = await storage.getNextJobNumber();
      const jobData = insertCrmJobSchema.parse({ ...req.body, jobNumber });
      const job = await storage.createCrmJob(jobData);
      res.status(201).json(job);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid job data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create job" });
    }
  });

  // Accept both PUT and PATCH — the client edit dialog sends PATCH.
  const updateCrmJobHandler = async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id);
      const job = await storage.updateCrmJob(id, req.body);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      res.json(job);
    } catch (error) {
      res.status(500).json({ error: "Failed to update job" });
    }
  };
  app.put("/api/crm/jobs/:id", updateCrmJobHandler);
  app.patch("/api/crm/jobs/:id", updateCrmJobHandler);

  // CRM Job stats
  app.get("/api/crm/jobs/stats/summary", async (req, res) => {
    try {
      const jobs = await storage.getCrmJobs();
      
      const summary = {
        open: jobs.filter(j => j.status === 'open').length,
        inProgress: jobs.filter(j => j.status === 'in_progress').length,
        waitingParts: jobs.filter(j => j.status === 'waiting_parts').length,
        completed: jobs.filter(j => j.status === 'completed').length,
        cancelled: jobs.filter(j => j.status === 'cancelled').length,
      };
      
      const revenue = jobs
        .filter(j => j.status === 'completed' && j.finalAmount)
        .reduce((sum, j) => sum + (j.finalAmount || 0), 0);
      
      res.json({ summary, revenue, total: jobs.length });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch job stats" });
    }
  });

  // CRM Interactions
  app.get("/api/crm/interactions", async (req, res) => {
    try {
      const { contactId, leadId, jobId } = req.query;
      let interactions;
      
      if (contactId) {
        interactions = await storage.getCrmInteractionsByContact(parseInt(contactId as string));
      } else if (leadId) {
        interactions = await storage.getCrmInteractionsByLead(parseInt(leadId as string));
      } else if (jobId) {
        interactions = await storage.getCrmInteractionsByJob(parseInt(jobId as string));
      } else {
        interactions = await storage.getCrmInteractions();
      }
      res.json(interactions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch interactions" });
    }
  });

  app.get("/api/crm/interactions/:id", async (req, res) => {
    try {
      const interaction = await storage.getCrmInteraction(parseInt(req.params.id));
      if (!interaction) {
        return res.status(404).json({ error: "Interaction not found" });
      }
      res.json(interaction);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch interaction" });
    }
  });

  app.post("/api/crm/interactions", async (req, res) => {
    try {
      const interactionData = insertCrmInteractionSchema.parse(req.body);
      const interaction = await storage.createCrmInteraction(interactionData);
      res.status(201).json(interaction);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid interaction data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create interaction" });
    }
  });

  // Service Logs endpoints
  app.get("/api/service-logs", async (req, res) => {
    try {
      const logs = await storage.getServiceLogs();
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch service logs" });
    }
  });

  app.get("/api/service-logs/:id", async (req, res) => {
    try {
      const log = await storage.getServiceLog(parseInt(req.params.id));
      if (!log) {
        return res.status(404).json({ error: "Service log not found" });
      }
      res.json(log);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch service log" });
    }
  });

  app.post("/api/service-logs", async (req, res) => {
    try {
      const logData = insertServiceLogSchema.parse(req.body);
      const log = await storage.createServiceLog(logData);
      res.status(201).json(log);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid service log data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create service log" });
    }
  });

  app.put("/api/service-logs/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const log = await storage.updateServiceLog(id, req.body);
      if (!log) {
        return res.status(404).json({ error: "Service log not found" });
      }
      res.json(log);
    } catch (error) {
      res.status(500).json({ error: "Failed to update service log" });
    }
  });

  app.delete("/api/service-logs/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid service log id" });
      }
      const deleted = await storage.deleteServiceLog(id);
      if (!deleted) {
        return res.status(404).json({ error: "Service log not found" });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete service log" });
    }
  });

  app.get("/api/service-logs/contact/:contactId", async (req, res) => {
    try {
      const logs = await storage.getServiceLogsByContact(parseInt(req.params.contactId));
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch service logs" });
    }
  });

  app.get("/api/service-logs/job/:jobId", async (req, res) => {
    try {
      const logs = await storage.getServiceLogsByJob(parseInt(req.params.jobId));
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch service logs" });
    }
  });

  // CRM Dashboard stats endpoint
  app.get("/api/crm/dashboard", async (req, res) => {
    try {
      const [contacts, leads, jobs] = await Promise.all([
        storage.getCrmContacts(),
        storage.getCrmLeads(),
        storage.getCrmJobs()
      ]);
      
      const now = new Date();
      const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      const newLeadsLast7Days = leads.filter(l => 
        l.createdAt && new Date(l.createdAt) >= last7Days
      ).length;
      
      const completedJobsLast30Days = jobs.filter(j => 
        j.status === 'completed' && j.completedDateTime && new Date(j.completedDateTime) >= last30Days
      ).length;
      
      const pipelineValue = leads
        .filter(l => l.estimatedValue && ['new', 'contacted', 'qualified', 'quoted'].includes(l.status || ''))
        .reduce((sum, l) => sum + (l.estimatedValue || 0), 0);
      
      const conversionRate = leads.length > 0 
        ? Math.round((leads.filter(l => l.status === 'won').length / leads.length) * 100)
        : 0;
      
      res.json({
        totalContacts: contacts.length,
        totalLeads: leads.length,
        totalJobs: jobs.length,
        newLeadsLast7Days,
        completedJobsLast30Days,
        pipelineValue,
        conversionRate,
        leadsByStatus: {
          new: leads.filter(l => l.status === 'new').length,
          contacted: leads.filter(l => l.status === 'contacted').length,
          qualified: leads.filter(l => l.status === 'qualified').length,
          quoted: leads.filter(l => l.status === 'quoted').length,
          won: leads.filter(l => l.status === 'won').length,
          lost: leads.filter(l => l.status === 'lost').length,
        },
        jobsByStatus: {
          open: jobs.filter(j => j.status === 'open').length,
          in_progress: jobs.filter(j => j.status === 'in_progress').length,
          waiting_parts: jobs.filter(j => j.status === 'waiting_parts').length,
          completed: jobs.filter(j => j.status === 'completed').length,
        }
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch CRM dashboard data" });
    }
  });

  // Direct intake endpoint - creates Contact, Lead, and Interaction in one call
  app.post("/api/intake", publicWriteLimiter, async (req, res) => {
    try {
      const validated = intakeSchema.safeParse(req.body);
      if (!validated.success) {
        return res.status(400).json({
          success: false,
          error: "Invalid intake data",
          details: validated.error.flatten().fieldErrors,
        });
      }
      const {
        full_name,
        mobile_phone,
        email,
        preferred_contact_method,
        street_address,
        city,
        state,
        zip,
        how_did_you_hear_about_us,
        service_type,
        device_type,
        device_brand,
        device_model,
        operating_system,
        problem_description,
        from_active_call,
        call_notes,
        sms_consent,
        sms_consent_text
      } = req.body;
      const smsConsentGiven = sms_consent === true;

      // Validate required fields
      if (!full_name || (!mobile_phone && !email) || !service_type || !device_type || !problem_description) {
        return res.status(400).json({ 
          success: false, 
          error: "Missing required fields: full_name, mobile_phone OR email, service_type, device_type, problem_description" 
        });
      }

      // Find or create contact
      let contact = await storage.getCrmContactByPhoneOrEmail(mobile_phone || null, email || null);
      
      if (!contact) {
        // Build address string
        const addressParts = [street_address, city, state, zip].filter(Boolean);
        const fullAddress = addressParts.length > 0 ? addressParts.join(', ') : null;
        
        contact = await storage.createCrmContact({
          fullName: full_name,
          mobilePhone: mobile_phone || null,
          email: email || null,
          contactPreference: preferred_contact_method || 'text_email',
          address: street_address || null,
          city: city || null,
          state: state || null,
          zipCode: zip || null,
          tags: how_did_you_hear_about_us || null,
        });
      } else {
        // Update tags if new source provided
        if (how_did_you_hear_about_us && !contact.tags?.includes(how_did_you_hear_about_us)) {
          const newTags = contact.tags 
            ? `${contact.tags}, ${how_did_you_hear_about_us}` 
            : how_did_you_hear_about_us;
          await storage.updateCrmContact(contact.id, { tags: newTags });
        }
      }

      // Create lead
      const brandModel = device_brand && device_model 
        ? `${device_brand} ${device_model}` 
        : (device_brand || device_model || null);
      
      const lead = await storage.createCrmLead({
        contactId: contact.id,
        source: how_did_you_hear_about_us || 'website_intake',
        campaign: from_active_call ? 'phone_call' : null,
        serviceType: service_type,
        deviceType: device_type,
        brandModel: brandModel,
        operatingSystem: operating_system || null,
        problemDescription: problem_description,
        status: 'new',
        priority: 'normal',
      });

      // Create interaction
      const interactionDetails = call_notes 
        ? `Problem: ${problem_description}\n\nCall Notes: ${call_notes}`
        : `Problem: ${problem_description}`;
      
      await storage.createCrmInteraction({
        type: 'intake_form',
        summary: `New intake – ${service_type}`,
        contactId: contact.id,
        leadId: lead.id,
        details: interactionDetails,
        performedBy: 'system',
      });

      // Auto-create dispatch records so every intake lands on the work boards
      // without a manual conversion step: a CRM Job (work order) and a Helpdesk
      // Ticket. Each is wrapped independently so a failure in one never breaks
      // the intake response or the other record.
      let job: Awaited<ReturnType<typeof storage.createCrmJob>> | null = null;
      try {
        const jobNumber = await storage.getNextJobNumber();
        job = await storage.createCrmJob({
          leadId: lead.id,
          contactId: contact.id,
          jobNumber,
          serviceType: service_type,
          jobType: 'drop_off',
          priority: 'normal',
          status: 'open',
          description: problem_description,
        });
      } catch (e) {
        console.error('[intake] failed to auto-create job:', e);
      }

      let ticket: Awaited<ReturnType<typeof storage.createTicket>> | null = null;
      try {
        const ticketSubject = `${service_type} – ${device_type}${brandModel ? ` (${brandModel})` : ''}`;
        const baseTicket = await storage.createTicket({
          subject: ticketSubject,
          description: problem_description,
          priority: 'medium',
          status: 'open',
          source: 'web',
          requesterName: full_name,
          requesterEmail: email || null,
          requesterPhone: mobile_phone || null,
          clientId: contact.clientId || null,
        });
        // Same enrichment pipeline as POST /api/tickets: ticket #, access token,
        // default department/SLA, filters, staff notice, activity log. The ticket
        // autoresponder is suppressed because the intake flow sends its own
        // customer confirmation email below — one acknowledgement per intake.
        ticket = await enrichNewTicket(baseTicket, { suppressAutoresponder: true });
        // Dispatch must never turn a successfully-created ticket into a failed
        // intake transaction. It records its own per-recipient failures.
        void dispatchNewTicketToStaff(ticket, {
          clientName: full_name,
          clientPhone: mobile_phone || null,
          device: `${device_type}${brandModel ? ` (${brandModel})` : ''}`,
          issue: problem_description,
        }).catch((dispatchError) => console.error('[intake] staff dispatch failed:', dispatchError));
      } catch (e) {
        console.error('[intake] failed to auto-create ticket:', e);
      }

      // Cross-link the dispatch records on the lead's timeline.
      if (job || ticket) {
        try {
          await storage.createCrmInteraction({
            type: 'note',
            summary: 'Dispatch records created from intake',
            contactId: contact.id,
            leadId: lead.id,
            jobId: job?.id ?? null,
            details:
              `Auto-created from web intake.\n` +
              (job ? `Job: ${job.jobNumber}\n` : '') +
              (ticket ? `Ticket: ${ticket.ticketNumber}` : ''),
            performedBy: 'system',
          });
        } catch (e) {
          console.error('[intake] failed to log dispatch interaction:', e);
        }
      }

      // Admin email notification (SendGrid). Build a CsdIntakeRecord-shaped
      // object from the form fields — the intake form writes straight to CRM and
      // never persists a csd_intake_records row, but the email helper only reads
      // these fields. Fire-and-forget; the helper swallows its own errors.
      try {
        void sendIntakeNotificationEmail({
          id: lead.id,
          customerName: full_name,
          phoneNumber: mobile_phone || '',
          emailAddress: email || '',
          contactPreference: preferred_contact_method || 'text_email',
          serviceType: service_type,
          deviceType: device_type,
          deviceBrandModel: brandModel || '',
          operatingSystem: operating_system || '',
          problemDescription: problem_description,
          howDidYouHear: how_did_you_hear_about_us || '',
          source: 'website_intake',
          campaign: from_active_call ? 'phone_call' : null,
          isFromActiveCall: !!from_active_call,
          callId: null,
          callNotes: call_notes || null,
          createdAt: new Date(),
        } as any);
      } catch (e) {
        console.error('[intake] notification email dispatch error:', e);
      }

      // Customer confirmation email — always sent when the customer provided an
      // email address. Fire-and-forget; the helper swallows its own errors.
      try {
        if (email) {
          void sendCustomerConfirmationEmail({
            id: lead.id,
            customerName: full_name,
            phoneNumber: mobile_phone || '',
            emailAddress: email,
            contactPreference: preferred_contact_method || 'text_email',
            serviceType: service_type,
            deviceType: device_type,
            deviceBrandModel: brandModel || '',
            operatingSystem: operating_system || '',
            problemDescription: problem_description,
            howDidYouHear: how_did_you_hear_about_us || '',
            source: 'website_intake',
            campaign: from_active_call ? 'phone_call' : null,
            isFromActiveCall: !!from_active_call,
            callId: null,
            callNotes: call_notes || null,
            createdAt: new Date(),
          } as any);
        }
      } catch (e) {
        console.error('[intake] customer confirmation email dispatch error:', e);
      }

      // A2P 10DLC consent proof. Only recorded when the customer voluntarily
      // checks the box. We store a timestamped audit record (interaction
      // createdAt = consent time) with the exact disclosure text they agreed
      // to, plus a note on the contact for quick visibility.
      if (smsConsentGiven) {
        const consentText =
          (typeof sms_consent_text === 'string' && sms_consent_text.trim()) ||
          'I agree to receive SMS text messages from Computer Systems Depot Inc. for support and service updates. Message and data rates may apply. Reply STOP to opt-out. View our Privacy Policy.';
        const consentTimestamp = new Date().toISOString();
        try {
          await storage.createCrmInteraction({
            type: 'sms_consent',
            summary: 'SMS opt-in consent granted',
            contactId: contact.id,
            leadId: lead.id,
            details:
              `Source: website intake form\n` +
              `Granted: ${consentTimestamp}\n` +
              `Contact: ${mobile_phone || 'n/a'}\n` +
              `Agreed to: "${consentText}"`,
            performedBy: 'system',
          });
          const consentNote = `[SMS consent] Opted in via web form on ${consentTimestamp}.`;
          const updatedNotes = contact.notes
            ? `${contact.notes}\n${consentNote}`
            : consentNote;
          await storage.updateCrmContact(contact.id, { notes: updatedNotes });
        } catch (e) {
          console.error('[intake] failed to record SMS consent:', e);
        }
        // Current consent state is independent of the historical CRM audit
        // record, so a notes/audit failure cannot silently lose the opt-in.
        if (mobile_phone) {
          try {
            await recordSmsConsentState(mobile_phone, true);
          } catch (e) {
            console.error('[intake] failed to store SMS consent state:', e);
          }
        }
      }

      // SMS to the customer after opting in on the form. Fires in the background —
      // never blocks the form response, never breaks the intake on failure.
      let thankYouSmsStatus: 'sent' | 'skipped' | 'failed' = 'skipped';
      try {
        const settings = await getTwilioSettings();
        // A2P compliance: only text the customer when they explicitly opted in.
        if (smsConsentGiven && mobile_phone && (await isTwilioConfigured())) {
          // Mandatory opt-in confirmation. The A2P campaign registration promises
          // that every opt-in (web form or START keyword) immediately receives an
          // automated confirmation identifying the business and restating
          // STOP/HELP — so this is NOT gated on the optional thank-you setting.
          const confirmation =
            'Computer Systems Depot Inc.: You are opted in to recurring service update texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.';
          sendSms(mobile_phone, confirmation)
            .then(() => console.log(`[intake] opt-in confirmation SMS sent to ${mobile_phone}`))
            .catch((e) => console.error('[intake] opt-in confirmation SMS failed:', e?.message || e));
          thankYouSmsStatus = 'sent';

          // Optional personalized thank-you (configurable in Phone & SMS Settings → SMS tab).
          if (settings.intakeSmsEnabled && (settings.intakeSmsText || '').trim()) {
            const firstName = (full_name || '').trim().split(/\s+/)[0] || 'there';
            const body = settings.intakeSmsText.replace(/\{\{name\}\}/gi, firstName);
            sendSms(mobile_phone, body)
              .then(() => console.log(`[intake] thank-you SMS sent to ${mobile_phone}`))
              .catch((e) => console.error('[intake] thank-you SMS failed:', e?.message || e));
          }
        }
      } catch (e) {
        console.error('[intake] thank-you SMS dispatch error:', e);
        thankYouSmsStatus = 'failed';
      }

      // Team notification via Slack (no-op until Slack is connected). Gives the
      // whole tech team an instant heads-up alongside the admin SMS above.
      try {
        void sendLeadNotification({
          name: full_name,
          contact: mobile_phone || email || 'No contact info',
          service: service_type,
          device: `${device_type}${brandModel ? ` (${brandModel})` : ''}`,
          issue: String(problem_description).slice(0, 200),
        }).catch((e) => console.error('[intake] Slack lead notify failed:', e?.message || e));
      } catch (e) {
        console.error('[intake] Slack lead dispatch error:', e);
      }

      res.status(201).json({
        success: true,
        contact,
        lead,
        job,
        ticket,
        thankYouSms: thankYouSmsStatus,
      });
    } catch (error) {
      console.error('Intake creation error:', error);
      res.status(500).json({ success: false, error: "Failed to create intake" });
    }
  });

  // Intake to CRM integration - convert intake to lead
  app.post("/api/intake/:id/convert-to-lead", async (req, res) => {
    try {
      const intakeId = parseInt(req.params.id);
      const intake = await storage.getCsdIntake(intakeId);
      
      if (!intake) {
        return res.status(404).json({ error: "Intake record not found" });
      }
      
      // Find or create contact from intake (using correct field names from csdIntakeRecords schema)
      let contact = await storage.getCrmContactByPhoneOrEmail(intake.phoneNumber, intake.emailAddress);
      
      if (!contact) {
        contact = await storage.createCrmContact({
          fullName: intake.customerName,
          mobilePhone: intake.phoneNumber,
          email: intake.emailAddress,
          contactPreference: intake.contactPreference || 'text_email',
        });
      }
      
      // Create lead from intake (serviceType is required)
      const lead = await storage.createCrmLead({
        contactId: contact.id,
        source: intake.source || 'website_intake',
        campaign: intake.campaign,
        serviceType: intake.serviceType,
        deviceType: intake.deviceType,
        brandModel: intake.deviceBrandModel,
        operatingSystem: intake.operatingSystem,
        problemDescription: intake.problemDescription,
        callId: intake.callId,
        status: 'new',
        priority: 'normal',
        intakeRecordId: intake.id,
      });
      
      // Log the interaction (summary is required)
      await storage.createCrmInteraction({
        type: 'intake_conversion',
        summary: `Lead created from ${intake.source || 'website'} intake`,
        contactId: contact.id,
        leadId: lead.id,
        details: `Lead created from intake form submission. Problem: ${intake.problemDescription}`,
      });
      
      // Update intake status
      await storage.updateCsdIntake(intakeId, { status: 'converted' });
      
      res.json({ contact, lead });
    } catch (error) {
      console.error('Intake conversion error:', error);
      res.status(500).json({ error: "Failed to convert intake to lead" });
    }
  });

  // Google Contacts OAuth & Sync endpoints
  app.get("/api/google/status", async (req, res) => {
    try {
      const status = googleContactsService.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: "Failed to get Google Contacts status" });
    }
  });

  app.get("/api/google/auth-url", async (req, res) => {
    try {
      const authUrl = googleContactsService.getAuthUrl();
      if (!authUrl) {
        return res.status(400).json({ 
          error: "Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets first." 
        });
      }
      res.json({ authUrl });
    } catch (error) {
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  });

  app.get("/api/google/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      if (!code) {
        return res.status(400).json({ error: "No authorization code provided" });
      }
      
      const tokens = await googleContactsService.handleAuthCallback(code);
      
      console.log('Google OAuth completed successfully. Session is now active.');
      
      res.send(`
        <html>
          <head><title>Google Contacts Connected</title></head>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Google Contacts Connected Successfully!</h1>
            <p>Your Google account is now connected for this session.</p>
            <p style="color: #666; font-size: 14px;">
              For permanent access, check the server logs and add the tokens as secrets:
              <br>GOOGLE_ACCESS_TOKEN and GOOGLE_REFRESH_TOKEN
            </p>
            <p><a href="/crm/contacts" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #4285f4; color: white; text-decoration: none; border-radius: 4px;">Return to CRM Contacts</a></p>
          </body>
        </html>
      `);
    } catch (error: any) {
      res.status(500).send(`
        <html>
          <head><title>OAuth Error</title></head>
          <body style="font-family: sans-serif; padding: 40px;">
            <h1>OAuth Error</h1>
            <p>${error.message}</p>
            <a href="/crm/contacts">Return to CRM Contacts</a>
          </body>
        </html>
      `);
    }
  });

  app.post("/api/google/sync-contact/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId);
      const contact = await storage.getCrmContact(contactId);
      
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      
      const result = await googleContactsService.createContact({
        fullName: contact.fullName,
        email: contact.email,
        mobilePhone: contact.mobilePhone,
        officePhone: contact.officePhone,
        company: contact.company,
        address: contact.address,
        city: contact.city,
        state: contact.state,
        zipCode: contact.zipCode,
        notes: contact.notes,
      });
      
      if (result) {
        await storage.updateCrmContact(contactId, { 
          googleContactId: result.resourceName 
        });
        res.json({ success: true, resourceName: result.resourceName });
      } else {
        res.status(400).json({ 
          error: "Google Contacts not configured. Complete OAuth setup first." 
        });
      }
    } catch (error: any) {
      console.error('Google sync error:', error);
      res.status(500).json({ error: error.message || "Failed to sync contact" });
    }
  });

  app.post("/api/google/sync-all-contacts", async (req, res) => {
    try {
      const contacts = await storage.getCrmContacts();
      const results = { synced: 0, failed: 0, skipped: 0 };
      
      for (const contact of contacts) {
        if (contact.googleContactId) {
          results.skipped++;
          continue;
        }
        
        try {
          const result = await googleContactsService.createContact({
            fullName: contact.fullName,
            email: contact.email,
            mobilePhone: contact.mobilePhone,
            officePhone: contact.officePhone,
            company: contact.company,
            address: contact.address,
            city: contact.city,
            state: contact.state,
            zipCode: contact.zipCode,
            notes: contact.notes,
          });
          
          if (result) {
            await storage.updateCrmContact(contact.id, { 
              googleContactId: result.resourceName 
            });
            results.synced++;
          } else {
            results.failed++;
          }
        } catch (err) {
          results.failed++;
        }
      }
      
      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to sync contacts" });
    }
  });

  app.post("/api/google/import-contacts", async (req, res) => {
    try {
      const status = googleContactsService.getStatus();
      if (!status.configured) {
        return res.status(400).json({ 
          error: "Google Contacts not configured. Complete OAuth setup first." 
        });
      }

      const googleContacts = await googleContactsService.listAllContacts();
      const results = { imported: 0, skipped: 0, failed: 0 };
      
      for (const gContact of googleContacts) {
        try {
          const googleContactId = (gContact as any).googleContactId;
          
          if (googleContactId) {
            const existingContact = await storage.getCrmContactByGoogleId(googleContactId);
            if (existingContact) {
              results.skipped++;
              continue;
            }
          }

          const existingByPhoneOrEmail = await storage.getCrmContactByPhoneOrEmail(
            gContact.mobilePhone || null, 
            gContact.email || null
          );
          
          if (existingByPhoneOrEmail) {
            await storage.updateCrmContact(existingByPhoneOrEmail.id, { 
              googleContactId 
            });
            results.skipped++;
            continue;
          }

          await storage.createCrmContact({
            fullName: gContact.fullName,
            email: gContact.email,
            mobilePhone: gContact.mobilePhone,
            officePhone: gContact.officePhone,
            company: gContact.company,
            address: gContact.address,
            city: gContact.city,
            state: gContact.state,
            zipCode: gContact.zipCode,
            notes: gContact.notes,
            googleContactId,
          });
          results.imported++;
        } catch (err) {
          console.error('Failed to import contact:', err);
          results.failed++;
        }
      }
      
      res.json({ 
        success: true, 
        totalFromGoogle: googleContacts.length,
        ...results 
      });
    } catch (error: any) {
      console.error('Google import error:', error);
      res.status(500).json({ error: error.message || "Failed to import contacts" });
    }
  });

  app.get("/api/google/contact-count", async (req, res) => {
    try {
      const count = await googleContactsService.getContactCount();
      res.json({ count });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get contact count" });
    }
  });

  // ============================================
  // Google Calendar (scheduling) Endpoints
  // ============================================
  app.get("/api/calendar/status", async (_req, res) => {
    try {
      const settings = await getTwilioSettings();
      const status = await googleCalendarService.getStatus();
      res.json({
        ...status,
        attachedCalendarId: settings.schedulingCalendarId || null,
        blockBusy: settings.schedulingCalendarBlockBusy,
        pushEvents: settings.schedulingCalendarPushEvents,
      });
    } catch (e: any) {
      res.status(500).json({ connected: false, error: e?.message || "Calendar status failed" });
    }
  });

  app.get("/api/calendar/list", async (_req, res) => {
    try {
      const items = await googleCalendarService.listCalendars();
      res.json({ calendars: items });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to list calendars" });
    }
  });

  app.patch("/api/calendar/settings", async (req, res) => {
    try {
      const { schedulingCalendarId, schedulingCalendarBlockBusy, schedulingCalendarPushEvents } = req.body || {};
      const patch: any = {};
      if (schedulingCalendarId !== undefined) patch.schedulingCalendarId = schedulingCalendarId || null;
      if (schedulingCalendarBlockBusy !== undefined) patch.schedulingCalendarBlockBusy = !!schedulingCalendarBlockBusy;
      if (schedulingCalendarPushEvents !== undefined) patch.schedulingCalendarPushEvents = !!schedulingCalendarPushEvents;
      const updated = await updateTwilioSettings(patch);
      res.json({
        schedulingCalendarId: updated.schedulingCalendarId,
        schedulingCalendarBlockBusy: updated.schedulingCalendarBlockBusy,
        schedulingCalendarPushEvents: updated.schedulingCalendarPushEvents,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to update calendar settings" });
    }
  });

  // ============================================
  // ARIA AI Assistant Endpoints
  // ============================================

  // ── PUBLIC customer support chatbot ────────────────────────────────────────
  // Unauthenticated endpoint used by the website chat widget. Uses the restricted
  // customer-facing prompt (no internal platform data). Rate-limited per IP.
  const supportChatLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    message: "You're sending messages too quickly. Please wait a moment.",
  });
  app.post("/api/aria/support-chat", supportChatLimiter, async (req, res) => {
    try {
      if (!ariaService.getStatus().configured) {
        return res.status(503).json({
          error: "The chat assistant is unavailable right now. Please call (954) 637-7300.",
        });
      }

      const raw = (req.body?.messages ?? []) as unknown;
      if (!Array.isArray(raw) || raw.length === 0) {
        return res.status(400).json({ error: "messages is required" });
      }

      // Sanitize: keep only the recent turns, cap length, valid roles/content.
      const messages = raw
        .slice(-12)
        .map((m: any) => ({
          role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: String(m?.content ?? "").slice(0, 2000),
        }))
        .filter((m) => m.content.trim().length > 0);

      if (messages.length === 0) {
        return res.status(400).json({ error: "Message cannot be empty" });
      }

      const result = await ariaService.supportChat(messages);
      res.json({ reply: result.content });
    } catch (error) {
      console.error("[aria support-chat] error:", error);
      res.status(500).json({
        error: "Sorry, something went wrong. Please try again or call (954) 637-7300.",
      });
    }
  });

  // Get ARIA status (is it configured?)
  app.get("/api/aria/status", async (req, res) => {
    try {
      const status = ariaService.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: "Failed to get ARIA status" });
    }
  });

  // List conversations
  app.get("/api/aria/conversations", async (req, res) => {
    try {
      const userId = req.query.userId ? parseInt(req.query.userId as string) : undefined;
      const conversations = await storage.getAriaConversations(userId);
      res.json(conversations);
    } catch (error) {
      console.error("Error listing ARIA conversations:", error);
      res.status(500).json({ error: "Failed to get conversations" });
    }
  });

  // Get conversation with messages
  app.get("/api/aria/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const conversation = await storage.getAriaConversation(id);

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const messages = await storage.getAriaMessages(id);
      res.json({ conversation, messages });
    } catch (error) {
      console.error("Error getting ARIA conversation:", error);
      res.status(500).json({ error: "Failed to get conversation" });
    }
  });

  // Create new conversation
  app.post("/api/aria/conversations", async (req, res) => {
    try {
      const { sessionId, userId, title } = req.body;

      // Check if conversation exists by session
      if (sessionId) {
        const existing = await storage.getAriaConversationBySession(sessionId);
        if (existing) {
          return res.json(existing);
        }
      }

      const conversation = await storage.createAriaConversation({
        sessionId: sessionId || uuidv4(),
        userId: userId || null,
        title: title || null,
        status: "active",
        metadata: null,
      });

      res.status(201).json(conversation);
    } catch (error) {
      console.error("Error creating ARIA conversation:", error);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  // Delete conversation
  app.delete("/api/aria/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteAriaConversation(id);

      if (!deleted) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting ARIA conversation:", error);
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  // Send message (non-streaming)
  app.post("/api/aria/chat", async (req, res) => {
    try {
      const { conversationId, message } = req.body;

      if (!conversationId || !message) {
        return res.status(400).json({ error: "conversationId and message are required" });
      }

      // Get conversation
      const conversation = await storage.getAriaConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Save user message
      await storage.createAriaMessage({
        conversationId,
        role: "user",
        content: message,
        contextRefs: null,
        moduleUsed: null,
        tokensUsed: null,
        modelVersion: null,
      });

      // Get conversation history
      const history = await storage.getAriaMessages(conversationId);
      const chatMessages = history.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Call ARIA service
      const model = req.body.model || 'claude';
      const response = await ariaService.chat(chatMessages, conversationId, model);

      // Save assistant response
      const assistantMessage = await storage.createAriaMessage({
        conversationId,
        role: "assistant",
        content: response.content,
        contextRefs: JSON.stringify(response.contextRefs),
        moduleUsed: null,
        tokensUsed: response.tokensUsed,
        modelVersion: response.modelUsed,
      });

      // Update conversation title if first message
      if (history.length === 1 && !conversation.title) {
        const title = message.substring(0, 50) + (message.length > 50 ? "..." : "");
        await storage.updateAriaConversation(conversationId, { title });
      }

      res.json({
        message: assistantMessage,
        tokensUsed: response.tokensUsed,
      });
    } catch (error: any) {
      console.error("ARIA chat error:", error);
      res.status(500).json({ error: error.message || "Failed to process message" });
    }
  });

  // Streaming chat endpoint (SSE)
  app.post("/api/aria/chat/stream", async (req, res) => {
    try {
      const { conversationId, message } = req.body;

      if (!conversationId || !message) {
        return res.status(400).json({ error: "conversationId and message are required" });
      }

      const conversation = await storage.getAriaConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Save user message
      await storage.createAriaMessage({
        conversationId,
        role: "user",
        content: message,
        contextRefs: null,
        moduleUsed: null,
        tokensUsed: null,
        modelVersion: null,
      });

      // Get conversation history
      const history = await storage.getAriaMessages(conversationId);
      const chatMessages = history.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let fullContent = "";
      const model = req.body.model || 'claude';

      const result = await ariaService.streamChat(
        chatMessages,
        conversationId,
        (chunk) => {
          fullContent += chunk;
          res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
        },
        model
      );

      // Save complete assistant message
      const assistantMessage = await storage.createAriaMessage({
        conversationId,
        role: "assistant",
        content: fullContent,
        contextRefs: JSON.stringify(result.contextRefs),
        moduleUsed: null,
        tokensUsed: result.tokensUsed,
        modelVersion: result.modelUsed,
      });

      // Update conversation title if needed
      if (history.length === 1 && !conversation.title) {
        const title = message.substring(0, 50) + (message.length > 50 ? "..." : "");
        await storage.updateAriaConversation(conversationId, { title });
      }

      res.write(`data: ${JSON.stringify({
        type: "done",
        messageId: assistantMessage.id,
        tokensUsed: result.tokensUsed
      })}\n\n`);
      res.end();
    } catch (error: any) {
      console.error("ARIA stream error:", error);
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
      res.end();
    }
  });

  app.post("/api/aria/tts", async (req, res) => {
    try {
      const { text, voice } = req.body;

      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: "text is required" });
      }

      const audioBuffer = await ariaService.textToSpeech(text, voice || 'nova');

      if (!audioBuffer) {
        return res.status(503).json({ error: "TTS not available" });
      }

      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString(),
        'Cache-Control': 'no-cache',
      });
      res.send(audioBuffer);
    } catch (error: any) {
      console.error("TTS error:", error);
      res.status(500).json({ error: error.message || "TTS failed" });
    }
  });

  app.get("/api/aria/tts/status", (req, res) => {
    res.json({
      available: ariaService.hasTTS,
      voices: ariaService.hasTTS ? [
        { id: 'nova', name: 'Nova', description: 'Warm and natural' },
        { id: 'shimmer', name: 'Shimmer', description: 'Soft and clear' },
        { id: 'coral', name: 'Coral', description: 'Friendly and expressive' },
        { id: 'sage', name: 'Sage', description: 'Calm and measured' },
        { id: 'alloy', name: 'Alloy', description: 'Neutral and balanced' },
        { id: 'echo', name: 'Echo', description: 'Warm and resonant' },
        { id: 'ash', name: 'Ash', description: 'Gentle and soft' },
        { id: 'fable', name: 'Fable', description: 'Storytelling warmth' },
        { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative' },
      ] : [],
    });
  });

  registerAriaMultiCamRoutes(app);

  // Mount API routes
  app.use("/api/network", networkRoutes);
  app.use("/api/crm", crmPipelineRoutes); // deals + pipeline (contacts/leads/jobs stay inline above)

  // -------- Twilio (SMS / voice) --------
  app.get("/api/twilio/status", async (_req, res) => {
    try {
      const configured = await isTwilioConfigured();
      const phoneNumber = configured ? await getTwilioFromPhoneNumber() : undefined;
      res.json({ configured, phoneNumber });
    } catch (err: any) {
      res.json({ configured: false, error: err.message });
    }
  });

  // SMS-capable phone numbers on the Twilio account. The A2P wizard uses
  // this to let the owner pick which number to attach to the new Messaging
  // Service when more than one number is available.
  app.get("/api/twilio/phone-numbers", async (_req, res) => {
    try {
      const configured = await isTwilioConfigured();
      if (!configured) return res.json({ configured: false, numbers: [], configuredPhoneNumber: null });
      const { listTwilioSmsNumbers } = await import("./twilio");
      const [numbers, configuredPhoneNumber] = await Promise.all([
        listTwilioSmsNumbers(),
        getTwilioFromPhoneNumber(),
      ]);
      res.json({ configured: true, numbers, configuredPhoneNumber: configuredPhoneNumber || null });
    } catch (err: any) {
      res.status(500).json({ configured: false, numbers: [], error: err?.message });
    }
  });

  // A2P 10DLC registration status. Surfaces brand + campaign state from Twilio
  // so the Messages page can warn the account owner before carriers start
  // dropping outbound texts with error 30034. The actual lookup lives in
  // `server/a2p-status.ts` so the scheduled monitor in `server/a2p-monitor.ts`
  // can reuse the exact same logic.
  app.get("/api/twilio/a2p/status", async (_req, res) => {
    const { getA2PStatus } = await import("./a2p-status");
    const result = await getA2PStatus();
    res.json(result);
  });

  // Server-Sent Events stream that pushes a `status` event whenever the
  // background monitor (server/a2p-monitor.ts) observes the A2P verdict or
  // rejection set change. The Messages page banner subscribes here so it
  // can refresh within seconds of a Twilio update instead of waiting up to
  // 5 minutes for its next poll. If the EventSource fails (proxy strips
  // SSE, browser tab throttled, etc.) the client keeps its 5-minute poll
  // as a fallback.
  // Requires auth (long-lived socket — gate it behind a session to avoid
  // anonymous connection abuse) even though the snapshot endpoint above
  // is open. Snooze GET is already isAuthenticated, so banner viewers
  // already have a session.
  app.get("/api/twilio/a2p/events", isAuthenticated, async (req, res) => {
    const { addA2PEventClient } = await import("./a2p-events");
    const cleanup = addA2PEventClient(res);
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  // Snooze controls so an owner who's already in a Twilio support thread can
  // mute repeat A2P alerts without disabling the monitor entirely. The
  // monitor reads the same state file we write here.
  //
  // Authorization model: muting A2P paging is org-wide, so restrict it to
  // the same "owner" identity the monitor already treats as the page
  // recipient (A2P_ALERT_EMAIL / CSD_ADMIN_EMAIL) plus any user whose
  // stored role is owner/admin. A logged-in but ordinary user gets 403 and
  // the UI hides the controls based on the GET response.
  interface ReplitSessionUser {
    claims?: { email?: string; sub?: string };
    email?: string;
  }
  const ownerEmailsFromEnv = (): string[] =>
    [process.env.A2P_ALERT_EMAIL, process.env.CSD_ADMIN_EMAIL]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.toLowerCase());
  const resolveActor = async (req: import("express").Request) => {
    const u = req.user as ReplitSessionUser | undefined;
    const email = (u?.claims?.email || u?.email || "").toLowerCase() || null;
    const sub = u?.claims?.sub || null;
    let role: string | null = null;
    if (email) {
      try {
        const record = await storage.getUserByUsername(email);
        if (record?.role) role = record.role;
      } catch {
        // Storage may not have the user yet; fall through to env check.
      }
    }
    const isOwner =
      role === "owner" ||
      role === "admin" ||
      (email != null && ownerEmailsFromEnv().includes(email));
    return { email, sub, role, isOwner };
  };
  const requireOwner: import("express").RequestHandler = async (req, res, next) => {
    try {
      const actor = await resolveActor(req);
      if (!actor.isOwner) {
        return res.status(403).json({ error: "Owner access required" });
      }
      (req as import("express").Request & { actor?: typeof actor }).actor = actor;
      next();
    } catch (err) {
      console.error("[a2p/snooze] owner check failed:", (err as Error)?.message);
      res.status(500).json({ error: "Authorization check failed" });
    }
  };

  // GET is open to any authenticated user so the whole team can see when
  // A2P paging is muted — but we redact `snoozeStartedBy` for non-owners
  // and add an `allowed` flag the UI uses to decide whether to render the
  // snooze/resume buttons.
  app.get("/api/twilio/a2p/snooze", isAuthenticated, async (req, res) => {
    const { getA2PSnoozeStatus } = await import("./a2p-monitor");
    const [status, actor] = await Promise.all([
      getA2PSnoozeStatus(),
      resolveActor(req),
    ]);
    res.json({
      ...status,
      snoozeStartedBy: actor.isOwner ? status.snoozeStartedBy : null,
      allowed: actor.isOwner,
    });
  });

  const snoozeBodySchema = z.object({ hours: z.coerce.number().positive() });
  app.post("/api/twilio/a2p/snooze", isAuthenticated, requireOwner, async (req, res) => {
    const { snoozeA2PAlerts } = await import("./a2p-monitor");
    const parsed = snoozeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "hours must be a positive number" });
    }
    // Actor was resolved + verified by requireOwner, attached to req.
    const actor = (req as import("express").Request & {
      actor?: { email: string | null; sub: string | null };
    }).actor;
    const startedBy = actor?.email || actor?.sub || null;
    try {
      const status = await snoozeA2PAlerts(parsed.data.hours, startedBy);
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: (err as Error)?.message || "Failed to snooze" });
    }
  });

  app.delete("/api/twilio/a2p/snooze", isAuthenticated, requireOwner, async (_req, res) => {
    const { clearA2PSnooze } = await import("./a2p-monitor");
    res.json(await clearA2PSnooze());
  });

  // Incident history for the Messages page. Returns the last ~10 alerts the
  // A2P background monitor opened, with start/end times, duration, and how
  // each one was resolved (auto by the monitor vs acknowledged by a human).
  // Restricted to owners/admins — same gate as the snooze controls — because
  // it exposes operational reliability data the rest of the team doesn't
  // need to act on.
  app.get(
    "/api/twilio/a2p/incidents",
    isAuthenticated,
    requireOwner,
    async (_req, res) => {
      try {
        const list = await storage.getAlertsBySource("a2p-monitor", 10);
        const incidents = list.map((a) => {
          const startedAt = a.createdAt ?? null;
          const resolvedAt = a.resolvedAt ?? null;
          let durationMs: number | null = null;
          if (startedAt && resolvedAt) {
            durationMs = new Date(resolvedAt).getTime() - new Date(startedAt).getTime();
          }
          // Heuristic: the background monitor's auto-resolve path only sets
          // `status` + `resolvedAt`. When a human resolves an alert through
          // the Alerts UI they ack first (acknowledgedBy is set). Use that
          // to distinguish the two outcomes.
          let outcome: "active" | "auto-resolved" | "human-resolved";
          if (a.status !== "resolved") {
            outcome = "active";
          } else if (a.acknowledgedBy != null) {
            outcome = "human-resolved";
          } else {
            outcome = "auto-resolved";
          }
          return {
            id: a.id,
            title: a.title,
            severity: a.severity,
            status: a.status,
            startedAt,
            resolvedAt,
            durationMs,
            outcome,
          };
        });
        res.json(incidents);
      } catch (err) {
        console.error(
          "[a2p/incidents] failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to fetch A2P incidents" });
      }
    },
  );

  // A2P rejection-suggestion feedback loop. When Twilio returns a rejection
  // reason that doesn't match any pattern in `client/src/lib/a2p-rejections.ts`,
  // staff can submit a proposed plain-English remediation. Submissions land
  // in `a2p_rejection_suggestions` for owners/admins to review and use to
  // extend the curated KB.
  const suggestionInputSchema = z.object({
    reasonText: z.string().trim().min(1).max(2000),
    suggestedTitle: z.string().trim().min(3).max(200),
    suggestedRemediation: z.string().trim().min(10).max(2000),
    docUrl: z.string().trim().url().max(500).optional().or(z.literal("")),
  });

  app.post(
    "/api/twilio/a2p/rejection-suggestions",
    isAuthenticated,
    async (req, res) => {
      const parsed = suggestionInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid suggestion" });
      }
      try {
        const actor = await resolveActor(req);
        // De-dup: if a pending suggestion already covers this exact rejection
        // (ignoring case/whitespace), don't add another row — just tell the
        // submitter it's already reported and point at the existing entry.
        const existing = await storage.getPendingA2pRejectionSuggestionByReason(
          parsed.data.reasonText,
        );
        if (existing) {
          return res.json({
            ok: true,
            id: existing.id,
            duplicate: true,
            message:
              "Thanks — someone already reported this rejection. It's waiting for review.",
          });
        }
        const created = await storage.createA2pRejectionSuggestion({
          reasonText: parsed.data.reasonText,
          suggestedTitle: parsed.data.suggestedTitle,
          suggestedRemediation: parsed.data.suggestedRemediation,
          docUrl: parsed.data.docUrl || undefined,
          submittedBy: actor.email || actor.sub || null,
        });
        res.json({ ok: true, id: created.id, duplicate: false });
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] create failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to save suggestion" });
      }
    },
  );

  app.get(
    "/api/twilio/a2p/rejection-suggestions",
    isAuthenticated,
    requireOwner,
    async (req, res) => {
      try {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const list = await storage.getA2pRejectionSuggestions(
          status ? { status } : undefined,
        );
        res.json(list);
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] list failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to load suggestions" });
      }
    },
  );

  const suggestionUpdateSchema = z.object({
    status: z.enum(["pending", "reviewed", "merged", "dismissed"]).optional(),
    reviewerNotes: z.string().trim().max(2000).nullable().optional(),
  });
  app.patch(
    "/api/twilio/a2p/rejection-suggestions/:id",
    isAuthenticated,
    requireOwner,
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid id" });
      }
      const parsed = suggestionUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid update" });
      }
      try {
        const updated = await storage.updateA2pRejectionSuggestion(id, parsed.data);
        if (!updated) return res.status(404).json({ error: "Not found" });
        res.json(updated);
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] update failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to update suggestion" });
      }
    },
  );

  // A2P 10DLC guided registration. The Messages page wizard collects business
  // profile + campaign details and posts them here. We attempt each Trust Hub /
  // messaging step in order and return a per-step result so the UI can show
  // exactly what got created and what failed (e.g. brand creation often errors
  // until a customer profile bundle is approved by Twilio review).
  app.post("/api/twilio/a2p/register", async (req, res) => {
    interface RegisterBody {
      business?: {
        legalName?: string;
        ein?: string;
        businessType?: string; // LLC, Corporation, ...
        industry?: string;
        website?: string;
        regionsOfOperation?: string; // comma separated ISO codes e.g. "USA"
        address?: {
          street?: string;
          city?: string;
          region?: string;
          postalCode?: string;
          isoCountry?: string;
        };
        contact?: {
          firstName?: string;
          lastName?: string;
          email?: string;
          phone?: string;
          jobTitle?: string;
        };
      };
      campaign?: {
        description?: string;
        usAppToPersonUsecase?: string; // MIXED, CUSTOMER_CARE, MARKETING, ...
        messageSamples?: string[];
        optInMessage?: string;
        optInKeywords?: string[];
        messageFlow?: string;
        hasEmbeddedLinks?: boolean;
        hasEmbeddedPhone?: boolean;
        brandType?: string; // STANDARD or SOLE_PROPRIETOR
      };
      // Optional explicit PN... SID to attach to the messaging service. When
      // omitted we fall back to the configured TWILIO_PHONE_NUMBER's SID.
      phoneNumberSid?: string;
    }

    type StepResult =
      | { ok: true; sid: string; note?: string; reused?: boolean; phoneNumber?: string }
      | { ok: false; error: string; skipped?: boolean };

    const result: {
      configured: boolean;
      customerProfile: StepResult | null;
      brand: StepResult | null;
      messagingService: StepResult | null;
      phoneNumber: StepResult | null;
      campaign: StepResult | null;
    } = {
      configured: false,
      customerProfile: null,
      brand: null,
      messagingService: null,
      phoneNumber: null,
      campaign: null,
    };

    try {
      const body = (req.body || {}) as RegisterBody;
      const business = body.business || {};
      const campaign = body.campaign || {};
      const contact = business.contact || {};
      const address = business.address || {};

      // Light validation. Carriers + Twilio will reject anything thin so we
      // refuse early instead of submitting garbage.
      const missing: string[] = [];
      if (!business.legalName) missing.push("business.legalName");
      if (!business.ein) missing.push("business.ein");
      if (!business.website) missing.push("business.website");
      if (!contact.email) missing.push("business.contact.email");
      if (!campaign.description) missing.push("campaign.description");
      if (!campaign.usAppToPersonUsecase) missing.push("campaign.usAppToPersonUsecase");
      if (!campaign.messageSamples || campaign.messageSamples.filter(Boolean).length < 1) {
        missing.push("campaign.messageSamples");
      }
      if (!campaign.messageFlow) missing.push("campaign.messageFlow");
      if (missing.length) {
        return res.status(400).json({ error: "Missing required fields", missing });
      }

      const configured = await isTwilioConfigured();
      result.configured = configured;
      if (!configured) {
        return res.status(400).json({ error: "Twilio is not configured on this account", ...result });
      }

      const { getTwilioClient } = await import("./twilio");
      const client = await getTwilioClient();

      // The Twilio Node SDK doesn't expose typed namespaces for trusthub.v1
      // or messaging.v1.brandRegistrations / usAppToPerson, so we narrow to
      // just the fields we actually call. This keeps the SDK strongly typed
      // at the call site instead of relying on a blanket `any`.
      interface SidObject { sid: string }
      interface CustomerProfileInstance extends SidObject {
        update(opts: { status: string }): Promise<SidObject>;
        customerProfilesEntityAssignments: {
          create(opts: { objectSid: string }): Promise<SidObject>;
        };
      }
      interface TrustProductInstance extends SidObject {
        update(opts: { status: string }): Promise<SidObject>;
        trustProductsEntityAssignments: {
          create(opts: { objectSid: string }): Promise<SidObject>;
        };
        trustProductsChannelEndpointAssignment: {
          create(opts: { channelEndpointType: string; channelEndpointSid: string }): Promise<SidObject>;
        };
      }
      interface ListedServicePhoneNumber { sid: string; phoneNumberSid?: string; phoneNumber?: string }
      interface MessagingServiceInstance extends SidObject {
        usAppToPerson: {
          create(opts: {
            brandRegistrationSid: string;
            description: string;
            messageSamples: string[];
            usAppToPersonUsecase: string;
            hasEmbeddedLinks: boolean;
            hasEmbeddedPhone: boolean;
            messageFlow: string;
            optInMessage?: string;
            optInKeywords?: string[];
          }): Promise<SidObject>;
        };
        phoneNumbers: {
          create(opts: { phoneNumberSid: string }): Promise<SidObject>;
          list(opts: { limit: number }): Promise<ListedServicePhoneNumber[]>;
        };
      }
      interface ListedCustomerProfile { sid: string; friendlyName?: string; policySid?: string; status?: string }
      interface ListedTrustProduct { sid: string; friendlyName?: string; policySid?: string; status?: string }
      interface ListedBrandRegistration {
        sid: string;
        customerProfileBundleSid?: string;
        a2pProfileBundleSid?: string;
        status?: string;
      }
      interface ListedService { sid: string; friendlyName?: string }
      interface ListedCampaign {
        sid: string;
        brandRegistrationSid?: string;
        campaignStatus?: string;
      }
      interface MessagingServiceInstanceFull extends MessagingServiceInstance {
        usAppToPerson: MessagingServiceInstance["usAppToPerson"] & {
          list(opts: { limit: number }): Promise<ListedCampaign[]>;
          (sid: string): {
            update(opts: {
              hasEmbeddedLinks: boolean;
              hasEmbeddedPhone: boolean;
              messageSamples: string[];
              messageFlow: string;
              optInMessage?: string;
              optInKeywords?: string[];
              description: string;
              ageGated: boolean;
              directLending: boolean;
            }): Promise<SidObject>;
          };
        };
      }
      interface TwilioApi {
        addresses: {
          create(opts: {
            customerName: string;
            street: string;
            city: string;
            region: string;
            postalCode: string;
            isoCountry: string;
          }): Promise<SidObject>;
        };
        trusthub: {
          v1: {
            customerProfiles: {
              create(opts: { friendlyName: string; email: string; policySid: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedCustomerProfile[]>;
              (sid: string): CustomerProfileInstance;
            };
            trustProducts: {
              create(opts: { friendlyName: string; email: string; policySid: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedTrustProduct[]>;
              (sid: string): TrustProductInstance;
            };
            endUsers: {
              create(opts: { friendlyName: string; type: string; attributes: Record<string, unknown> }): Promise<SidObject>;
            };
          };
        };
        messaging: {
          v1: {
            brandRegistrations: {
              create(opts: {
                customerProfileBundleSid: string;
                a2PProfileBundleSid: string;
                brandType: string;
              }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedBrandRegistration[]>;
            };
            services: {
              create(opts: { friendlyName: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedService[]>;
              (sid: string): MessagingServiceInstanceFull;
            };
          };
        };
      }
      const c = client as unknown as TwilioApi;

      // Well-known Twilio policy SIDs published in the A2P 10DLC onboarding
      // docs. These are stable values that identify the regulatory policy
      // bundle templates and aren't account-specific.
      // https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
      const SECONDARY_CP_POLICY_SID = "RNdfbf3fae0e1107f8aded728e92e0289"; // Secondary Customer Profile
      const A2P_TRUST_PRODUCT_POLICY_SID = "RNb0d4771c2c98518d916a3d4cd70a8f8b"; // A2P Messaging Trust Product

      // ---- Step 1: Customer Profile (Trust Hub) ----------------------------
      // Discover any existing secondary customer profile bundle for this org
      // (matched by friendly name + policy SID) so re-runs after Twilio
      // review don't pile up duplicate unapproved bundles. Only create a new
      // one if none exists.
      const cpFriendlyName = `${business.legalName} Customer Profile`;
      let customerProfileSid: string | null = null;
      let customerProfileReused = false;
      let businessEndUserSid: string | null = null;
      let repEndUserSid: string | null = null;
      let addressSid: string | null = null;
      try {
        let cp: SidObject | null = null;
        try {
          const existing = await c.trusthub.v1.customerProfiles.list({ limit: 100 });
          const match = existing.find(
            (b) => b.policySid === SECONDARY_CP_POLICY_SID && b.friendlyName === cpFriendlyName,
          );
          if (match) {
            cp = { sid: match.sid };
            customerProfileReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] customerProfiles.list failed:", (listErr as Error)?.message);
        }
        if (!cp) {
          cp = await c.trusthub.v1.customerProfiles.create({
            friendlyName: cpFriendlyName,
            email: contact.email!,
            policySid: SECONDARY_CP_POLICY_SID,
          });
        }
        customerProfileSid = cp.sid;

        // On a re-run, the existing bundle already has end users + address
        // attached and is mid-review (or approved). Skip attach/submit work
        // entirely — repeating it produces duplicate end users and Twilio
        // rejects status updates on already-submitted bundles.
        let submitted = false;
        if (!customerProfileReused) {
          try {
            const eu = await c.trusthub.v1.endUsers.create({
              friendlyName: `${business.legalName} business info`,
              type: "customer_profile_business_information",
              attributes: {
                business_name: business.legalName,
                business_type: business.businessType || "LLC",
                business_registration_identifier: "EIN",
                business_registration_number: business.ein,
                business_identity: "direct_customer",
                business_industry: business.industry || "PROFESSIONAL_SERVICES",
                business_regions_of_operation: business.regionsOfOperation || "USA",
                website_url: business.website,
              },
            });
            businessEndUserSid = eu.sid;
            await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: eu.sid });
          } catch (assignErr) {
            console.warn("[a2p/register] business end user attach failed:", (assignErr as Error)?.message);
          }

          try {
            const rep = await c.trusthub.v1.endUsers.create({
              friendlyName: `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || "Authorized Rep",
              type: "authorized_representative_1",
              attributes: {
                first_name: contact.firstName,
                last_name: contact.lastName,
                email: contact.email,
                phone_number: contact.phone,
                business_title: contact.jobTitle || "Owner",
                job_position: "Director",
              },
            });
            repEndUserSid = rep.sid;
            await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: rep.sid });
          } catch (repErr) {
            console.warn("[a2p/register] rep attach failed:", (repErr as Error)?.message);
          }

          if (address.street && address.city && address.region && address.postalCode) {
            try {
              const addr = await c.addresses.create({
                customerName: business.legalName!,
                street: address.street,
                city: address.city,
                region: address.region,
                postalCode: address.postalCode,
                isoCountry: address.isoCountry || "US",
              });
              addressSid = addr.sid;
              await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: addr.sid });
            } catch (addrErr) {
              console.warn("[a2p/register] address attach failed:", (addrErr as Error)?.message);
            }
          }

          try {
            await c.trusthub.v1.customerProfiles(cp.sid).update({ status: "pending-review" });
            submitted = true;
          } catch (subErr) {
            console.warn("[a2p/register] cp submit failed:", (subErr as Error)?.message);
          }
        }

        result.customerProfile = {
          ok: true,
          sid: cp.sid,
          reused: customerProfileReused,
          note: customerProfileReused
            ? "Reusing existing customer profile bundle from a previous submission."
            : submitted
              ? "Customer profile bundle submitted for Twilio review."
              : "Customer profile bundle created. Finish review submission in Twilio Console.",
        };
      } catch (cpErr) {
        result.customerProfile = { ok: false, error: (cpErr as Error)?.message || "customer profile create failed" };
      }

      // ---- Step 1b: A2P Trust Product bundle -------------------------------
      // Same idempotent pattern as the customer profile: look up an existing
      // A2P Messaging Trust Product bundle by friendly name + policy SID and
      // reuse it. Only create + attach + submit when none exists.
      const tpFriendlyName = `${business.legalName} A2P Trust Product`;
      let a2pTrustProductSid: string | null = null;
      let a2pTrustProductReused = false;
      try {
        let tp: SidObject | null = null;
        try {
          const existing = await c.trusthub.v1.trustProducts.list({ limit: 100 });
          const match = existing.find(
            (b) => b.policySid === A2P_TRUST_PRODUCT_POLICY_SID && b.friendlyName === tpFriendlyName,
          );
          if (match) {
            tp = { sid: match.sid };
            a2pTrustProductReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] trustProducts.list failed:", (listErr as Error)?.message);
        }
        if (!tp) {
          tp = await c.trusthub.v1.trustProducts.create({
            friendlyName: tpFriendlyName,
            email: contact.email!,
            policySid: A2P_TRUST_PRODUCT_POLICY_SID,
          });
        }
        a2pTrustProductSid = tp.sid;

        if (!a2pTrustProductReused) {
          for (const objectSid of [businessEndUserSid, repEndUserSid, addressSid, customerProfileSid].filter(
            (s): s is string => !!s,
          )) {
            try {
              await c.trusthub.v1.trustProducts(tp.sid).trustProductsEntityAssignments.create({ objectSid });
            } catch (attachErr) {
              console.warn("[a2p/register] tp attach failed for", objectSid, (attachErr as Error)?.message);
            }
          }

          try {
            await c.trusthub.v1.trustProducts(tp.sid).update({ status: "pending-review" });
          } catch (subErr) {
            console.warn("[a2p/register] tp submit failed:", (subErr as Error)?.message);
          }
        }
      } catch (tpErr) {
        console.warn("[a2p/register] trust product create failed:", (tpErr as Error)?.message);
      }

      // ---- Step 2: Brand registration --------------------------------------
      // Discover an existing brand registration matching our two bundle SIDs
      // before attempting to create one. Brand creation only succeeds after
      // both bundles are approved (1–3 weeks); reusing the existing brand on
      // re-run lets Step 4 (campaign) finally go through without piling up
      // duplicates.
      if (customerProfileSid && a2pTrustProductSid) {
        let brandReused = false;
        let brandSid: string | null = null;
        let brandStatus: string | undefined;
        try {
          const existingBrands = await c.messaging.v1.brandRegistrations.list({ limit: 100 });
          const match = existingBrands.find(
            (b) =>
              b.customerProfileBundleSid === customerProfileSid &&
              b.a2pProfileBundleSid === a2pTrustProductSid,
          );
          if (match) {
            brandSid = match.sid;
            brandStatus = match.status;
            brandReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] brandRegistrations.list failed:", (listErr as Error)?.message);
        }

        if (brandSid) {
          // Reuse — surface the upstream status (APPROVED / PENDING / FAILED).
          // When the brand exists but isn't approved, we still want to expose
          // its SID to the UI without lying about success, so we report
          // ok:true with a status note for APPROVED and ok:false with a
          // "still in review" error otherwise. Step 4 keys off ok:true.
          if (brandStatus === "APPROVED") {
            result.brand = {
              ok: true,
              sid: brandSid,
              reused: true,
              note: "Reusing existing approved brand registration.",
            };
          } else {
            result.brand = {
              ok: false,
              error: `Reusing existing brand ${brandSid} — status is ${brandStatus || "unknown"}. Campaign will be attempted on re-run after Twilio approves the brand.`,
              skipped: true,
            };
          }
        } else {
          try {
            const brand = await c.messaging.v1.brandRegistrations.create({
              customerProfileBundleSid: customerProfileSid,
              a2PProfileBundleSid: a2pTrustProductSid,
              brandType: campaign.brandType || "STANDARD",
            });
            result.brand = { ok: true, sid: brand.sid, reused: false, note: "Brand registration submitted." };
          } catch (brandErr) {
            result.brand = {
              ok: false,
              error: (brandErr as Error)?.message || "brandRegistrations.create failed",
              skipped: false,
            };
          }
        }
      } else {
        result.brand = {
          ok: false,
          error: !customerProfileSid
            ? "Skipped: customer profile bundle was not created."
            : "Skipped: A2P trust product bundle was not created.",
          skipped: true,
        };
      }

      // ---- Step 3: Messaging Service ---------------------------------------
      // Idempotent reuse: discover existing service by friendly name before
      // creating a new one. Independent of brand status — owner needs the
      // service available regardless.
      const svcFriendlyName = `${business.legalName} A2P`;
      let messagingServiceSid: string | null = null;
      let messagingServiceReused = false;
      try {
        try {
          const existingServices = await c.messaging.v1.services.list({ limit: 100 });
          const match = existingServices.find((s) => s.friendlyName === svcFriendlyName);
          if (match) {
            messagingServiceSid = match.sid;
            messagingServiceReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] services.list failed:", (listErr as Error)?.message);
        }
        if (!messagingServiceSid) {
          const svc = await c.messaging.v1.services.create({ friendlyName: svcFriendlyName });
          messagingServiceSid = svc.sid;
        }
        result.messagingService = {
          ok: true,
          sid: messagingServiceSid,
          reused: messagingServiceReused,
          note: messagingServiceReused ? "Reusing existing messaging service." : undefined,
        };
      } catch (svcErr) {
        result.messagingService = { ok: false, error: (svcErr as Error)?.message || "messagingService create failed" };
      }

      // ---- Step 3b: attach the configured From number ----------------------
      // Carriers only enforce A2P rules on traffic sent through a Messaging
      // Service tied to an approved campaign — so the number must live on
      // the service or outbound texts keep hitting 30034 even after approval.
      if (messagingServiceSid) {
        try {
          const { getTwilioFromPhoneNumberSid, getTwilioFromPhoneNumber, listTwilioSmsNumbers } = await import("./twilio");
          const requestedSid = (body.phoneNumberSid || "").trim();
          const phoneNumberSid = requestedSid || (await getTwilioFromPhoneNumberSid());
          if (!phoneNumberSid) {
            result.phoneNumber = {
              ok: false,
              skipped: true,
              error: "Skipped: no Twilio phone number configured to attach.",
            };
          } else {
            // Re-check current attachments so re-runs don't error with
            // "phone number already in service".
            let existingAttachmentSid: string | null = null;
            let existingPhoneNumber: string | undefined;
            try {
              const attached = await c.messaging.v1.services(messagingServiceSid).phoneNumbers.list({ limit: 100 });
              const match = attached.find((p) => p.phoneNumberSid === phoneNumberSid || p.sid === phoneNumberSid);
              if (match) {
                existingAttachmentSid = match.sid;
                existingPhoneNumber = match.phoneNumber;
              }
            } catch (listErr) {
              console.warn("[a2p/register] service phoneNumbers.list failed:", (listErr as Error)?.message);
            }
            // Resolve the E.164 string for *this specific* SID so the result
            // panel doesn't misreport when the owner picked a number other
            // than the default configured one.
            const resolvePhoneNumberFor = async (sid: string): Promise<string | undefined> => {
              try {
                const all = await listTwilioSmsNumbers();
                const hit = all.find((n) => n.sid === sid);
                if (hit) return hit.phoneNumber;
              } catch { /* fall through */ }
              return (await getTwilioFromPhoneNumber()) || undefined;
            };
            if (existingAttachmentSid) {
              result.phoneNumber = {
                ok: true,
                sid: existingAttachmentSid,
                reused: true,
                phoneNumber: existingPhoneNumber || (await resolvePhoneNumberFor(phoneNumberSid)),
                note: "Phone number already attached to this messaging service.",
              };
            } else {
              const attached = await c.messaging.v1.services(messagingServiceSid).phoneNumbers.create({ phoneNumberSid });
              result.phoneNumber = {
                ok: true,
                sid: attached.sid,
                phoneNumber: await resolvePhoneNumberFor(phoneNumberSid),
              };
            }
          }
        } catch (attachErr) {
          result.phoneNumber = {
            ok: false,
            error: (attachErr as Error)?.message || "phoneNumbers.create failed",
          };
        }
      } else {
        result.phoneNumber = {
          ok: false,
          skipped: true,
          error: "Skipped: messaging service was not created.",
        };
      }

      // ---- Step 4: us_app_to_person campaign -------------------------------
      // Requires brand SID (APPROVED) + a messaging service SID. Re-uses an
      // existing campaign on the service when present so re-runs don't
      // duplicate. Only attempts creation when brand registration is
      // ok:true (i.e. approved or freshly created — Twilio itself rejects
      // campaign create when the brand isn't approved yet).
      if (messagingServiceSid && result.brand?.ok && "sid" in result.brand && result.brand.sid) {
        const brandSid = result.brand.sid;
        try {
          let existingCampaignSid: string | null = null;
          let existingCampaignStatus: string | undefined;
          try {
            const existing = await c.messaging.v1.services(messagingServiceSid).usAppToPerson.list({ limit: 10 });
            const match = existing.find((u) => u.brandRegistrationSid === brandSid);
            if (match) {
              existingCampaignSid = match.sid;
              existingCampaignStatus = match.campaignStatus;
            }
          } catch (listErr) {
            console.warn("[a2p/register] usAppToPerson.list failed:", (listErr as Error)?.message);
          }

          if (existingCampaignSid && existingCampaignStatus?.toUpperCase() === "FAILED") {
            try {
              const updated = await c.messaging.v1
                .services(messagingServiceSid)
                .usAppToPerson(existingCampaignSid)
                .update({
                  hasEmbeddedLinks: !!campaign.hasEmbeddedLinks,
                  hasEmbeddedPhone: !!campaign.hasEmbeddedPhone,
                  messageSamples: (campaign.messageSamples || []).filter(Boolean),
                  messageFlow: campaign.messageFlow!,
                  optInMessage: campaign.optInMessage,
                  optInKeywords: (campaign.optInKeywords || []).filter(Boolean),
                  description: campaign.description!,
                  ageGated: false,
                  directLending: false,
                });
              result.campaign = {
                ok: true,
                sid: updated.sid,
                reused: true,
                note: "Updated the rejected campaign with the revised CTA and resubmitted it for review.",
              };
            } catch (updateErr) {
              result.campaign = {
                ok: false,
                error: (updateErr as Error)?.message || "Failed to update the rejected campaign.",
              };
            }
          } else if (existingCampaignSid) {
            result.campaign = {
              ok: true,
              sid: existingCampaignSid,
              reused: true,
              note: "Reusing existing campaign on this messaging service.",
            };
          } else {
            const usaps = await c.messaging.v1.services(messagingServiceSid).usAppToPerson.create({
              brandRegistrationSid: brandSid,
              description: campaign.description!,
              messageSamples: (campaign.messageSamples || []).filter(Boolean),
              usAppToPersonUsecase: campaign.usAppToPersonUsecase!,
              hasEmbeddedLinks: !!campaign.hasEmbeddedLinks,
              hasEmbeddedPhone: !!campaign.hasEmbeddedPhone,
              messageFlow: campaign.messageFlow!,
              optInMessage: campaign.optInMessage,
              optInKeywords: (campaign.optInKeywords || []).filter(Boolean),
            });
            result.campaign = { ok: true, sid: usaps.sid, reused: false };
          }
        } catch (capErr) {
          result.campaign = { ok: false, error: (capErr as Error)?.message || "usAppToPerson.create failed" };
        }
      } else {
        result.campaign = {
          ok: false,
          skipped: true,
          error: !messagingServiceSid
            ? "Skipped: messaging service was not created."
            : "Skipped: brand registration is not yet approved. Re-run the wizard once Twilio approves the brand to submit the campaign.",
        };
      }

      // Persist the submitted body so the Messages page "Fix and resubmit"
      // action can pre-fill the wizard with what the owner sent last time,
      // instead of forcing them to retype everything after a rejection.
      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        const file = path.join(process.cwd(), ".local", "a2p-last-submission.json");
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
          file,
          JSON.stringify({ savedAt: new Date().toISOString(), body }, null, 2),
          "utf8",
        );
      } catch (persistErr) {
        console.warn("[a2p/register] failed to persist last submission:", (persistErr as Error)?.message);
      }

      // Kick the background monitor so any change Twilio reports is
      // pushed to the Messages page banner over SSE within seconds, plus
      // a short burst of follow-ups since Twilio reviews can land a few
      // minutes after a resubmit. The monitor de-dupes by fingerprint, so
      // a no-change cycle won't spam connected clients.
      try {
        const { runA2PMonitorOnce } = await import("./a2p-monitor");
        const kick = (delayMs: number) => {
          setTimeout(() => {
            runA2PMonitorOnce().catch((e) =>
              console.warn("[a2p/register] post-submit monitor run failed:", (e as Error)?.message),
            );
          }, delayMs).unref?.();
        };
        kick(0);
        kick(30_000);
        kick(2 * 60_000);
        kick(5 * 60_000);
      } catch (kickErr) {
        console.warn("[a2p/register] could not schedule post-submit monitor runs:", (kickErr as Error)?.message);
      }

      res.json(result);
    } catch (err: any) {
      console.error("[a2p/register] failed:", err);
      res.status(500).json({ error: err?.message || "registration failed", ...result });
    }
  });

  // Returns the most recent A2P registration submission so the wizard can
  // pre-fill itself for "Fix and resubmit". 404 when nothing has been
  // submitted yet — caller falls back to empty defaults.
  app.get("/api/twilio/a2p/prefill", async (_req, res) => {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const file = path.join(process.cwd(), ".local", "a2p-last-submission.json");
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { savedAt?: string; body?: unknown };
      if (!parsed.body) return res.status(404).json({ error: "no prior submission" });
      res.json({ savedAt: parsed.savedAt || null, body: parsed.body });
    } catch (err: any) {
      if (err?.code === "ENOENT") return res.status(404).json({ error: "no prior submission" });
      res.status(500).json({ error: err?.message || "failed to read prefill" });
    }
  });

  app.post("/api/twilio/test-sms", async (req, res) => {
    try {
      const { to, body } = req.body ?? {};
      if (!to || !body) return res.status(400).json({ error: "to and body required" });
      const result = await sendSms(String(to), String(body));
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("Test SMS failed:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------- Twilio Settings (admin) --------
  {
    const {
      getTwilioSettings,
      updateTwilioSettings,
      listVoicemails,
      getVoicemail,
      updateVoicemail,
      deleteVoicemail,
      listCallLog,
      getCallLogStats,
      deleteCallLog,
    } = await import("./twilio-settings-storage");
    const { updateTwilioSettingsSchema } = await import("@shared/schema");

    app.get("/api/twilio/settings", async (_req, res) => {
      try {
        const settings = await getTwilioSettings();
        res.json(settings);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.patch("/api/twilio/settings", async (req, res) => {
      try {
        const parsed = updateTwilioSettingsSchema.parse(req.body ?? {});
        const settings = await updateTwilioSettings(parsed);
        res.json(settings);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    // ── Custom voicemail greeting audio (stored in Replit KV, played via <Play>) ──
    app.get("/api/twilio/voicemail-greeting/audio", async (_req, res) => {
      try {
        res.json(await getGreetingAudioInfo());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.post(
      "/api/twilio/voicemail-greeting/audio",
      express.raw({ type: () => true, limit: "2mb" }),
      async (req, res) => {
        try {
          const buf = req.body as Buffer;
          if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
            return res.status(400).json({ error: "No audio data received." });
          }
          // Greetings are short, so keep well under the key-value store's per-value
          // limit (base64 adds ~33% overhead): 1.5 MB of audio is roughly 3–4 minutes.
          if (buf.length > 1.5 * 1024 * 1024) {
            return res.status(413).json({ error: "Audio file is too large. Please upload an MP3 or WAV under 1.5 MB (a short greeting is plenty)." });
          }
          const fileName = (req.headers["x-file-name"] || "").toString().slice(0, 120) || undefined;
          // Resolve a Twilio-playable content type; reject anything that isn't MP3/WAV.
          const ct = (req.headers["content-type"] || "").toString().toLowerCase().split(";")[0].trim();
          const mp3 = ["audio/mpeg", "audio/mp3"];
          const wav = ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"];
          let contentType = "";
          if (mp3.includes(ct)) contentType = "audio/mpeg";
          else if (wav.includes(ct)) contentType = "audio/wav";
          else if (ct === "application/octet-stream" || ct === "") {
            // Some browsers omit the type — fall back to the file extension.
            const name = (fileName || "").toLowerCase();
            if (name.endsWith(".mp3")) contentType = "audio/mpeg";
            else if (name.endsWith(".wav")) contentType = "audio/wav";
          }
          if (!contentType) {
            return res.status(415).json({ error: "Unsupported file type. Please upload an MP3 or WAV audio file." });
          }
          await setGreetingAudio(buf, contentType, fileName);
          res.json(await getGreetingAudioInfo());
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    app.delete("/api/twilio/voicemail-greeting/audio", async (_req, res) => {
      try {
        await clearGreetingAudio();
        res.json(await getGreetingAudioInfo());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/twilio/voicemails", async (req, res) => {
      try {
        const unreadOnly = req.query.unread === "true";
        const list = await listVoicemails({ unreadOnly });
        res.json(list);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.patch("/api/twilio/voicemails/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        // Whitelist mutable fields — never accept arbitrary patches
        // (recordingUrl, callSid etc. must not be client-controllable).
        const safe: { listened?: boolean } = {};
        if (typeof req.body?.listened === "boolean") safe.listened = req.body.listened;
        const updated = await updateVoicemail(id, safe);
        if (!updated) return res.status(404).json({ error: "not found" });
        res.json(updated);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    app.delete("/api/twilio/voicemails/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const ok = await deleteVoicemail(id);
        res.json({ success: ok });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    // Stream a voicemail recording through our server (so Twilio HTTP basic-auth
    // is handled server-side and the browser can play it without credentials).
    // Hardened against SSRF: only api.twilio.com URLs are fetched.
    app.get("/api/twilio/voicemails/:id/audio", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const vm = await getVoicemail(id);
        if (!vm?.recordingUrl) return res.status(404).end();

        const rawUrl = `${vm.recordingUrl}.mp3`;
        let parsed: URL;
        try { parsed = new URL(rawUrl); } catch { return res.status(400).end(); }
        if (parsed.protocol !== "https:" || parsed.hostname !== "api.twilio.com") {
          return res.status(400).end();
        }

        // Use the Twilio API key/secret from the Replit connector for Basic auth.
        const { getTwilioClient } = await import("./twilio");
        const client = await getTwilioClient();
        const apiKey = (client as any).username as string;
        const apiSecret = (client as any).password as string;
        if (!apiKey || !apiSecret) {
          console.error("voicemail audio: missing Twilio API key/secret on client");
          return res.status(500).end();
        }
        const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

        const resp = await fetch(parsed.toString(), { headers: { Authorization: `Basic ${auth}` } });
        if (!resp.ok || !resp.body) {
          console.error("voicemail audio: upstream", resp.status);
          // A 404 from Twilio means the recording captured no audio (status
          // "absent" — the caller hung up without leaving a message). Surface
          // that as 404, not 502, so the UI shows a clean "no audio" state
          // instead of looking like a broken server.
          return res.status(resp.status === 404 ? 404 : 502).end();
        }
        res.setHeader("Content-Type", "audio/mpeg");
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
        if (!vm.listened) await updateVoicemail(id, { listened: true });
      } catch (err: any) {
        console.error("voicemail audio stream failed:", err);
        res.status(500).end();
      }
    });

    // -------- Call log --------
    app.get("/api/twilio/call-log", async (_req, res) => {
      try {
        const list = await listCallLog({ limit: 200 });
        res.json(list);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/twilio/call-log/stats", async (_req, res) => {
      try {
        res.json(await getCallLogStats());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.delete("/api/twilio/call-log/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const ok = await deleteCallLog(id);
        res.json({ success: ok });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    // Sync the Twilio Console webhook URLs for the configured number to point
    // at this app's current public hostname. Useful when the Replit URL changes.
    app.post("/api/twilio/sync-webhooks", async (req, res) => {
      try {
        const settings = await getTwilioSettings();
        const proto = (req.get("x-forwarded-proto") || "https").split(",")[0].trim();
        const host = req.get("host");
        const base = `${proto}://${host}`;
        const { getTwilioClient } = await import("./twilio");
        const client = await getTwilioClient();
        const [num] = await client.incomingPhoneNumbers.list({
          phoneNumber: settings.twilioPhoneNumber,
          limit: 1,
        });
        if (!num) return res.status(404).json({ error: `Twilio number ${settings.twilioPhoneNumber} not found on this account` });
        const updated = await client.incomingPhoneNumbers(num.sid).update({
          voiceUrl: `${base}/webhooks/voice/incoming`,
          voiceMethod: "POST",
          voiceFallbackUrl: `${base}/webhooks/voice/incoming`,
          statusCallback: `${base}/webhooks/voice/status`,
          statusCallbackMethod: "POST",
          smsUrl: `${base}/webhooks/sms/incoming`,
          smsMethod: "POST",
          smsFallbackUrl: `${base}/webhooks/sms/incoming`,
        });

        // Also point every provisioned call-tracking number at the same webhooks,
        // so one "Sync all numbers" action keeps the whole account in sync. SMS on
        // tracking numbers now routes to the unified /webhooks/sms/incoming handler.
        const { listTrackingNumbers } = await import("./twilio-tracking-storage");
        const trackingRows = await listTrackingNumbers();
        const tracking: any[] = [];
        for (const tn of trackingRows) {
          if (!tn.twilioSid) { tracking.push({ id: tn.id, phoneNumber: tn.phoneNumber, skipped: "no twilio sid" }); continue; }
          try {
            await client.incomingPhoneNumbers(tn.twilioSid).update({
              voiceUrl: `${base}/webhooks/voice/incoming`,
              voiceMethod: "POST",
              statusCallback: `${base}/webhooks/voice/status`,
              statusCallbackMethod: "POST",
              smsUrl: `${base}/webhooks/sms/incoming`,
              smsMethod: "POST",
            });
            tracking.push({ id: tn.id, phoneNumber: tn.phoneNumber, updated: true });
          } catch (e: any) {
            tracking.push({ id: tn.id, phoneNumber: tn.phoneNumber, error: e?.message || "update failed" });
          }
        }

        res.json({
          success: true,
          base,
          voiceUrl: updated.voiceUrl,
          smsUrl: updated.smsUrl,
          statusCallback: updated.statusCallback,
          main: { phoneNumber: settings.twilioPhoneNumber, updated: true },
          tracking,
        });
      } catch (err: any) {
        console.error("sync-webhooks failed:", err);
        res.status(500).json({ error: err.message });
      }
    });
  }

  // -------- Messaging (text customers directly) --------
  {
    const { listSmsConversations, listSmsMessages, createSmsMessage, deleteSmsMessage, deleteSmsConversation } =
      await import("./twilio-tracking-storage");

    // Conversation list (one row per counterparty number, latest message first)
    app.get("/api/sms/threads", async (_req, res) => {
      try {
        const threads = await listSmsConversations();

        // Enrich with CRM contact name when we can match on phone digits
        const contacts = await storage.getCrmContacts();
        const norm = (s: string) => (s || "").replace(/\D/g, "").replace(/^1/, "");
        const byPhone = new Map<string, { id: number; name: string }>();
        for (const c of contacts) {
          const name = (c.fullName ?? "").trim() || c.company || "";
          for (const p of [c.mobilePhone, c.officePhone].filter(Boolean) as string[]) {
            const k = norm(p);
            if (k && !byPhone.has(k)) byPhone.set(k, { id: c.id, name });
          }
        }

        const enriched = threads.map((t) => {
          const match = byPhone.get(norm(t.counterparty));
          return { ...t, contactId: match?.id ?? null, contactName: match?.name ?? null };
        });
        res.json(enriched);
      } catch (e: any) {
        console.error("GET /api/sms/threads failed:", e);
        res.status(500).json({ error: e?.message || "Failed to load threads" });
      }
    });

    // Full message history with one counterparty (oldest first for the UI)
    app.get("/api/sms/messages", async (req, res) => {
      try {
        const peer = String(req.query.peer || "");
        if (!peer) return res.status(400).json({ error: "peer query param required" });
        const list = await listSmsMessages({ counterparty: peer, limit: 500 });
        res.json(list.slice().reverse());
      } catch (e: any) {
        console.error("GET /api/sms/messages failed:", e);
        res.status(500).json({ error: e?.message || "Failed to load messages" });
      }
    });

    // Send a text. When `from` is a provisioned call-tracking number, reply from
    // that number directly so the customer sees the line they contacted; otherwise
    // send from the main business line via sendSms (A2P messaging service),
    // which persists its own outbound row.
    app.post("/api/sms/send", async (req, res) => {
      try {
        const { to, body, from } = req.body ?? {};
        if (!to || !body) return res.status(400).json({ error: "to and body are required" });
        if (!isTwilioConfigured()) return res.status(400).json({ error: "Twilio is not configured" });

        const fromNum = from ? String(from).trim() : "";
        if (fromNum && fromNum !== "default") {
          const { getTrackingNumberByPhone } = await import("./twilio-tracking-storage");
          const tn = await getTrackingNumberByPhone(fromNum);
          if (tn) {
            // Reply from the tracking number the customer texted.
            const { getTwilioClient, toE164 } = await import("./twilio");
            const client = await getTwilioClient();
            const msg = await client.messages.create({ to: toE164(String(to)), from: tn.phoneNumber, body: String(body) });
            await createSmsMessage({
              messageSid: msg.sid, fromNumber: tn.phoneNumber, toNumber: toE164(String(to)),
              body: String(body), direction: "outbound", status: msg.status || "sent", trackingNumberId: tn.id,
            } as any).catch(() => {});
            return res.json({ success: true, sid: msg.sid, to: msg.to, from: msg.from, status: msg.status });
          }
        }

        const result = await sendSms(String(to), String(body));
        res.json({ success: true, ...result });
      } catch (e: any) {
        console.error("POST /api/sms/send failed:", e);
        res.status(500).json({ success: false, error: e?.message || "Send failed" });
      }
    });

    // Delete a whole conversation (all messages with one counterparty)
    app.delete("/api/sms/threads/:peer", async (req, res) => {
      try {
        const peer = String(req.params.peer || "");
        if (!peer) return res.status(400).json({ error: "peer is required" });
        const count = await deleteSmsConversation(peer);
        res.json({ success: true, deleted: count });
      } catch (e: any) {
        console.error("DELETE /api/sms/threads failed:", e);
        res.status(500).json({ error: e?.message || "Failed to delete conversation" });
      }
    });

    // Delete a single message by id
    app.delete("/api/sms/messages/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid message id" });
        const deleted = await deleteSmsMessage(id);
        if (!deleted) return res.status(404).json({ error: "Message not found" });
        res.json({ success: true });
      } catch (e: any) {
        console.error("DELETE /api/sms/messages failed:", e);
        res.status(500).json({ error: e?.message || "Failed to delete message" });
      }
    });
  }

  // Booking platform — service catalog, availability, slot locks, appointments
  registerBookingRoutes(app);
  startSlotLockSweeper();

  // A2P 10DLC background monitor — proactively alerts the account owner when
  // brand/campaign registration transitions to rejected/failed so outbound
  // texts don't silently fail with carrier error 30034.
  const { startA2PMonitor } = await import("./a2p-monitor");
  startA2PMonitor();
  seedBookingDefaults()
    .then(r => console.log(`[booking] seed complete: ${r.serviceCount} new services, resource #${r.resourceId}`))
    .catch(err => console.error("[booking] seed failed:", err));

  // Keep the local device list in sync with the MeshCentral server. Runs once
  // shortly after startup and then on an interval. No-ops when not configured.
  if (meshCentralService.isConfigured()) {
    // Self-scheduling sync with exponential backoff. On success we poll at the
    // base interval; on failure we back off (up to a cap) instead of retrying
    // every minute. This matters because repeated failed logins trip
    // MeshCentral's invalid-login IP throttle — a fixed 60s retry would keep the
    // server's IP permanently blocked and never let the cooldown expire.
    const BASE_INTERVAL = 60_000;
    const MAX_INTERVAL = 15 * 60_000;
    let delay = BASE_INTERVAL;
    const runSync = async () => {
      try {
        const r = await meshCentralService.syncDevices();
        if (r.error) {
          console.warn("[meshcentral] device sync error:", r.error);
          delay = Math.min(delay * 2, MAX_INTERVAL);
        } else {
          console.log(`[meshcentral] device sync: ${r.synced} machine(s)`);
          delay = BASE_INTERVAL;
        }
      } catch (err) {
        console.error("[meshcentral] device sync failed:", err);
        delay = Math.min(delay * 2, MAX_INTERVAL);
      } finally {
        setTimeout(runSync, delay);
      }
    };
    setTimeout(runSync, 10_000);
  }

  const httpServer = createServer(app);
  return httpServer;
}
