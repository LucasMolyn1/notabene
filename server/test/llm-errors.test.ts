// Messages d'erreur du fournisseur IA compatible OpenAI : un statut courant doit donner une consigne claire.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmError, streamCompletion } from '../src/ai/llm.js';
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
