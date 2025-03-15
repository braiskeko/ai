import { users, type User, type InsertUser } from "@shared/schema";

export interface IStorage {
  getUserBySessionId(sessionId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  markIntroAsSeen(sessionId: string): Promise<void>;
}

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  currentId: number;

  constructor() {
    this.users = new Map();
    this.currentId = 1;
  }

  async getUserBySessionId(sessionId: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.sessionId === sessionId
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.currentId++;
    const user: User = { 
      ...insertUser,
      id,
      hasSeenIntro: false
    };
    this.users.set(id, user);
    return user;
  }

  async markIntroAsSeen(sessionId: string): Promise<void> {
    const user = await this.getUserBySessionId(sessionId);
    if (!user) return;
    
    this.users.set(user.id, {
      ...user,
      hasSeenIntro: true
    });
  }
}

export const storage = new MemStorage();
