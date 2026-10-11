import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createChatSession, deleteChatSession, getChatSession, listChatMessages, listChatSessions, updateChatSession, type DB } from '@quarry/db';
import type { ChatRunner } from './chat-runner.js';

// The chatbot's API (dashboard Chat tab). Sending a message starts a background
// run; the client polls the session for new messages while it is running.

export function registerChatRoutes(app: FastifyInstance, o: { db: DB; runner?: ChatRunner }): void {
  const idParams = z.object({ id: z.string().uuid() });
  const need = () => {
    if (!o.runner) throw Object.assign(new Error('the chatbot is not enabled on this server (chat.enabled)'), { statusCode: 503 });
    return o.runner;
  };

  app.get('/api/chat/sessions', async () => ({ sessions: await listChatSessions(o.db) }));

  app.post('/api/chat/sessions', async (_req, reply) => {
    const b = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict().parse(_req.body ?? {});
    return reply.status(201).send(await createChatSession(o.db, b.title ?? 'New chat'));
  });

  app.get('/api/chat/sessions/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const session = await getChatSession(o.db, id);
    if (!session) return reply.status(404).send({ error: 'not_found' });
    return { session, messages: await listChatMessages(o.db, id), running: o.runner?.isRunning(id) ?? false };
  });

  app.post('/api/chat/sessions/:id/messages', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(20_000) }).strict().parse(req.body ?? {});
    const runner = need();
    const session = await getChatSession(o.db, id);
    if (!session) return reply.status(404).send({ error: 'not_found' });
    if (session.title === 'New chat') await updateChatSession(o.db, id, { title: b.text.split('\n')[0]!.slice(0, 80) });
    await runner.send(id, b.text);
    return reply.status(202).send({ started: true });
  });

  app.post('/api/chat/sessions/:id/stop', async (req) => {
    const { id } = idParams.parse(req.params);
    return { stopped: need().stop(id) };
  });

  app.delete('/api/chat/sessions/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if (o.runner?.isRunning(id)) return reply.status(409).send({ error: 'busy', message: 'stop the running request first' });
    await o.runner?.remove(id);
    return (await deleteChatSession(o.db, id)) ? { deleted: true } : reply.status(404).send({ error: 'not_found' });
  });
}
