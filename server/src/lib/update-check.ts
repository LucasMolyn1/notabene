// Vérification de mise à jour, désactivée par défaut : activable par UPDATE_CHECK=true ou depuis Paramètres, À propos.
// Elle interroge l'API publique de GitHub (dernière release) : l'adresse IP du serveur et la version de Notabene sont alors
// visibles de GitHub. Aucune donnée de l'instance n'est envoyée. Déclenchée seulement quand un administrateur consulte l'écran
// (pas de tâche de fond), résultat gardé en mémoire 12 heures, requête protégée par la garde réseau (net-guard).
import { z } from 'zod';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { compareVersions, parseChangelog, type Release } from './changelog.js';
import { safeFetch } from './net-guard.js';

export interface LatestRelease { version: string; url: string; publishedAt: string | null; /** Notes de version (même format que le CHANGELOG), si la release en publie. */ notes: Release | null }
export interface UpdateStatus {
  enabled: boolean;
  /** « env » : réglé par l'environnement ; « db » : choisi dans l'interface ; `locked` : l'environnement a le dernier mot (CONFIG_LOCKED). */
  source: 'env' | 'db';
  locked: boolean;
  current: string;
  latest: LatestRelease | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  error: string | null;
}

export type Fetcher = (repo: string, current: string) => Promise<unknown>;

const payload = z.object({ tag_name: z.string().max(40), html_url: z.string().max(300), published_at: z.string().max(40).nullish(), draft: z.boolean().optional(), prerelease: z.boolean().optional(), body: z.string().max(100_000).nullish() });
const OK_TTL = 12 * 3_600_000;
const ERROR_TTL = 15 * 60_000;

// Lecteur réel : GitHub, 5 s, sans redirection, réponse bornée.
export const githubFetcher: Fetcher = async (repo, current) => {
  const res = await safeFetch(new URL(`https://api.github.com/repos/${repo}/releases/latest`), {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `Notabene/${current}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  }, false);
  if (res.status === 404) return null; // aucune release publiée
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
  const text = await res.text();
  if (text.length > 200_000) throw new Error('réponse trop volumineuse');
  return JSON.parse(text);
};

export class UpdateChecker {
  #cached: { at: number; ttl: number; latest: LatestRelease | null; error: string | null } | null = null;

  constructor(
    enabled: boolean | (() => { enabled: boolean; source: 'env' | 'db'; locked: boolean }),
    private readonly repo: string,
    private readonly current: string,
    private readonly fetcher: Fetcher = githubFetcher,
  ) {
    this.#setting = typeof enabled === 'function' ? enabled : () => ({ enabled, source: 'env', locked: true });
  }

  readonly #setting: () => { enabled: boolean; source: 'env' | 'db'; locked: boolean };
  get enabled() { return this.#setting().enabled; }

  async status(): Promise<UpdateStatus> {
    const setting = this.#setting();
    const base = { ...setting, current: this.current };
    if (!setting.enabled) return { ...base, latest: null, updateAvailable: false, checkedAt: null, error: null };
    const now = Date.now();
    if (!this.#cached || now - this.#cached.at > this.#cached.ttl) {
      try {
        const raw = await this.fetcher(this.repo, this.current);
        const parsed = raw === null ? null : payload.parse(raw);
        const version = parsed?.tag_name.replace(/^v/, '') ?? '';
        const valid = !!parsed && !parsed.draft && !parsed.prerelease && /^\d+\.\d+\.\d+$/.test(version) && parsed.html_url.startsWith('https://github.com/');
        this.#cached = { at: now, ttl: OK_TTL, latest: valid ? { version, url: parsed!.html_url, publishedAt: parsed!.published_at ?? null, notes: parseChangelog(parsed!.body ?? '').find((r) => r.version === version) ?? null } : null, error: null };
      } catch {
        this.#cached = { at: now, ttl: ERROR_TTL, latest: null, error: 'Vérification impossible (GitHub injoignable ou réponse inattendue).' };
      }
    }
    const { latest, error, at } = this.#cached;
    return { ...base, latest, updateAvailable: !!latest && compareVersions(latest.version, this.current) > 0, checkedAt: at, error };
  }
}

const KEY = 'updates';

// Réglage effectif : l'environnement (UPDATE_CHECK) sert de valeur de départ, le choix fait dans l'interface le remplace
// (sauf CONFIG_LOCKED, où l'environnement garde le dernier mot).
export function updateSetting(db: DB, config: Pick<Config, 'UPDATE_CHECK' | 'CONFIG_LOCKED'>): { enabled: boolean; source: 'env' | 'db'; locked: boolean } {
  if (config.CONFIG_LOCKED) return { enabled: config.UPDATE_CHECK, source: 'env', locked: true };
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return { enabled: config.UPDATE_CHECK, source: 'env', locked: false };
  try { return { enabled: z.object({ enabled: z.boolean() }).parse(JSON.parse(row.value)).enabled, source: 'db', locked: false }; } catch { return { enabled: false, source: 'db', locked: false }; }
}

export function saveUpdateSetting(db: DB, enabled: boolean, userId: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(KEY, JSON.stringify({ enabled }), Date.now(), userId);
}
