// Fournisseurs LLM : Claude via le SDK officiel Anthropic, ou tout endpoint compatible
// OpenAI (OpenAI, Mistral, Ollama, LM Studio…) via fetch. Les deux renvoient un flux de texte.
import Anthropic from '@anthropic-ai/sdk';
import { guardedFetch, safeFetch } from '../lib/net-guard.js';
import type { AiSettings } from './settings.js';

export class LlmError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export interface Prompt {
  system: string;
  user: string;
  maxTokens?: number;
}

// Modèles Claude acceptant le repli serveur automatique en cas de refus.
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
// Modèles Claude acceptant le paramètre `effort`.
const EFFORT_MODELS = /^claude-(opus-(5|4-[5-8])|sonnet-5|fable-5|haiku-5)/;

async function* streamAnthropic(s: AiSettings, prompt: Prompt, signal: AbortSignal): AsyncGenerator<string> {
  const client = new Anthropic({
    apiKey: s.apiKey ?? undefined,
    ...(s.baseUrl ? { baseURL: s.baseUrl } : {}),
    // Connexion épinglée sur l'adresse vérifiée (net-guard) : la clé ne part jamais vers une adresse interne non autorisée.
    fetch: guardedFetch(s.allowPrivate),
    maxRetries: 2,
    timeout: 120_000,
  });
  const params = {
    model: s.model,
    max_tokens: prompt.maxTokens ?? 16_000,
    system: prompt.system,
    messages: [{ role: 'user' as const, content: prompt.user }],
    ...(EFFORT_MODELS.test(s.model) ? { output_config: { effort: 'medium' as const } } : {}),
  };

  try {
    const stream = SERVER_FALLBACK_MODELS.has(s.model)
      ? client.beta.messages.stream(
        { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as Parameters<typeof client.beta.messages.stream>[0],
        { signal },
      )
      : client.messages.stream(params, { signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') yield '\n\n_Le modèle a refusé de répondre à cette question._';
    else if (final.stop_reason === 'max_tokens') yield '\n\n_Réponse tronquée (limite de longueur atteinte)._';
  } catch (err) {
    if (signal.aborted) return;
    if (err instanceof Anthropic.AuthenticationError) throw new LlmError('Clé d’API Anthropic refusée', 502);
    if (err instanceof Anthropic.NotFoundError) throw new LlmError(`Modèle introuvable : ${s.model}`, 502);
    if (err instanceof Anthropic.RateLimitError) throw new LlmError('Limite de débit du fournisseur atteinte, réessayez plus tard', 503);
    if (err instanceof Anthropic.APIConnectionError) throw new LlmError('Fournisseur injoignable', 504);
    if (err instanceof Anthropic.APIError) throw new LlmError(`Erreur du fournisseur (${err.status ?? 'inconnue'})`, 502);
    throw err;
  }
}

async function* streamOpenAiCompatible(s: AiSettings, prompt: Prompt, signal: AbortSignal): AsyncGenerator<string> {
  const base = (s.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await safeFetch(new URL(`${base}/chat/completions`), {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify({
        model: s.model,
        stream: true,
        max_tokens: prompt.maxTokens ?? 4000,
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      }),
    }, s.allowPrivate) as unknown as Response;
  } catch (err) {
    if (signal.aborted) return;
    throw new LlmError('Fournisseur injoignable', 504);
  }
  if (res.status === 401 || res.status === 403) throw new LlmError('Clé d’API refusée par le fournisseur', 502);
  if (res.status === 404) throw new LlmError(`Modèle ou endpoint introuvable : ${s.model}`, 502);
  if (res.status === 429) throw new LlmError('Limite de débit du fournisseur atteinte, réessayez plus tard', 503);
  if (!res.ok || !res.body) throw new LlmError(`Erreur du fournisseur (${res.status})`, 502);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
      } catch { /* ligne keep-alive ou partielle */ }
    }
  }
}

export function streamCompletion(s: AiSettings, prompt: Prompt, signal: AbortSignal) {
  if (s.provider === 'anthropic' && !s.apiKey) throw new LlmError('Aucune clé d’API configurée', 400);
  return s.provider === 'anthropic' ? streamAnthropic(s, prompt, signal) : streamOpenAiCompatible(s, prompt, signal);
}

// Modèles proposés par le fournisseur (liste déroulante des réglages).
export async function listModels(s: AiSettings, signal: AbortSignal): Promise<string[]> {
  const ids = new Set<string>();
  try {
    if (s.provider === 'anthropic') {
      const client = new Anthropic({ apiKey: s.apiKey ?? undefined, ...(s.baseUrl ? { baseURL: s.baseUrl } : {}), fetch: guardedFetch(s.allowPrivate), maxRetries: 1, timeout: 20_000 });
      for await (const m of client.models.list({ limit: 100 }, { signal })) {
        ids.add(m.id);
        if (ids.size >= 300) break;
      }
    } else {
      const base = (s.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const res = await safeFetch(new URL(`${base}/models`), {
        signal,
        redirect: 'error',
        headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      }, s.allowPrivate);
      if (res.status === 401 || res.status === 403) throw new LlmError('Clé d’API refusée par le fournisseur', 502);
      if (!res.ok) throw new LlmError(`Le fournisseur ne liste pas ses modèles (${res.status})`, 502);
      const data = ((await res.json()) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] });
      for (const m of data.data ?? []) if (typeof m.id === 'string') ids.add(m.id);
      for (const m of data.models ?? []) if (typeof m.name === 'string') ids.add(m.name);
    }
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new LlmError('Clé d’API Anthropic refusée', 502);
    throw new LlmError('Fournisseur injoignable', 504);
  }
  return [...ids].filter((id) => /^[\w.:/@-]{1,120}$/.test(id)).sort((a, b) => a.localeCompare(b)).slice(0, 300);
}
