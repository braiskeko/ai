import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { nanoid } from "nanoid";
import cookieParser from "cookie-parser";

export async function registerRoutes(app: Express): Promise<Server> {
  app.use(cookieParser());

  // Session middleware
  app.use(async (req, res, next) => {
    let sessionId = req.cookies.sessionId;
    
    if (!sessionId) {
      sessionId = nanoid();
      res.cookie('sessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 365 * 24 * 60 * 60 * 1000 // 1 year
      });
      await storage.createUser({ sessionId });
    }
    
    next();
  });

  app.get('/api/check-intro', async (req, res) => {
    const sessionId = req.cookies.sessionId;
    const user = await storage.getUserBySessionId(sessionId);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({ hasSeenIntro: user.hasSeenIntro });
  });

  app.post('/api/complete-intro', async (req, res) => {
    const sessionId = req.cookies.sessionId;
    await storage.markIntroAsSeen(sessionId);
    res.json({ success: true });
  });

  const httpServer = createServer(app);
  return httpServer;
}
