import { asc, desc, eq } from 'drizzle-orm';
import type { DB } from './client.js';
import { chatMessages, chatSessions } from './schema.js';

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export async function createChatSession(db: DB, title: string): Promise<ChatSessionRow> {
  const [r] = await db.insert(chatSessions).values({ title: title.slice(0, 200) }).returning();
  return r!;
}

export async function getChatSession(db: DB, id: string): Promise<ChatSessionRow | null> {
  const [r] = await db.select().from(chatSessions).where(eq(chatSessions.id, id));
  return r ?? null;
}

export async function listChatSessions(db: DB, limit = 50): Promise<ChatSessionRow[]> {
  return db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt)).limit(limit);
}

export async function updateChatSession(db: DB, id: string, patch: Partial<Pick<ChatSessionRow, 'title' | 'claudeSessionId' | 'status'>>): Promise<void> {
  await db.update(chatSessions).set({ ...patch, updatedAt: new Date() }).where(eq(chatSessions.id, id));
}

export async function deleteChatSession(db: DB, id: string): Promise<boolean> {
  const r = await db.delete(chatSessions).where(eq(chatSessions.id, id)).returning({ id: chatSessions.id });
  return r.length > 0;
}

export async function addChatMessage(db: DB, m: { sessionId: string; role: ChatRole; content: string; meta?: Record<string, unknown> }): Promise<ChatMessageRow> {
  const [r] = await db.insert(chatMessages).values({ sessionId: m.sessionId, role: m.role, content: m.content, meta: m.meta ?? {} }).returning();
  await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, m.sessionId));
  return r!;
}

export async function listChatMessages(db: DB, sessionId: string): Promise<ChatMessageRow[]> {
  return db.select().from(chatMessages).where(eq(chatMessages.sessionId, sessionId)).orderBy(asc(chatMessages.createdAt));
}
