// Messages d'erreur du fournisseur IA compatible OpenAI : un statut courant doit donner une consigne claire.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_TRUNCATED_MESSAGE, LlmError, streamCompletion, TRUNCATED_NOTICE } from '../src/ai/llm.js';
import type { AiSettings } from '../src/ai/settings.js';

let server: Server;
afterEach(() => new Promise<void>((resolve) => {
  if (server) server.close(() => resolve());
  else resolve();
}));

async function messageFor(status: number): Promise<string> {
  server = createServer((_req, res) => { res.statusCode = status; res.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const settings = { enabled: true, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'k', allowPrivate: true } as AiSettings;
  try {
    const stream = streamCompletion(settings, { system: 's', user: 'u' }, new AbortController().signal);
    while (!(await stream.next()).done) { /* vide */ }
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return (err as LlmError).message;
  }
  throw new Error('aucune erreur levée');
}

// Flux SSE de complétion : des lignes « data: … » (le dernier « [DONE] » est ajouté sauf demande contraire).
async function collect(lines: string[], { done = true }: { done?: boolean } = {}): Promise<{ text: string; error: string | null }> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(lines.map((l) => `data: ${l}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const settings = { enabled: true, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'k', allowPrivate: true } as AiSettings;
  let text = '';
  try {
    for await (const chunk of streamCompletion(settings, { system: 's', user: 'u' }, new AbortController().signal)) text += chunk;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return { text, error: (err as LlmError).message };
  }
  return { text, error: null };
}
const chunk = (delta: object, finish: string | null = null) => JSON.stringify({ choices: [{ delta, finish_reason: finish }] });

describe('réponse vide ou tronquée du fournisseur compatible OpenAI', () => {
  it('réponse normale : texte seul, aucun avis', async () => {
    const r = await collect([chunk({ content: 'Bon' }), chunk({ content: 'jour' }, 'stop')]);
    expect(r).toEqual({ text: 'Bonjour', error: null });
  });
  it('limite de longueur atteinte après un début de réponse : avis de troncature', async () => {
    const r = await collect([chunk({ content: 'Début' }), chunk({}, 'length')]);
    expect(r.error).toBeNull();
    expect(r.text).toBe(`Début${TRUNCATED_NOTICE}`);
  });
  it('modèle à raisonnement : tout le budget dépensé en réflexion, aucun texte : erreur claire, pas de silence', async () => {
    const r = await collect([chunk({ reasoning_content: 'Je réfléchis…' }), chunk({ reasoning_content: ' encore' }), chunk({}, 'length')]);
    expect(r.text).toBe('');
    expect(r.error).toBe(EMPTY_TRUNCATED_MESSAGE);
    expect(r.error).toContain('raisonnement');
  });
  it('flux terminé sans aucun texte ni raison : erreur', async () => {
    const r = await collect([chunk({}, 'stop')]);
    expect(r.error).toContain('aucun texte');
  });
  it('flux fermé sans [DONE] après une réponse complète : accepté', async () => {
    const r = await collect([chunk({ content: 'Fini' }, 'stop')], { done: false });
    expect(r).toEqual({ text: 'Fini', error: null });
  });
  it('flux fermé sans [DONE] et sans texte : erreur', async () => {
    const r = await collect([chunk({ reasoning_content: '…' }, 'length')], { done: false });
    expect(r.error).toBe(EMPTY_TRUNCATED_MESSAGE);
  });
});

describe('erreurs du fournisseur compatible OpenAI', () => {
  it('402 : crédits insuffisants, avec la marche à suivre', async () => {
    const m = await messageFor(402);
    expect(m).toContain('Crédits insuffisants');
    expect(m).toContain('402');
  });
  it('400 : nom de modèle ou URL à vérifier', async () => {
    expect(await messageFor(400)).toContain('nom du modèle');
  });
  it('503 : fournisseur indisponible', async () => {
    expect(await messageFor(503)).toContain('indisponible');
  });
});
