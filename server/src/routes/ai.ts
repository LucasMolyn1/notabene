// Recherche IA (question → réponse sourcée, diffusée en SSE) et réglages du fournisseur.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, requireScope } from '../auth/context.js';
import { buildContext, SYSTEM_PROMPT } from '../ai/rag.js';
import { LlmError, streamCompletion } from '../ai/llm.js';
import { aiSettingsInput, isAiReady, loadAiSettings, publicAiSettings, saveAiSettings } from '../ai/settings.js';
import { readableSpaceIds } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';

export default async function aiRoutes(app: FastifyInstance) {
  const { db, box } = app;

  app.post('/ai/ask', {
    preHandler: guard('ai'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['ai'],
      summary: 'Poser une question à la documentation (réponse en SSE : sources, delta, done, error)',
      body: z.object({ question: z.string().trim().min(3).max(2000) }),
    },
  }, async (req, reply) => {
    if (!isAiReady(db)) throw new HttpError(503, 'La recherche IA n’est pas configurée');
    const { question } = req.body as { question: string };
    const settings = loadAiSettings(db, box);
    const { sources, user } = buildContext(db, question, readableSpaceIds(db, req));
    audit(db, req, 'ai.ask', null, { chars: question.length, sources: sources.length, provider: settings.provider });

    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('sources', sources);
    try {
      for await (const text of streamCompletion(settings, { system: SYSTEM_PROMPT, user }, controller.signal)) send('delta', { text });
      send('done', {});
    } catch (err) {
      req.log.warn({ err: err instanceof LlmError ? err.message : err }, 'échec de la requête LLM');
      send('error', { message: err instanceof LlmError ? err.message : 'Erreur lors de la génération de la réponse' });
    } finally {
      res.end();
    }
  });

  app.get('/admin/ai', { preHandler: guard('admin'), schema: { tags: ['admin'], summary: 'Réglages IA (sans la clé)' } }, async () => publicAiSettings(db));

  app.put('/admin/ai', {
    preHandler: guard('admin'),
    schema: { tags: ['admin'], summary: 'Modifier les réglages IA (clé chiffrée au repos)', body: aiSettingsInput },
  }, async (req) => {
    const auth = requireScope(req, 'admin');
    const body = req.body as z.output<typeof aiSettingsInput>;
    const result = saveAiSettings(db, box, body, auth.user.id);
    audit(db, req, 'settings.ai', null, { provider: body.provider, model: body.model, keyChanged: body.apiKey !== undefined });
    return result;
  });

  app.post('/admin/ai/test', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Tester la connexion au fournisseur' },
  }, async () => {
    const settings = loadAiSettings(db, box);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let text = '';
    try {
      for await (const chunk of streamCompletion(settings, { system: 'Réponds uniquement « OK ».', user: 'Test de connexion.', maxTokens: 1000 }, controller.signal)) {
        text += chunk;
        if (text.length > 200) break;
      }
      return { ok: true, sample: text.trim().slice(0, 80) };
    } catch (err) {
      return { ok: false, message: err instanceof LlmError ? err.message : 'Échec de la connexion' };
    } finally {
      clearTimeout(timer);
    }
  });
}
