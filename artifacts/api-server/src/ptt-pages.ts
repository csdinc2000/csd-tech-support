import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { pool } from "./db";
import { logger } from "./lib/logger";
import { connectedPttUserChannels, isPttChannelId, PTT_CHANNELS } from "./ptt";
import { isAdminEmail, rateLimit } from "./security";
import { canAccessFeature, getStaffAccessForUserId } from "./staff-access";

/**
 * PTT "ring": from the PTT console a staff member rings one colleague, several,
 * or everyone with PTT access. Each person's app shows a ringing pop-up
 * (polled from every page) and Answer drops them into the caller's talk group.
 *
 * Who can be rung = approved staff whose effective features include
 * `communications`, the same gate as the PTT console itself.
 */

/** How long a ring keeps sounding before it counts as missed. */
export const PTT_RING_SECONDS = 45;
/** A browser that polled within this window counts as having the app open. */
const ONLINE_WINDOW_MS = 12_000;
const MAX_TARGETS = 100;

// Presence comes from the incoming-ring poll every open app tab makes. It is
// advisory ("app open" dot in the roster), so per-process memory is enough.
const lastSeenByUser = new Map<string, number>();

export function markPttPresence(userId: string, now = Date.now()): void {
  lastSeenByUser.set(userId, now);
  if (lastSeenByUser.size > 2000) {
    for (const [id, seen] of lastSeenByUser) if (now - seen > ONLINE_WINDOW_MS) lastSeenByUser.delete(id);
  }
}

export function isPttUserOnline(userId: string, now = Date.now()): boolean {
  const seen = lastSeenByUser.get(userId);
  return seen !== undefined && now - seen <= ONLINE_WINDOW_MS;
}

export type PttRosterEntry = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  avatarUrl: string | null;
  online: boolean;
  /** Talk group they are monitoring right now, or null when the PTT console isn't open. */
  pttChannelId: string | null;
  onPtt: boolean;
};

/** "ringing" past its expiry is reported as "missed"; the row itself never needs a sweep. */
export function effectivePageStatus(status: string, expiresAt: Date, now = Date.now()): string {
  return status === "ringing" && expiresAt.getTime() <= now ? "missed" : status;
}

function displayName(row: { first_name?: string | null; last_name?: string | null; email?: string | null }): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || row.email || "Staff member";
}

function channelName(channelId: string): string {
  return PTT_CHANNELS.find((channel) => channel.id === channelId)?.name ?? channelId;
}

/** Every approved staff member who may use PTT, excluding `excludeUserId`. */
export async function listPttRoster(excludeUserId: string | null): Promise<PttRosterEntry[]> {
  const result = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, p.approval_status, a.updated_at AS avatar_updated_at
     FROM auth_users u
     LEFT JOIN staff_access_profiles p ON p.user_id = u.id
     LEFT JOIN staff_avatars a ON a.user_id = u.id`,
  );
  const now = Date.now();
  const connected = connectedPttUserChannels();
  const entries: PttRosterEntry[] = [];
  for (const row of result.rows) {
    if (row.id === excludeUserId) continue;
    // Owners are approved by email (and may have no profile row); everyone
    // else needs an approved profile. The full check below is authoritative.
    if (row.approval_status !== "approved" && !isAdminEmail(row.email)) continue;
    const access = await getStaffAccessForUserId(row.id);
    if (access.approvalStatus !== "approved" || !access.features.communications) continue;
    const pttChannel = connected.has(row.id) ? connected.get(row.id) ?? null : null;
    entries.push({
      id: row.id,
      name: displayName(row),
      email: row.email ?? null,
      role: access.role,
      avatarUrl: row.avatar_updated_at
        ? `/api/staff-profile/${encodeURIComponent(row.id)}/avatar?v=${new Date(row.avatar_updated_at).getTime()}`
        : null,
      online: isPttUserOnline(row.id, now) || connected.has(row.id),
      pttChannelId: pttChannel,
      onPtt: connected.has(row.id),
    });
  }
  return entries.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

const ringSchema = z.object({
  channelId: z.string(),
  everyone: z.boolean().optional(),
  targetUserIds: z.array(z.string().min(1).max(200)).max(MAX_TARGETS).optional(),
});

const respondSchema = z.object({ action: z.enum(["answer", "decline"]) });

async function requirePttUser(req: Request, res: Response): Promise<string | null> {
  const userId = req.dbUser?.id;
  if (!userId) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  if (!(await canAccessFeature(req, "communications"))) {
    res.status(403).json({ error: "Approved communications access required" });
    return null;
  }
  return userId;
}

async function groupStatus(groupId: string) {
  const result = await pool.query(
    `SELECT pg.id, pg.target_user_id, pg.status, pg.expires_at, pg.responded_at, pg.channel_id, pg.created_at,
            u.first_name, u.last_name, u.email
     FROM ptt_pages pg JOIN auth_users u ON u.id = pg.target_user_id
     WHERE pg.group_id = $1 ORDER BY u.first_name NULLS LAST, u.email`,
    [groupId],
  );
  const now = Date.now();
  return {
    groupId,
    channelId: result.rows[0]?.channel_id ?? null,
    createdAt: result.rows[0]?.created_at ?? null,
    expiresAt: result.rows[0]?.expires_at ?? null,
    pages: result.rows.map((row) => ({
      id: Number(row.id),
      targetUserId: row.target_user_id,
      name: displayName(row),
      status: effectivePageStatus(row.status, new Date(row.expires_at), now),
      respondedAt: row.responded_at,
    })),
  };
}

export function registerPttPageRoutes(app: Express): void {
  app.get("/api/ptt/roster", async (req, res) => {
    try {
      const userId = await requirePttUser(req, res);
      if (!userId) return;
      res.json({ staff: await listPttRoster(userId), ringSeconds: PTT_RING_SECONDS });
    } catch (error) {
      logger.error({ error }, "PTT roster failed");
      res.status(500).json({ error: "Unable to load the PTT roster" });
    }
  });

  app.post(
    "/api/ptt/pages",
    rateLimit({ windowMs: 60_000, max: 30, key: (req) => `ptt-ring:${req.dbUser?.id ?? req.ip}`, message: "Too many rings. Wait a minute and try again." }),
    async (req, res) => {
      try {
        const userId = await requirePttUser(req, res);
        if (!userId) return;
        const parsed = ringSchema.safeParse(req.body);
        if (!parsed.success || !isPttChannelId(parsed.data.channelId)) {
          res.status(400).json({ error: "Choose a talk group and who to ring" });
          return;
        }
        const { channelId, everyone, targetUserIds } = parsed.data;
        const roster = await listPttRoster(userId);
        const wanted = new Set(targetUserIds ?? []);
        const targets = everyone ? roster : roster.filter((entry) => wanted.has(entry.id));
        if (targets.length === 0) {
          res.status(400).json({ error: everyone ? "Nobody else has PTT access yet" : "Pick at least one person with PTT access" });
          return;
        }
        const caller = await pool.query(`SELECT first_name, last_name, email FROM auth_users WHERE id = $1`, [userId]);
        const callerName = displayName(caller.rows[0] ?? {});
        const groupId = randomUUID();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // A new ring replaces any of this caller's rings still sounding for the same people.
          await client.query(
            `UPDATE ptt_pages SET status = 'cancelled', responded_at = NOW()
             WHERE caller_user_id = $1 AND target_user_id = ANY($2::varchar[]) AND status = 'ringing'`,
            [userId, targets.map((t) => t.id)],
          );
          await client.query(
            `INSERT INTO ptt_pages (group_id, caller_user_id, caller_name, target_user_id, channel_id, expires_at)
             SELECT $1, $2, $3, target, $4, NOW() + ($5 * INTERVAL '1 second')
             FROM unnest($6::varchar[]) AS target`,
            [groupId, userId, callerName, channelId, PTT_RING_SECONDS, targets.map((t) => t.id)],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        res.status(201).json(await groupStatus(groupId));
      } catch (error) {
        logger.error({ error }, "PTT ring failed");
        res.status(500).json({ error: "Unable to ring staff" });
      }
    },
  );

  // Polled every few seconds by every open app tab; also records presence.
  app.get("/api/ptt/pages/incoming", async (req, res) => {
    try {
      const userId = await requirePttUser(req, res);
      if (!userId) return;
      markPttPresence(userId);
      const result = await pool.query(
        `SELECT id, group_id, caller_user_id, caller_name, channel_id, created_at, expires_at
         FROM ptt_pages
         WHERE target_user_id = $1 AND status = 'ringing' AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 5`,
        [userId],
      );
      res.json({
        serverTime: new Date().toISOString(),
        rings: result.rows.map((row) => ({
          id: Number(row.id),
          groupId: row.group_id,
          callerUserId: row.caller_user_id,
          callerName: row.caller_name,
          channelId: row.channel_id,
          channelName: channelName(row.channel_id),
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        })),
      });
    } catch (error) {
      logger.error({ error }, "PTT incoming rings failed");
      res.status(500).json({ error: "Unable to check for rings" });
    }
  });

  app.post("/api/ptt/pages/:id/respond", async (req, res) => {
    try {
      const userId = await requirePttUser(req, res);
      if (!userId) return;
      const id = Number(req.params.id);
      const parsed = respondSchema.safeParse(req.body);
      if (!Number.isSafeInteger(id) || id <= 0 || !parsed.success) {
        res.status(400).json({ error: "Invalid response" });
        return;
      }
      const status = parsed.data.action === "answer" ? "answered" : "declined";
      const result = await pool.query(
        `UPDATE ptt_pages SET status = $3, responded_at = NOW()
         WHERE id = $1 AND target_user_id = $2 AND status = 'ringing' AND expires_at > NOW()
         RETURNING channel_id`,
        [id, userId, status],
      );
      if (!result.rows[0]) {
        res.status(409).json({ error: "This call is no longer ringing" });
        return;
      }
      res.json({ status, channelId: result.rows[0].channel_id });
    } catch (error) {
      logger.error({ error }, "PTT ring response failed");
      res.status(500).json({ error: "Unable to answer the call" });
    }
  });

  app.get("/api/ptt/pages/groups/:groupId", async (req, res) => {
    try {
      const userId = await requirePttUser(req, res);
      if (!userId) return;
      const groupId = String(req.params.groupId);
      if (!z.uuid().safeParse(groupId).success) {
        res.status(404).json({ error: "Ring not found" });
        return;
      }
      const owner = await pool.query(`SELECT 1 FROM ptt_pages WHERE group_id = $1 AND caller_user_id = $2 LIMIT 1`, [groupId, userId]);
      if (!owner.rows[0]) {
        res.status(404).json({ error: "Ring not found" });
        return;
      }
      res.json(await groupStatus(groupId));
    } catch (error) {
      logger.error({ error }, "PTT ring status failed");
      res.status(500).json({ error: "Unable to load ring status" });
    }
  });

  app.post("/api/ptt/pages/groups/:groupId/cancel", async (req, res) => {
    try {
      const userId = await requirePttUser(req, res);
      if (!userId) return;
      const groupId = String(req.params.groupId);
      if (!z.uuid().safeParse(groupId).success) {
        res.status(404).json({ error: "Ring not found" });
        return;
      }
      const owner = await pool.query(`SELECT 1 FROM ptt_pages WHERE group_id = $1 AND caller_user_id = $2 LIMIT 1`, [groupId, userId]);
      if (!owner.rows[0]) {
        res.status(404).json({ error: "Ring not found" });
        return;
      }
      await pool.query(
        `UPDATE ptt_pages SET status = 'cancelled', responded_at = NOW()
         WHERE group_id = $1 AND caller_user_id = $2 AND status = 'ringing'`,
        [groupId, userId],
      );
      res.json(await groupStatus(groupId));
    } catch (error) {
      logger.error({ error }, "PTT ring cancel failed");
      res.status(500).json({ error: "Unable to cancel the ring" });
    }
  });
}
