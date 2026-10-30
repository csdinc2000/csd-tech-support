import axios, { AxiosInstance } from 'axios';
import https from 'node:https';
import { WebSocket } from 'ws';

interface MeshCentralConfig {
  url: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

interface MeshDevice {
  _id: string;
  name: string;
  host: string;
  desc: string;
  ip: string;
  osdesc: string;
  state: number; // 0=disconnected, 1=connected
  conn: number;
  pwr: number;
  lastSeen: string;
  meshid: string;
}

interface MeshGroup {
  _id: string;
  name: string;
  desc?: string;
  mtype?: number; // 2 = agent device group
}

interface RemoteAccessSession {
  deviceId: string;
  sessionType: 'desktop' | 'terminal' | 'files' | 'chat';
  duration?: number;
  recording?: boolean;
}

export class MeshCentralClient {
  private client: AxiosInstance;
  private config: MeshCentralConfig;
  private authCookie?: string;
  private authCookieAt = 0;
  private lastAuthError?: string;
  // Reuse a successful login session instead of re-authenticating on every
  // status/sync call. Fewer logins = far less chance of tripping MeshCentral's
  // invalid-login IP throttle, and lower latency on each request.
  private static readonly COOKIE_TTL_MS = 5 * 60_000;

  constructor(config: MeshCentralConfig) {
    this.config = config;
    // MeshCentral commonly serves its own self-signed certificate (its agents
    // pin the cert hash rather than relying on a public CA). When the operator
    // opts in via MESHCENTRAL_ALLOW_INSECURE_TLS=true, accept that cert so the
    // API client can connect. Defaults to secure (reject untrusted certs).
    const allowInsecureTls = process.env.MESHCENTRAL_ALLOW_INSECURE_TLS === 'true';
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: !allowInsecureTls }),
    });
    this.client.defaults.baseURL = config.url;
  }

  /**
   * Authenticate with MeshCentral server
   */
  async authenticate(): Promise<boolean> {
    try {
      if (!this.config.username || !this.config.password) {
        throw new Error('MeshCentral requires MESHCENTRAL_USERNAME and MESHCENTRAL_PASSWORD');
      }
      // Reuse a still-fresh session cookie rather than logging in again. This is
      // the main defense against MeshCentral's invalid-login IP throttle: a burst
      // of status/sync calls now costs at most one login per TTL window.
      if (this.authCookie && Date.now() - this.authCookieAt < MeshCentralClient.COOKIE_TTL_MS) {
        return true;
      }
      this.authCookie = await this.loginForCookie(this.config.username, this.config.password);
      this.authCookieAt = Date.now();
      this.lastAuthError = undefined;
      return !!this.authCookie;
    } catch (error) {
      this.authCookie = undefined;
      this.authCookieAt = 0;
      this.lastAuthError = error instanceof Error ? error.message : String(error);
      console.error('MeshCentral authentication failed:', error);
      return false;
    }
  }

  /**
   * Reason the last authenticate() attempt failed, if any (e.g. server
   * unreachable vs. bad credentials). Cleared on a successful login.
   */
  getLastAuthError(): string | undefined {
    return this.lastAuthError;
  }

  /**
   * Perform MeshCentral's web login (form POST) and return a Cookie header
   * string for the authenticated session. MeshCentral exposes no JSON REST API:
   * a successful login responds with an HTTP redirect plus an elevated session
   * cookie, while a failed login re-renders the login page (HTTP 200).
   */
  private async loginForCookie(username: string, password: string): Promise<string> {
    const jar: Record<string, string> = {};
    const absorb = (headers: any) => {
      const sc = headers?.['set-cookie'];
      if (Array.isArray(sc)) {
        for (const c of sc) {
          const [pair] = c.split(';');
          const i = pair.indexOf('=');
          if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1);
        }
      }
    };
    const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

    // A connection-level failure (server off, DNS gone, TLS handshake refused)
    // or an HTTP 5xx (e.g. Cloudflare 521/522/523 = origin down) means the
    // MeshCentral server itself is unreachable — not a credentials problem.
    // Surface that distinctly so the UI doesn't tell the operator to "check the
    // password" when the box is simply down.
    const request = async (fn: () => Promise<any>, what: string) => {
      let resp: any;
      try {
        resp = await fn();
      } catch (e: any) {
        const code = e?.code || e?.message || 'connection error';
        throw new Error(`MeshCentral server unreachable (${code}) — the server appears to be down or the URL is wrong.`);
      }
      if (resp.status >= 500) {
        throw new Error(`MeshCentral server unreachable (HTTP ${resp.status}) — the server appears to be down (origin not responding).`);
      }
      return resp;
    };

    // Prime the session cookie (xid / xid.sig).
    const initial = await request(
      () => this.client.get('/', { maxRedirects: 0, validateStatus: () => true }),
      'GET /',
    );
    absorb(initial.headers);

    const body = new URLSearchParams({ username, password, action: 'login', urlargs: '' }).toString();
    const res = await request(
      () => this.client.post('/login', body, {
        maxRedirects: 0,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() },
      }),
      'POST /login',
    );
    absorb(res.headers);

    // MeshCentral signals the login outcome in one of two ways depending on
    // version/config:
    //   - some setups redirect (3xx) to the console on success;
    //   - this server returns HTTP 200, re-renders the page, and embeds a numeric
    //     result code as `var messageid = parseInt('NNN')`. Codes >= 100 are
    //     login failures (112 = bad username/password, 110 = account locked,
    //     114 = IP address blocked). A successful login carries no failure code
    //     and refreshes the session cookie.
    const isRedirect = res.status >= 300 && res.status < 400;
    if (!isRedirect) {
      const bodyStr = typeof res.data === 'string' ? res.data : '';
      const match = bodyStr.match(/messageid\s*=\s*parseInt\(['"](\d+)['"]\)/);
      const code = match ? parseInt(match[1], 10) : 0;
      if (code >= 100) {
        const reason =
          code === 110 ? 'account locked'
          : code === 114 ? 'IP address temporarily blocked (too many attempts)'
          : code === 112 ? 'bad username or password'
          : `login error code ${code}`;
        throw new Error(`MeshCentral login failed (${reason}) — check MESHCENTRAL_USERNAME and MESHCENTRAL_PASSWORD.`);
      }
    }
    return cookieHeader();
  }

  /**
   * Get all devices from MeshCentral. Safe wrapper: returns [] on failure.
   */
  async getDevices(): Promise<MeshDevice[]> {
    try {
      return await this.getDevicesStrict();
    } catch (error) {
      console.error('Failed to fetch MeshCentral devices:', error);
      return [];
    }
  }

  /**
   * Like getDevices() but throws on failure instead of swallowing the error.
   * Fetches the node list over MeshCentral's WebSocket control channel
   * (/control.ashx) — the only interface that exposes device data.
   */
  async getDevicesStrict(): Promise<MeshDevice[]> {
    if (!this.authCookie) {
      const ok = await this.authenticate();
      if (!ok) throw new Error('MeshCentral authentication failed');
    }
    try {
      return await this.fetchNodesViaControlChannel(this.authCookie!);
    } catch (error) {
      // A stale/expired session cookie shows up as the control channel
      // rejecting auth. Re-login once and retry before giving up.
      if (error instanceof Error && /reject|noauth|HTTP 401|HTTP 403/i.test(error.message)) {
        this.authCookie = undefined;
        const ok = await this.authenticate();
        if (!ok) throw new Error('MeshCentral authentication failed');
        return await this.fetchNodesViaControlChannel(this.authCookie!);
      }
      throw error;
    }
  }

  /**
   * Open the MeshCentral control WebSocket, request the node list, and resolve
   * with the flattened device array once the `nodes` message arrives.
   */
  private fetchNodesViaControlChannel(cookie: string): Promise<MeshDevice[]> {
    const wsUrl = this.config.url.replace(/\/+$/, '').replace(/^http/i, 'ws') + '/control.ashx';
    const rejectUnauthorized = process.env.MESHCENTRAL_ALLOW_INSECURE_TLS !== 'true';
    return new Promise<MeshDevice[]>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { rejectUnauthorized, headers: { Cookie: cookie } });
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (cb: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* ignore */ }
        cb();
      };
      timer = setTimeout(
        () => settle(() => reject(new Error('Timed out waiting for MeshCentral node list'))),
        20000,
      );
      socket.on('open', () => {
        try { socket.send(JSON.stringify({ action: 'nodes' })); } catch { /* ignore */ }
      });
      socket.on('message', (data: any) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.action === 'nodes') {
          const groups = msg.nodes || {};
          const flat = Object.values(groups).flat() as MeshDevice[];
          settle(() => resolve(flat));
        } else if (msg.action === 'close' || msg.action === 'serverError') {
          settle(() => reject(new Error('MeshCentral rejected the control session: ' + (msg.cause || msg.msg || 'unknown'))));
        }
      });
      socket.on('error', (err: Error) => settle(() => reject(err)));
      socket.on('unexpected-response', (_req: any, res: any) =>
        settle(() => reject(new Error('MeshCentral control channel HTTP ' + res.statusCode))),
      );
    });
  }

  /**
   * List the device groups (meshes) on the server. Used to resolve the mesh ID
   * that the customer agent installer must be tied to, so we don't depend on a
   * hand-entered MESHCENTRAL_DEFAULT_MESH_ID. Authenticates (and retries once on
   * a stale cookie) just like getDevicesStrict().
   */
  async getMeshes(): Promise<MeshGroup[]> {
    if (!this.authCookie) {
      const ok = await this.authenticate();
      if (!ok) throw new Error('MeshCentral authentication failed');
    }
    try {
      return await this.fetchMeshesViaControlChannel(this.authCookie!);
    } catch (error) {
      if (error instanceof Error && /reject|noauth|HTTP 401|HTTP 403/i.test(error.message)) {
        this.authCookie = undefined;
        const ok = await this.authenticate();
        if (!ok) throw new Error('MeshCentral authentication failed');
        return await this.fetchMeshesViaControlChannel(this.authCookie!);
      }
      throw error;
    }
  }

  /**
   * Open the MeshCentral control WebSocket, request the mesh list, and resolve
   * with the meshes array once the `meshes` message arrives.
   */
  private fetchMeshesViaControlChannel(cookie: string): Promise<MeshGroup[]> {
    const wsUrl = this.config.url.replace(/\/+$/, '').replace(/^http/i, 'ws') + '/control.ashx';
    const rejectUnauthorized = process.env.MESHCENTRAL_ALLOW_INSECURE_TLS !== 'true';
    return new Promise<MeshGroup[]>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { rejectUnauthorized, headers: { Cookie: cookie } });
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (cb: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* ignore */ }
        cb();
      };
      timer = setTimeout(
        () => settle(() => reject(new Error('Timed out waiting for MeshCentral mesh list'))),
        20000,
      );
      socket.on('open', () => {
        try { socket.send(JSON.stringify({ action: 'meshes' })); } catch { /* ignore */ }
      });
      socket.on('message', (data: any) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.action === 'meshes') {
          settle(() => resolve((msg.meshes || []) as MeshGroup[]));
        } else if (msg.action === 'close' || msg.action === 'serverError') {
          settle(() => reject(new Error('MeshCentral rejected the control session: ' + (msg.cause || msg.msg || 'unknown'))));
        }
      });
      socket.on('error', (err: Error) => settle(() => reject(err)));
      socket.on('unexpected-response', (_req: any, res: any) =>
        settle(() => reject(new Error('MeshCentral control channel HTTP ' + res.statusCode))),
      );
    });
  }

  /**
   * Get device status and information
   */
  async getDeviceInfo(deviceId: string): Promise<MeshDevice | null> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'node',
        nodeid: deviceId
      });

      return response.data || null;
    } catch (error) {
      console.error(`Failed to fetch device info for ${deviceId}:`, error);
      return null;
    }
  }

  /**
   * Start remote desktop session
   */
  async startRemoteDesktop(deviceId: string, recording = true): Promise<string | null> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'desktop',
        nodeid: deviceId,
        recording: recording
      });

      if (response.data && response.data.url) {
        return `${this.config.url}${response.data.url}`;
      }

      return null;
    } catch (error) {
      console.error(`Failed to start remote desktop for ${deviceId}:`, error);
      return null;
    }
  }

  /**
   * Start terminal session
   */
  async startTerminal(deviceId: string): Promise<string | null> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'terminal',
        nodeid: deviceId
      });

      if (response.data && response.data.url) {
        return `${this.config.url}${response.data.url}`;
      }

      return null;
    } catch (error) {
      console.error(`Failed to start terminal for ${deviceId}:`, error);
      return null;
    }
  }

  /**
   * Start file manager session
   */
  async startFileManager(deviceId: string): Promise<string | null> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'files',
        nodeid: deviceId
      });

      if (response.data && response.data.url) {
        return `${this.config.url}${response.data.url}`;
      }

      return null;
    } catch (error) {
      console.error(`Failed to start file manager for ${deviceId}:`, error);
      return null;
    }
  }

  /**
   * Execute command on remote device
   */
  async executeCommand(deviceId: string, command: string): Promise<any> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'runcommands',
        nodeid: deviceId,
        type: 1, // Shell command
        cmds: command,
        runAsUser: 0
      });

      return response.data;
    } catch (error) {
      console.error(`Failed to execute command on ${deviceId}:`, error);
      return null;
    }
  }

  /**
   * Send chat message to device
   */
  async sendChatMessage(deviceId: string, message: string): Promise<boolean> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'msg',
        nodeid: deviceId,
        type: 'messagebox',
        title: 'Computer Systems Depot Tech Support',
        msg: message
      });

      return response.data && response.data.result === 'ok';
    } catch (error) {
      console.error(`Failed to send chat message to ${deviceId}:`, error);
      return false;
    }
  }

  /**
   * Get active sessions for a device
   */
  async getActiveSessions(deviceId: string): Promise<any[]> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'sessions',
        nodeid: deviceId
      });

      return response.data && response.data.sessions ? response.data.sessions : [];
    } catch (error) {
      console.error(`Failed to get active sessions for ${deviceId}:`, error);
      return [];
    }
  }

  /**
   * Disconnect all sessions for a device
   */
  async disconnectAllSessions(deviceId: string): Promise<boolean> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'disconnect',
        nodeid: deviceId
      });

      return response.data && response.data.result === 'ok';
    } catch (error) {
      console.error(`Failed to disconnect sessions for ${deviceId}:`, error);
      return false;
    }
  }

  /**
   * Get session recordings
   */
  async getSessionRecordings(deviceId: string): Promise<any[]> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'recordings',
        nodeid: deviceId
      });

      return response.data && response.data.recordings ? response.data.recordings : [];
    } catch (error) {
      console.error(`Failed to get session recordings for ${deviceId}:`, error);
      return [];
    }
  }

  /**
   * Install MeshCentral agent on device
   */
  async getAgentInstallUrl(meshId: string): Promise<string | null> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'inviteAgent',
        meshid: meshId,
        expire: 2, // 2 hours
        flags: 0
      });

      if (response.data && response.data.url) {
        return response.data.url;
      }

      return null;
    } catch (error) {
      console.error('Failed to generate agent install URL:', error);
      return null;
    }
  }

  /**
   * Create a new mesh group
   */
  async createMeshGroup(name: string, description: string): Promise<string | null> {
    try {
      const response = await this.client.post('/meshes.ashx', {
        action: 'createmesh',
        meshname: name,
        desc: description,
        meshtype: 2 // Agent mesh
      });

      if (response.data && response.data.meshid) {
        return response.data.meshid;
      }

      return null;
    } catch (error) {
      console.error('Failed to create mesh group:', error);
      return null;
    }
  }
}

// Singleton instance
let meshCentralClient: MeshCentralClient | null = null;

export function getMeshCentralClient(): MeshCentralClient | null {
  if (!process.env.MESHCENTRAL_URL) {
    console.warn('MeshCentral not configured - MESHCENTRAL_URL not set');
    return null;
  }

  if (!meshCentralClient) {
    meshCentralClient = new MeshCentralClient({
      url: process.env.MESHCENTRAL_URL,
      apiKey: process.env.MESHCENTRAL_API_KEY,
      username: process.env.MESHCENTRAL_USERNAME,
      password: process.env.MESHCENTRAL_PASSWORD,
    });
  }

  return meshCentralClient;
}

export async function initializeMeshCentral(): Promise<boolean> {
  const client = getMeshCentralClient();
  if (!client) {
    return false;
  }

  try {
    const authenticated = await client.authenticate();
    if (authenticated) {
      console.log('MeshCentral client initialized successfully');
    } else {
      console.error('MeshCentral authentication failed');
    }
    return authenticated;
  } catch (error) {
    console.error('Failed to initialize MeshCentral client:', error);
    return false;
  }
}