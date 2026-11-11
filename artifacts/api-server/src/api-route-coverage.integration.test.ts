import assert from "node:assert/strict";
import { after, test } from "node:test";
import express, { type Express } from "express";
import type { Server } from "node:http";
import { registerApiRoutes } from "./boot/api-routes";
import { isPublicApiRequest } from "./api-auth-boundary";
import { isAllStaffApiPath, requiredFeatureForApiPath } from "./security";

// Every /api route the server registers must be classified for the auth
// boundary: public, gated by a staff feature / owner, or explicitly open to
// all approved staff. Anything else is refused at runtime (fail closed), so
// this test catches a new route before it ships unreachable — or before
// someone "fixes" that by opening it to everyone without thinking.

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type RecordedRoute = { method: string; path: string };

// Routes registered before the auth boundary in index.ts; they do their own
// authentication (signature checks or requireAuth).
const PRE_BOUNDARY = new Set([
  "POST /api/stripe/webhook",
  "POST /api/webhooks/sendgrid-events",
  "GET /api/auth/access",
]);

function recordRoutes(app: Express): RecordedRoute[] {
  const routes: RecordedRoute[] = [];
  const record = (method: string, path: unknown) => {
    const paths = Array.isArray(path) ? path : [path];
    for (const p of paths) {
      if (typeof p === "string" && p.toLowerCase().startsWith("/api")) routes.push({ method, path: p });
    }
  };
  for (const method of METHODS) {
    const original = (app as any)[method].bind(app);
    (app as any)[method] = (...args: unknown[]) => {
      // app.get(name) with one argument reads a setting; it isn't a route.
      if (!(method === "get" && args.length === 1)) record(method.toUpperCase(), args[0]);
      return original(...args);
    };
  }
  const originalAll = app.all.bind(app);
  (app as any).all = (...args: unknown[]) => {
    record("ALL", args[0]);
    return (originalAll as any)(...args);
  };
  const originalUse = app.use.bind(app);
  (app as any).use = (...args: unknown[]) => {
    // Mounted routers: classify the mount prefix for every method.
    const [first, second] = args;
    if (typeof first === "string" && typeof second === "function" && (second as any).stack) {
      record("ALL", first);
    }
    return (originalUse as any)(...args);
  };
  return routes;
}

// Turn "/api/crm/contacts/:id/notes" into a concrete sample path.
function samplePath(path: string): string {
  return path
    .replace(/\(\.\*\)|\*/g, "x")
    .replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, "1")
    .replace(/\{[^}]*\}/g, "");
}

let server: Server | undefined;
after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test("every registered /api route is public, feature-gated, or explicitly open to all staff", async () => {
  const app = express();
  const routes = recordRoutes(app);
  server = await registerApiRoutes(app, { disableBackgroundServices: true });
  assert.ok(routes.length > 300, `expected the full route table, recorded only ${routes.length}`);

  const unclassified: string[] = [];
  for (const { method, path } of routes) {
    const key = `${method} ${path}`;
    if (PRE_BOUNDARY.has(key)) continue;
    const sample = samplePath(path).toLowerCase();
    const methods = method === "ALL" ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : [method];
    for (const m of methods) {
      const classified =
        isPublicApiRequest(m, sample) ||
        requiredFeatureForApiPath(sample, m) !== null ||
        isAllStaffApiPath(sample, m);
      if (!classified) unclassified.push(`${m} ${path}`);
    }
  }
  assert.deepEqual(
    [...new Set(unclassified)].sort(),
    [],
    "Classify these routes in security.ts (a feature gate, or ALL_STAFF_API_PREFIXES) or api-auth-boundary.ts (public)",
  );
});
