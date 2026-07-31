import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Sessions store analysis configurations so users can reload them
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  materialName: text("material_name").notNull().default(""),
  // Material properties stored as JSON
  materialProps: text("material_props").notNull().default("{}"),
  // Forces stored as JSON array
  forces: text("forces").notNull().default("[]"),
  // Constraint face stored as string
  constraintFace: text("constraint_face").notNull().default(""),
  // Thermal notes
  thermalNotes: text("thermal_notes").notNull().default(""),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const insertSessionSchema = createInsertSchema(sessions).omit({ id: true, createdAt: true });
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;
