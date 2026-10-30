/**
 * MeshCentral Service - thin wrapper around the real MeshCentral Web API.
 *
 * IMPORTANT: This module no longer tries to spawn MeshCentral inside the
 * Replit container. Replit only exposes one public port, so a self-spawned
 * MeshCentral could never accept agent connections from the open internet.
 * Instead, point this app at a real MeshCentral server you host yourself
 * (see docs/meshcentral-setup.md) by setting:
 *
 *   MESHCENTRAL_URL          e.g. https://mesh.csdinc.com
 *   MESHCENTRAL_USERNAME     admin user on that server
 *   MESHCENTRAL_PASSWORD     admin password
 *   MESHCENTRAL_API_KEY      (optional) API key as an alternative to user/pass
 */

import { getMeshCentralClient } from './meshcentral';
import { storage } from './storage';
import type { InsertDevice } from '@shared/schema';

/**
 * Stable, dedicated marker for the alerts the autonomous monitor owns. Matching
 * on this (not on title text) is what lets us dedupe and auto-resolve safely —
 * the wording of an alert title must never be load-bearing.
 */
const MONITOR_ALERT_SOURCE = "meshcentral-monitor";

export interface MeshCentralDevice {
  meshid: string;
  nodeid: string;
  name: string;
  state: number;
  conn: number;
  addr: string;
  desc?: string;
  icon?: number;
  groupid?: string;
}

export interface MeshCentralSession {
  sessionid: string;
  userid: string;
  username: string;
  deviceid: string;
  devicename: string;
  protocol: string;
  startTime: Date;
  lastActivity: Date;
  type: 'desktop' | 'terminal' | 'files';
}

class MeshCentralService {
  private syncing = false;
  // Resolved once from the server (or MESHCENTRAL_DEFAULT_MESH_ID) and reused.
  private cachedMeshId?: string;

  constructor() {
    if (process.env.MESHCENTRAL_URL) {
      console.log(`MeshCentral configured: ${process.env.MESHCENTRAL_URL}`);
    } else {
      console.log('MeshCentral not configured (MESHCENTRAL_URL missing)');
    }
  }

  /**
   * True when env credentials are present so the real client can connect.
   * MeshCentral has no usable REST/API-key path here — auth is the web form
   * login — so username + password are both required.
   */
  isConfigured(): boolean {
    return Boolean(
      process.env.MESHCENTRAL_URL &&
        process.env.MESHCENTRAL_USERNAME &&
        process.env.MESHCENTRAL_PASSWORD,
    );
  }

  getServerUrl(): string {
    return process.env.MESHCENTRAL_URL || '';
  }

  getWebInterface(): string {
    return process.env.MESHCENTRAL_URL || '';
  }

  private mapDevices(raw: any[]): MeshCentralDevice[] {
    return (raw || []).map((d: any) => ({
      meshid: d.meshid,
      nodeid: d._id || d.nodeid,
      name: d.name,
      state: d.state ?? 0,
      conn: d.conn ?? 0,
      addr: d.ip || d.host || '',
      desc: d.desc || d.osdesc,
      icon: d.icon,
      groupid: d.meshid,
    }));
  }

  /** Returns devices from the configured MeshCentral server. Empty if unconfigured or on error. */
  async getDevices(): Promise<MeshCentralDevice[]> {
    try {
      return await this.getDevicesStrict();
    } catch (err) {
      console.error('MeshCentral getDevices failed:', err);
      return [];
    }
  }

  /**
   * Like getDevices() but throws on fetch failure instead of returning [].
   * Used by syncDevices so a real failure is reported rather than recorded as a
   * successful sync of zero devices.
   */
  async getDevicesStrict(): Promise<MeshCentralDevice[]> {
    const client = getMeshCentralClient();
    if (!client) return [];
    await client.authenticate();
    const raw = await client.getDevicesStrict();
    return this.mapDevices(raw);
  }

  /**
   * Active session listing is not exposed by MeshCentral's HTTP API for
   * cross-device aggregation. Use storage.getActiveRemoteSessions() in
   * routes for our own bookkeeping.
   */
  async getActiveSessions(): Promise<MeshCentralSession[]> {
    return [];
  }

  /** Generate a launch URL for a given session type against a real server. */
  async createRemoteSession(
    deviceId: string,
    sessionType: 'desktop' | 'terminal' | 'files',
  ): Promise<string | null> {
    const base = process.env.MESHCENTRAL_URL;
    if (!base) return null;
    const baseUrl = base.replace(/\/$/, '');
    switch (sessionType) {
      case 'desktop':
        return `${baseUrl}/desktop.ashx?node=${encodeURIComponent(deviceId)}&viewmode=2&hide=31`;
      case 'terminal':
        return `${baseUrl}/terminal.ashx?node=${encodeURIComponent(deviceId)}`;
      case 'files':
        return `${baseUrl}/files.ashx?node=${encodeURIComponent(deviceId)}`;
      default:
        return `${baseUrl}/desktop.ashx?node=${encodeURIComponent(deviceId)}&viewmode=2&hide=31`;
    }
  }

  /**
   * MeshCentral agent-type IDs for the meshagents download endpoint. Verified
   * against remote.computersystemsdepot.com to return real installers:
   *   4     = Windows (64-bit) interactive installer (.exe)
   *   10005 = macOS universal installer (.pkg)
   *   6     = Linux (64-bit) agent binary
   * installflags=0 keeps it interactive (the customer sees a Connect/Install
   * window) rather than a silent service install.
   */
  private static readonly AGENT_TYPES: Record<string, { id: number; name: string }> = {
    windows: { id: 4, name: 'Windows (64-bit)' },
    mac: { id: 10005, name: 'macOS (Intel & Apple Silicon)' },
    linux: { id: 6, name: 'Linux (64-bit)' },
  };

  /**
   * Resolve the device group (mesh) ID that customer agents install into. Uses
   * MESHCENTRAL_DEFAULT_MESH_ID when set; otherwise auto-detects it from the
   * server (first agent-type group). Returns the value already stripped of the
   * `mesh//` prefix, which is the form the meshagents download URL requires.
   * Cached after the first successful lookup.
   */
  async resolveAgentMeshId(): Promise<string | null> {
    const strip = (v: string) => v.replace(/^mesh\/\//, '');
    const override = process.env.MESHCENTRAL_DEFAULT_MESH_ID;
    if (override && override !== 'mesh_default') return strip(override);
    if (this.cachedMeshId) return this.cachedMeshId;
    if (!this.isConfigured()) return null;
    const client = getMeshCentralClient();
    if (!client) return null;
    const authed = await client.authenticate();
    if (!authed) return null;
    const meshes = await client.getMeshes();
    const agentMesh = meshes.find((m) => m.mtype === 2) || meshes[0];
    if (!agentMesh?._id) return null;
    this.cachedMeshId = strip(agentMesh._id);
    return this.cachedMeshId;
  }

  /**
   * Build the direct MeshCentral download URL for a customer agent installer,
   * or null if MeshCentral is unconfigured / no device group can be resolved.
   */
  async getAgentDownloadUrl(
    platform: 'windows' | 'mac' | 'linux',
  ): Promise<string | null> {
    const base = process.env.MESHCENTRAL_URL;
    const type = MeshCentralService.AGENT_TYPES[platform];
    if (!base || !type) return null;
    const meshId = await this.resolveAgentMeshId();
    if (!meshId) return null;
    const baseUrl = base.replace(/\/$/, '');
    return `${baseUrl}/meshagents?id=${type.id}&meshid=${meshId}&installflags=0`;
  }

  /** Return downloadable agent installer URLs from the real server. */
  async getAgentInstallers(): Promise<{ platform: string; url: string; name: string }[]> {
    const out: { platform: string; url: string; name: string }[] = [];
    for (const platform of ['windows', 'mac', 'linux'] as const) {
      const url = await this.getAgentDownloadUrl(platform);
      if (url) out.push({ platform, url, name: MeshCentralService.AGENT_TYPES[platform].name });
    }
    return out;
  }

  async getDeviceInfo(deviceId: string): Promise<MeshCentralDevice | null> {
    const devices = await this.getDevices();
    return devices.find((d) => d.nodeid === deviceId) || null;
  }

  /**
   * Pull the device list from the configured MeshCentral server and upsert each
   * machine into our local `devices` table (matched by meshNodeId). This is what
   * makes Device Management, Real-Time Monitoring and Network Discovery show real
   * machines instead of placeholders. No-ops cleanly when MeshCentral is not
   * configured. Note: this syncs device identity and online/offline presence;
   * live CPU/RAM telemetry requires the agent to report it separately.
   */
  async syncDevices(): Promise<{
    configured: boolean;
    synced: number;
    created?: number;
    updated?: number;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { configured: false, synced: 0 };
    }
    // Prevent overlapping runs (manual click landing during the interval) so two
    // syncs can't race to create the same device.
    if (this.syncing) {
      return { configured: true, synced: 0, error: "A sync is already in progress." };
    }
    this.syncing = true;
    try {
      const client = getMeshCentralClient();
      if (!client) {
        return { configured: false, synced: 0 };
      }
      // Surface auth failures instead of silently reporting a successful 0-device
      // sync — the most common real failure is a bad URL or wrong credentials.
      const authenticated = await client.authenticate();
      if (!authenticated) {
        return {
          configured: true,
          synced: 0,
          error:
            client.getLastAuthError() ||
            "MeshCentral authentication failed — check the server URL and credentials.",
        };
      }

      const meshDevices = await this.getDevicesStrict();
      const existing = await storage.getDevices();
      const byNode = new Map(
        existing.filter((d) => d.meshNodeId).map((d) => [d.meshNodeId as string, d]),
      );

      let created = 0;
      let updated = 0;
      for (const md of meshDevices) {
        if (!md.nodeid) continue;
        const isOnline = (md.conn ?? 0) > 0 || md.state === 1;
        const status = isOnline ? "online" : "offline";
        const found = byNode.get(md.nodeid);

        if (found) {
          const wasOffline = found.status === "offline";
          await storage.updateDevice(found.id, {
            name: md.name || found.name,
            status,
            ipAddress: md.addr || found.ipAddress,
            operatingSystem: md.desc || found.operatingSystem,
            meshId: md.meshid || md.groupid || found.meshId,
            lastSeen: new Date(),
          });
          updated++;
          // Autonomous monitoring: raise an alert the moment a known device drops
          // offline, and auto-resolve it when the device comes back. We only act
          // on a *transition* so a device that is simply still offline (or still
          // online) doesn't spam new alerts every sync cycle.
          if (!wasOffline && !isOnline) {
            await this.raiseOfflineAlert(found.id, md.name || found.name, found.type);
          } else if (wasOffline && isOnline) {
            await this.clearOfflineAlert(found.id);
          }
        } else {
          const newDevice: InsertDevice = {
            name: md.name || md.nodeid,
            type: "workstation",
            status,
            ipAddress: md.addr || undefined,
            operatingSystem: md.desc || undefined,
            meshNodeId: md.nodeid,
            meshId: md.meshid || md.groupid || undefined,
          };
          await storage.createDevice(newDevice);
          created++;
          // Intentionally no alert on first enrollment: a brand-new device that
          // happens to be offline at discovery is not an incident.
        }
      }
      return { configured: true, synced: created + updated, created, updated };
    } catch (err: any) {
      console.error("MeshCentral device sync failed:", err);
      return { configured: true, synced: 0, error: err?.message || "sync failed" };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Marker used to recognise the alerts this monitor owns, so we never create a
   * duplicate for a device that is already flagged offline and we only resolve
   * the alerts we raised ourselves.
   */
  private isOfflineAlert(a: { deviceId?: number | null; alertSource?: string | null }, deviceId: number): boolean {
    return a.deviceId === deviceId && a.alertSource === MONITOR_ALERT_SOURCE;
  }

  /** Create a single "device offline" alert if one isn't already open for it. */
  private async raiseOfflineAlert(deviceId: number, name: string, type: string): Promise<void> {
    try {
      const active = await storage.getActiveAlerts();
      if (active.some((a) => this.isOfflineAlert(a, deviceId))) return;
      const isServer = type === "server";
      await storage.createAlert({
        title: `Device offline: ${name}`,
        description: `${name} stopped responding and is now offline. Detected automatically by MeshCentral monitoring.`,
        severity: isServer ? "critical" : "high",
        category: "network",
        deviceId,
        status: "active",
        alertSource: MONITOR_ALERT_SOURCE,
        isEmergency: isServer,
      });
      console.log(`[meshcentral] alert raised: ${name} offline`);
    } catch (err) {
      console.error("[meshcentral] failed to raise offline alert:", err);
    }
  }

  /** Resolve any open offline alert(s) we raised for a device that's back online. */
  private async clearOfflineAlert(deviceId: number): Promise<void> {
    try {
      const active = await storage.getActiveAlerts();
      for (const a of active) {
        if (this.isOfflineAlert(a, deviceId)) {
          await storage.updateAlert(a.id, { status: "resolved", resolvedAt: new Date() });
          console.log(`[meshcentral] alert resolved: device ${deviceId} back online`);
        }
      }
    } catch (err) {
      console.error("[meshcentral] failed to clear offline alert:", err);
    }
  }
}

export const meshCentralService = new MeshCentralService();
