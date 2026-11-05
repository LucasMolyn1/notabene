// Chat IA avec historique par personne (réponse en SSE, comme /ai/ask) et gestion des conversations.
// Réservé aux sessions navigateur : un jeton d'API ne lit ni n'écrit l'historique d'une personne.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guard, requireScope } from '../auth/context.js';
import {
  addMessage, CHAT_SYSTEM_PROMPT, chatInput, conversationMessages, conversationTitle, createConversation, MAX_MESSAGES,
  messageCount, ownConversation, PAGE_CHARS, parseSources, readablePageIds, readableSources, recentHistory, type ChatInput,
} from '../ai/chat.js';
import { LlmError, streamCompletion } from '../ai/llm.js';
import { buildContext, type PinnedPage } from '../ai/rag.js';
import { isAiReady, loadAiSettings } from '../ai/settings.js';
import { loadReadablePage, readableSpaceIds } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { decodeCursor, encodeCursor, pageQuery } from '../lib/cursor.js';
import { HttpError, idParams } from '../lib/http.js';
import { filterReadable } from '../lib/page-acl.js';

const MAX_ANSWER_CHARS = 20_000; // réponse enregistrée au plus
const NOT_FOUND = 'Conversation introuvable';

export default async function aiChatRoutes(app: FastifyInstance) {
  const { db, box, config } = app;

  const requireBrowser = (req: FastifyRequest) => {
    const auth = requireScope(req, 'ai');
    if (auth.via !== 'session') throw new HttpError(403, 'Disponible uniquement depuis l’interface web');
    return auth;
  };

  // Une seule réponse en cours par personne : chaque flux peut coûter jusqu'à 4 000 jetons de sortie au fournisseur de l'instance.
  const streaming = new Set<string>();

  app.post('/ai/chat', {
    preHandler: guard('ai'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['ai'],
      summary: 'Chat avec la documentation (réponse en SSE : conversation, sources, delta, done, error)',
      body: chatInput,
    },
  }, async (req, reply) => {
    const auth = requireBrowser(req);
    const input = req.body as ChatInput;
    if (streaming.has(auth.user.id)) throw new HttpError(409, 'Une réponse est déjà en cours : attendez sa fin ou arrêtez-la.');
    // Contrôles d'accès avant toute sortie vers le fournisseur : conversation d'autrui ou page illisible = 404.
    const existing = input.conversationId ? ownConversation(db, auth.user.id, input.conversationId) : undefined;
    if (input.conversationId && !existing) throw new HttpError(404, NOT_FOUND);
    const page = input.pageId ? loadReadablePage(db, req, input.pageId) : null;
    if (existing && messageCount(db, existing.id) + 2 > MAX_MESSAGES) {
      throw new HttpError(409, `Cette conversation a atteint ${MAX_MESSAGES} messages : commencez-en une nouvelle.`);
    }
    if (!isAiReady(db)) throw new HttpError(503, 'Le chat IA n’est pas configuré');
    const settings = loadAiSettings(db, box, config.AI_ALLOW_PRIVATE);

    const history = existing ? recentHistory(db, existing.id) : [];
    const pinned: PinnedPage | undefined = page
      ? { id: page.id, title: page.title, icon: page.icon, spaceId: page.space_id, text: page.text.slice(0, PAGE_CHARS) }
      : undefined;
    const { sources, documents } = buildContext(db, input.message, readableSpaceIds(db, req), (items) => filterReadable(db, req.auth, items), pinned);

    // Le message de la personne est enregistré dès l'envoi ; la réponse seulement si le flux va à son terme.
    const conversation = existing ?? createConversation(db, auth.user.id, conversationTitle(input.message), page?.id ?? null);
    addMessage(db, conversation.id, 'user', input.message);
    // Volumes seulement : ni le message, ni la réponse, ni le titre ne sont journalisés.
    audit(db, req, 'ai.chat', conversation.id, {
      chars: input.message.length, sources: sources.length, history: history.length, page: !!page, provider: settings.provider,
    });

    const controller = new AbortController();
    // `req.raw` est déjà détruit quand le gestionnaire s'exécute : c'est la fermeture de la réponse qui signale le départ du client.
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) controller.abort(); });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('conversation', { id: conversation.id, title: conversation.title });
    send('sources', sources);
    let answer = '';
    streaming.add(auth.user.id);
    try {
      const prompt = { system: CHAT_SYSTEM_PROMPT, user: `${documents}\n\nMessage : ${input.message}`, history, maxTokens: 4000 };
      for await (const text of streamCompletion(settings, prompt, controller.signal)) {
        answer += text;
        send('delta', { text });
      }
      // Un flux coupé (départ du client) se termine sans erreur côté fournisseur : rien n'est enregistré.
      if (controller.signal.aborted) return;
      if (answer.trim()) {
        try { addMessage(db, conversation.id, 'assistant', answer.slice(0, MAX_ANSWER_CHARS), sources); } catch (err) {
          // Conversation supprimée pendant la génération : la réponse n'a plus où aller.
          req.log.warn({ err }, 'réponse du chat IA non enregistrée');
        }
      }
      send('done', {});
    } catch (err) {
      req.log.warn({ err: err instanceof LlmError ? err.message : err }, 'échec du chat IA');
      if (!controller.signal.aborted) send('error', { message: err instanceof LlmError ? err.message : 'Erreur lors de la génération de la réponse' });
    } finally {
      streaming.delete(auth.user.id);
      res.end();
    }
  });

  app.get('/ai/conversations', {
    preHandler: guard('ai'),
    schema: { tags: ['ai'], summary: 'Mes conversations du chat IA (récentes d’abord, pagination par curseur)', querystring: pageQuery },
  }, async (req) => {
    const auth = requireBrowser(req);
    const { limit, cursor } = req.query as z.output<typeof pageQuery>;
    const after = decodeCursor(cursor, z.object({ u: z.number().int(), i: z.string().max(64) }));
    const rows = db.prepare(
      `SELECT c.id, c.title, c.page_id, c.created_at, c.updated_at, (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS n
       FROM ai_conversations c WHERE c.user_id = ? ${after ? 'AND (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))' : ''}
       ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    ).all(...[auth.user.id, ...(after ? [after.u, after.u, after.i] : []), limit + 1]) as {
      id: string; title: string; page_id: string | null; created_at: number; updated_at: number; n: number;
    }[];
    const page = rows.slice(0, limit);
    // Page d'origine devenue illisible (droits retirés, corbeille) : son identifiant n'est plus renvoyé.
    const readable = readablePageIds(db, req.auth, page.map((r) => r.page_id));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id, title: r.title, pageId: r.page_id && readable.has(r.page_id) ? r.page_id : null,
        createdAt: r.created_at, updatedAt: r.updated_at, messageCount: r.n,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor({ u: last.updated_at, i: last.id }) : null,
    };
  });

  app.get('/ai/conversations/:id', {
    preHandler: guard('ai'),
    schema: { tags: ['ai'], summary: 'Une de mes conversations, avec ses messages', params: idParams },
  }, async (req) => {
    const auth = requireBrowser(req);
    const c = ownConversation(db, auth.user.id, (req.params as { id: string }).id);
    if (!c) throw new HttpError(404, NOT_FOUND);
    const pageId = c.page_id && readablePageIds(db, req.auth, [c.page_id]).has(c.page_id) ? c.page_id : null;
    return {
      id: c.id, title: c.title, pageId, createdAt: c.created_at, updatedAt: c.updated_at,
      messages: conversationMessages(db, c.id).map((m) => ({
        id: m.id, role: m.role, content: m.content,
        // Sources refiltrées à chaque lecture : une page devenue illisible n'est plus citée.
        sources: m.role === 'assistant' ? readableSources(db, req.auth, parseSources(m.sources)) : null,
        createdAt: m.created_at,
      })),
    };
  });

  app.delete('/ai/conversations/:id', {
    preHandler: guard('ai'),
    schema: { tags: ['ai'], summary: 'Supprimer une de mes conversations', params: idParams },
  }, async (req, reply) => {
    const auth = requireBrowser(req);
    const { id } = req.params as { id: string };
    const { changes } = db.prepare('DELETE FROM ai_conversations WHERE id = ? AND user_id = ?').run(id, auth.user.id);
    if (!changes) throw new HttpError(404, NOT_FOUND);
    audit(db, req, 'ai.chat.delete', id, { count: 1 });
    return reply.code(204).send();
  });

  app.delete('/ai/conversations', {
    preHandler: guard('ai'),
    schema: { tags: ['ai'], summary: 'Supprimer toutes mes conversations' },
  }, async (req) => {
    const auth = requireBrowser(req);
    const { changes } = db.prepare('DELETE FROM ai_conversations WHERE user_id = ?').run(auth.user.id);
    audit(db, req, 'ai.chat.delete', null, { count: changes });
    return { deleted: changes };
  });
}
