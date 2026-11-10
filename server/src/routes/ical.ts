// Flux iCalendar d'une base, en lecture et SANS compte : GET /ical/<jeton>.ics (hors /api/v3, comme les liens publics).
// Le jeton est le seul secret de l'adresse : vérifié par son empreinte à chaque lecture (lib/base-ical.ts), masqué dans les
// journaux (maskShareToken). Toute raison de refus donne la même réponse 404, sans redirection.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { activeFeed, renderCalendar } from '../lib/base-ical.js';

const FILE = /^([A-Za-z0-9_-]{32})\.ics$/;

export default async function icalRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const domain = new URL(config.PUBLIC_URL).hostname;
  const hardened = (reply: FastifyReply) =>
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex, nofollow');

  app.get('/ical/:file', {
    // Limite stricte, par adresse IP (un compte éventuellement connecté ne change rien).
    config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req) => `ical:${req.ip}` } },
    schema: { tags: ['bases'], summary: 'Flux iCalendar d’une base, par adresse secrète (sans compte)', params: z.object({ file: z.string().max(100) }) },
  }, async (req, reply) => {
    const token = FILE.exec((req.params as { file: string }).file)?.[1];
    const feed = token ? activeFeed(db, token) : null;
    if (!feed) return hardened(reply).status(404).type('text/plain; charset=utf-8').send('Introuvable');
    return hardened(reply).type('text/calendar; charset=utf-8').send(renderCalendar(db, feed.baseId, domain));
  });
}
