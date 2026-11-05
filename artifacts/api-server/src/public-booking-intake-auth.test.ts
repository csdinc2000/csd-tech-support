import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { apiAuthenticationBoundary } from "./api-auth-boundary";

test("signed-out customers can reach public booking and intake methods, but not nearby private ones", async () => {
  const app = express();
  app.use((req, _res, next) => {
    // Stand in for Clerk's verified signed-out request; no user or database
    // setup is needed to exercise the production API boundary.
    (req as any).auth = Object.assign(() => ({
      tokenType: "session_token",
      userId: null,
      sessionClaims: null,
    }), { [Symbol.for("@clerk/express.auth")]: true });
    next();
  });
  app.use(apiAuthenticationBoundary);
  app.use((_req, res) => res.status(204).end());

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start API boundary test server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const publicRequests = [
      ["POST", "/api/intake"],
      ["GET", "/api/booking/categories"],
      ["GET", "/api/booking/services"],
      ["GET", "/api/booking/services/laptop-repair"],
      ["GET", "/api/booking/availability?service=laptop-repair"],
      ["POST", "/api/booking/locks"],
      ["DELETE", "/api/booking/locks/lock-token"],
      ["POST", "/api/booking/appointments"],
      ["GET", "/api/booking/v2/services"],
      ["GET", "/api/booking/v2/availability?service=laptop-repair"],
      ["POST", "/api/booking/v2/holds"],
      ["POST", "/api/booking/v2/holds/hold-token/confirm"],
    ] as const;
    const privateRequests = [
      ["GET", "/api/intake"],
      ["GET", "/api/intake/123"],
      ["PUT", "/api/intake/123"],
      ["DELETE", "/api/intake/123"],
      ["GET", "/api/booking/appointments"],
      // Returns customer contact details and internal notes, so staff only.
      ["GET", "/api/booking/appointments/BOOK-123"],
      ["PATCH", "/api/booking/appointments/BOOK-123"],
      ["POST", "/api/booking/services"],
      ["GET", "/api/booking/locks/lock-token"],
      ["POST", "/api/booking/v2/holds/hold-token"],
      ["GET", "/api/booking/v2/holds/hold-token/confirm"],
    ] as const;

    for (const [method, path] of publicRequests) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(response.status, 204, `${method} ${path}: ${await response.text()}`);
    }
    for (const [method, path] of privateRequests) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path}: ${await response.clone().text()}`);
      assert.deepEqual(await response.json(), { message: "Authentication required" });
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});