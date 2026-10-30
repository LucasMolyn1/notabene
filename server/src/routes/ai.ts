// Recherche IA (question → réponse sourcée, diffusée en SSE) et réglages du fournisseur.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, requireScope } from '../auth/context.js';
import { buildContext, SYSTEM_PROMPT } from '../ai/rag.js';
import { LlmError, listModels, streamCompletion } from '../ai/llm.js';
import { aiDestination, aiSettingsInput, isAiReady, loadAiSettings, publicAiSettings, saveAiSettings } from '../ai/settings.js';
import { readableSpaceIds } from '../lib/access.js';
import { filterReadable } from '../lib/page-acl.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { requireReauth } from '../lib/reauth.js';
import { assertSafeUrl } from '../lib/webhooks.js';

export default async function aiRoutes(app: FastifyInstance) {
  const { db, box, config } = app;
  const allowPrivate = config.AI_ALLOW_PRIVATE;
  // Adresse du fournisseur : https obligatoire et réseaux internes refusés, sauf AI_ALLOW_PRIVATE.
  const checkUrl = async (baseUrl: string | undefined) => {
    if (!baseUrl) return;
    try { await assertSafeUrl(baseUrl, allowPrivate); } catch (err) { throw new HttpError(400, `Adresse du fournisseur refusée : ${(err as Error).message}`); }
  };

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
    const settings = loadAiSettings(db, box, allowPrivate);
    const { sources, user } = buildContext(db, question, readableSpaceIds(db, req), (items) => filterReadable(db, req.auth, items));
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
    // Session navigateur et preuve d'identité récente, comme pour les autres fournisseurs : la clé d'API est un secret.
    await requireReauth(app, req, body.reauth, { strict: true });
    await checkUrl(body.baseUrl);
    const result = saveAiSettings(db, box, body, auth.user.id);
    audit(db, req, 'settings.ai', null, { provider: body.provider, model: body.model, keyChanged: body.apiKey !== undefined });
    return result;
  });

  // Modèles disponibles chez le fournisseur. La clé enregistrée n'est utilisée que pour l'adresse déjà enregistrée :
  // pour une autre adresse, la clé doit être saisie, donc elle ne peut pas être détournée.
  app.post('/admin/ai/models', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin'],
      summary: 'Lister les modèles du fournisseur',
      body: z.object({ provider: aiSettingsInput.shape.provider, baseUrl: aiSettingsInput.shape.baseUrl, apiKey: z.string().max(500).optional() }),
    },
  }, async (req) => {
    const b = req.body as { provider: 'anthropic' | 'openai'; baseUrl?: string; apiKey?: string };
    const stored = loadAiSettings(db, box, allowPrivate);
    const baseUrl = b.baseUrl || '';
    await checkUrl(baseUrl);
    let apiKey = b.apiKey?.trim() || null;
    if (!apiKey && aiDestination(b.provider, baseUrl) === aiDestination(stored.provider, stored.baseUrl)) apiKey = stored.apiKey;
    if (!apiKey && b.provider === 'anthropic') throw new HttpError(400, 'Saisissez la clé d’API pour lister les modèles.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      return { models: await listModels({ ...stored, provider: b.provider, baseUrl, apiKey }, controller.signal) };
    } catch (err) {
      throw new HttpError(err instanceof LlmError ? err.status : 502, err instanceof LlmError ? err.message : 'Échec de la connexion');
    } finally {
      clearTimeout(timer);
    }
  });

  app.post('/admin/ai/test', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Tester la connexion au fournisseur' },
  }, async () => {
    const settings = loadAiSettings(db, box, allowPrivate);
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
