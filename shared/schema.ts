import { pgTable, text, serial, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  hasSeenIntro: boolean("has_seen_intro").notNull().default(false),
  sessionId: text("session_id").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  sessionId: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
