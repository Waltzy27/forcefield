import { sessions, type Session, type InsertSession } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

// Run migrations inline
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    material_name TEXT NOT NULL DEFAULT '',
    material_props TEXT NOT NULL DEFAULT '{}',
    forces TEXT NOT NULL DEFAULT '[]',
    constraint_face TEXT NOT NULL DEFAULT '',
    thermal_notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  )
`);

export interface IStorage {
  getSessions(): Session[];
  getSession(id: number): Session | undefined;
  createSession(data: InsertSession): Session;
  updateSession(id: number, data: Partial<InsertSession>): Session | undefined;
  deleteSession(id: number): void;
}

export class DatabaseStorage implements IStorage {
  getSessions(): Session[] {
    return db.select().from(sessions).all();
  }

  getSession(id: number): Session | undefined {
    return db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  createSession(data: InsertSession): Session {
    return db.insert(sessions).values(data).returning().get();
  }

  updateSession(id: number, data: Partial<InsertSession>): Session | undefined {
    return db.update(sessions).set(data).where(eq(sessions.id, id)).returning().get();
  }

  deleteSession(id: number): void {
    db.delete(sessions).where(eq(sessions.id, id)).run();
  }
}

export const storage = new DatabaseStorage();
