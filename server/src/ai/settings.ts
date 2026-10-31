// Paramètres du fournisseur LLM. La clé d'API est chiffrée (AES-256-GCM) en base
// et n'est jamais renvoyée au navigateur : seuls ses 4 derniers caractères sont exposés.
import { z } from 'zod';
import type { DB } from '../db.js';
import type { SecretBox } from '../lib/crypto.js';
import { HttpError, trimTrailingSlashes } from '../lib/http.js';
import { reauthInput } from '../lib/reauth.js';

const KEY = 'ai';
const AAD = 'notabene:ai-api-key';

export const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-4o-mini' } as const;

export const aiSettingsInput = z.object({
  enabled: z.boolean(),
  provider: z.enum(['anthropic', 'openai']),
  baseUrl: z.string().url().max(300).refine((u) => /^https?:\/\//.test(u), 'URL http(s) requise').optional().or(z.literal('')),
  model: z.string().trim().min(1).max(120).regex(/^[\w.:/@-]+$/, 'nom de modèle invalide'),
  // undefined : clé inchangée ; chaîne vide : clé supprimée.
  apiKey: z.string().max(500).optional(),
  // Preuve d'identité récente (voir lib/reauth.ts) : exigée pour toute modification.
  reauth: reauthInput,
});

// Destination de la clé d'API : fournisseur + adresse. Si elle change, la clé enregistrée ne doit pas la suivre sans être ressaisie.
export const aiDestination = (provider: string, baseUrl: string) => `${provider}|${trimTrailingSlashes(baseUrl.trim())}`;

interface Stored {
  enabled: boolean;
  provider: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  apiKeySealed: string | null;
  keyHint: string | null;
}

export interface AiSettings {
  /** Réseaux privés autorisés (AI_ALLOW_PRIVATE) : décidé par l'environnement, pas par la base. */
  allowPrivate: boolean;
  enabled: boolean;
  provider: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

function read(db: DB): Stored {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  const fallback: Stored = { enabled: false, provider: 'anthropic', baseUrl: '', model: DEFAULT_MODELS.anthropic, apiKeySealed: null, keyHint: null };
  return row ? { ...fallback, ...(JSON.parse(row.value) as Partial<Stored>) } : fallback;
}

export function publicAiSettings(db: DB) {
  const s = read(db);
  return { enabled: s.enabled, provider: s.provider, baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKeySealed, keyHint: s.keyHint };
}

export function loadAiSettings(db: DB, box: SecretBox, allowPrivate: boolean): AiSettings {
  const s = read(db);
  return {
    allowPrivate,
    enabled: s.enabled,
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    apiKey: s.apiKeySealed ? box.open(s.apiKeySealed, AAD) : null,
  };
}

export function saveAiSettings(db: DB, box: SecretBox, input: z.output<typeof aiSettingsInput>, userId: string) {
  const prev = read(db);
  if (prev.apiKeySealed && input.apiKey === undefined && aiDestination(prev.provider, prev.baseUrl) !== aiDestination(input.provider, input.baseUrl || '')) {
    throw new HttpError(400, 'L’adresse du fournisseur change : ressaisissez la clé d’API.');
  }
  const next: Stored = {
    enabled: input.enabled,
    provider: input.provider,
    baseUrl: input.baseUrl || '',
    model: input.model,
    apiKeySealed: prev.apiKeySealed,
    keyHint: prev.keyHint,
  };
  if (input.apiKey !== undefined) {
    const key = input.apiKey.trim();
    next.apiKeySealed = key ? box.seal(key, AAD) : null;
    next.keyHint = key ? `…${key.slice(-4)}` : null;
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(KEY, JSON.stringify(next), Date.now(), userId);
  return publicAiSettings(db);
}

export function storedDestination(db: DB) {
  const s = read(db);
  return aiDestination(s.provider, s.baseUrl);
}

// Où part le texte envoyé à l'assistant : « Anthropic », ou l'hôte de l'adresse enregistrée. Affiché avant tout envoi.
export function aiProviderLabel(db: DB): string | null {
  const s = read(db);
  if (!s.enabled) return null;
  if (!s.baseUrl) return s.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  try { return new URL(s.baseUrl).host; } catch { return null; }
}

export function isAiReady(db: DB) {
  const s = read(db);
  return s.enabled && (s.provider === 'openai' ? !!s.baseUrl || !!s.apiKeySealed : !!s.apiKeySealed);
}
