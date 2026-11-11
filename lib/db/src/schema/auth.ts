import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

// Legacy session storage table. Preserve it for existing data and foreign keys;
// Clerk owns active browser sessions after the authentication migration.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

// Legacy identity bridge table. authUsers.id remains the local Clerk bridge
// (migrated Replit subject / Clerk sessionClaims.userId), so don't drop it.
export const authUsers = pgTable("auth_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UpsertUser = typeof authUsers.$inferInsert;
// Named AuthUser, not User: `schema.ts` already exports a `User` for the
// separate `users` table, and the barrel re-exports both with `export *`. Two
// `User` exports made `@workspace/db`'s `User` silently resolve to the wrong
// table rather than reporting a conflict.
export type AuthUser = typeof authUsers.$inferSelect;
