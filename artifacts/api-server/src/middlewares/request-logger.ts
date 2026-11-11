import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { logger } from "../lib/logger";

declare global {
  namespace Express {
    interface Request {
      /** Per-request child logger (set by attachRequestLogger). */
      log: Logger;
    }
  }
}

// Route handlers log through `req.log` so every line carries a request id.
// Mount this before any route.
export const attachRequestLogger: RequestHandler = (req, _res, next) => {
  req.log = logger.child({ reqId: randomUUID() });
  next();
};
