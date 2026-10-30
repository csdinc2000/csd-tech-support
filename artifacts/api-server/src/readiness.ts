import type { Express } from "express";

const healthyResponse = { status: "ok" } as const;
const unavailableResponse = { status: "unavailable" } as const;

export type CriticalDependencyCheck = () => Promise<void>;
export type ReadinessDependencyChecks = {
  critical: CriticalDependencyCheck[];
  optional?: CriticalDependencyCheck[];
};

export function registerReadinessRoutes(
  app: Express,
  dependencyChecks: ReadinessDependencyChecks,
): void {
  // Deployment probes check every configured API service prefix, not just the
  // explicit startup path. Keep these exact-prefix GETs public.
  //
  // Database availability is required to serve API requests. Optional external
  // integrations are deliberately excluded so their outages do not drain this
  // service from traffic.
  for (const path of ["/api", "/webhooks", "/ws", "/api/healthz"]) {
    app.get(path, async (_req, res) => {
      try {
        await Promise.all(dependencyChecks.critical.map((check) => check()));
        return res.json(healthyResponse);
      } catch {
        // Keep connection details and provider errors out of this public endpoint.
        return res.status(503).json(unavailableResponse);
      }
    });
  }
}
