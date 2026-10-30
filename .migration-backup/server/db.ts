import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// An idle pooled connection dropped by the server (common with serverless
// Postgres) emits 'error' on the pool; without a listener that crashes the
// whole process. Log and let the pool replace the connection.
pool.on("error", (err) => {
  console.error("Unexpected idle PostgreSQL connection error:", err.message);
});

export const db = drizzle({ client: pool, schema });
