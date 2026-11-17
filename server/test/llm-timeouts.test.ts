// Fournisseur IA compatible OpenAI qui ne répond plus : délai avant le premier octet, délai d'inactivité entre deux morceaux,
// fermeture de la connexion, et configuration bornée par l'environnement.
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureLlmTimeouts, DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, LlmError, llmTimeouts, streamCompletion, TIMEOUT_MESSAGE,
} from '../src/ai/llm.js';
import type { AiSettings } from '../src/ai/settings.js';
import { loadConfig } from '../src/config.js';

let server: Server;
const open = new Set<ServerResponse>();
let closed = 0;

beforeEach(() => { open.clear(); closed = 0; configureLlmTimeouts({ firstByteMs: 150, idleMs: 150 }); });
afterEach(async () => {
  configureLlmTimeouts({ firstByteMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS, idleMs: DEFAULT_IDLE_TIMEOUT_MS });
  for (const res of open) res.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

async function provider(handler: (res: ServerResponse) => void): Promise<AiSettings> {
  server = createServer((req, res) => {
    open.add(res);
    // Connexion coupée par le client : comptée pour vérifier la fermeture propre.
    req.socket.on('close', () => { closed++; open.delete(res); });
    req.resume();
    handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { enabled: true, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'k', allowPrivate: true } as AiSettings;
}

async function run(settings: AiSettings, signal = new AbortController().signal) {
  let text = '';
  const started = Date.now();
  try {
    for await (const chunk of streamCompletion(settings, { system: 's', user: 'u' }, signal)) text += chunk;
    return { text, error: null as LlmError | null, ms: Date.now() - started };
  } catch (err) {
    return { text, error: err as LlmError, ms: Date.now() - started };
  }
}

const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe('délais du fournisseur compatible OpenAI', () => {
  it('aucune réponse (pas même les en-têtes) : erreur claire après le délai de premier octet, connexion fermée', async () => {
    const settings = await provider(() => { /* ne répond jamais */ });
    const r = await run(settings);
    expect(r.error).toBeInstanceOf(LlmError);
    expect(r.error!.message).toBe(TIMEOUT_MESSAGE);
    expect(r.error!.status).toBe(504);
    expect(r.ms).toBeGreaterThanOrEqual(140);
    expect(r.ms).toBeLessThan(2000);
    await waitFor(() => closed > 0);
    expect(closed).toBe(1);
  });

  it('en-têtes envoyés puis silence : délai d’inactivité', async () => {
    const settings = await provider((res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); });
    const r = await run(settings);
    expect(r.error?.message).toBe(TIMEOUT_MESSAGE);
    await waitFor(() => closed > 0);
    expect(closed).toBe(1);
  });

  it('flux figé à mi-chemin : le texte déjà reçu est rendu, puis l’erreur de délai', async () => {
    const settings = await provider((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Début ' } }] })}\n\n`);
      setTimeout(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'suite' } }] })}\n\n`), 80);
      // Puis plus rien.
    });
    const r = await run(settings);
    expect(r.text).toBe('Début suite');
    expect(r.error?.message).toBe(TIMEOUT_MESSAGE);
    await waitFor(() => closed > 0);
    expect(closed).toBe(1);
  });

  it('un flux régulier plus long que les délais n’est pas coupé (le délai se réarme à chaque morceau)', async () => {
    const settings = await provider((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const tick = setInterval(() => {
        if (i++ < 5) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
        else { clearInterval(tick); res.end('data: [DONE]\n\n'); }
      }, 80);
    });
    const r = await run(settings);
    expect(r.error).toBeNull();
    expect(r.text).toBe('xxxxx');
    expect(r.ms).toBeGreaterThan(300);
  });

  it('départ du client : arrêt silencieux, sans erreur de délai', async () => {
    const settings = await provider(() => { /* ne répond jamais */ });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await run(settings, controller.signal);
    expect(r.error).toBeNull();
    expect(r.ms).toBeLessThan(140);
  });
});

describe('configuration des délais', () => {
  const base = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
  it('60 s par défaut, surchargeables dans les bornes', () => {
    expect(DEFAULT_FIRST_BYTE_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(60_000);
    const c = loadConfig(base);
    expect([c.AI_FIRST_BYTE_TIMEOUT_MS, c.AI_IDLE_TIMEOUT_MS]).toEqual([60_000, 60_000]);
    const d = loadConfig({ ...base, AI_FIRST_BYTE_TIMEOUT_MS: '5000', AI_IDLE_TIMEOUT_MS: '2000' });
    expect([d.AI_FIRST_BYTE_TIMEOUT_MS, d.AI_IDLE_TIMEOUT_MS]).toEqual([5000, 2000]);
    for (const bad of ['0', '50', '600001', 'abc']) expect(() => loadConfig({ ...base, AI_IDLE_TIMEOUT_MS: bad })).toThrow();
    configureLlmTimeouts({ firstByteMs: 5000, idleMs: 2000 });
    expect(llmTimeouts()).toEqual({ firstByteMs: 5000, idleMs: 2000 });
  });
});
