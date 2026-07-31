import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { insertSessionSchema } from "@shared/schema";

export async function registerRoutes(httpServer: Server, app: Express): Promise<void> {
  // Get all sessions
  app.get("/api/sessions", (_req, res) => {
    const all = storage.getSessions();
    res.json(all);
  });

  // Get single session
  app.get("/api/sessions/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const s = storage.getSession(id);
    if (!s) return res.status(404).json({ error: "Not found" });
    res.json(s);
  });

  // Create session
  app.post("/api/sessions", (req, res) => {
    const parsed = insertSessionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const created = storage.createSession(parsed.data);
    res.status(201).json(created);
  });

  // Update session
  app.patch("/api/sessions/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const partial = insertSessionSchema.partial().safeParse(req.body);
    if (!partial.success) return res.status(400).json({ error: partial.error.flatten() });
    const updated = storage.updateSession(id, partial.data);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // Delete session
  app.delete("/api/sessions/:id", (req, res) => {
    const id = parseInt(req.params.id);
    storage.deleteSession(id);
    res.status(204).end();
  });
}
