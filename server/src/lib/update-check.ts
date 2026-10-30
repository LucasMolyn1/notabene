// Vérification de mise à jour, désactivée par défaut (UPDATE_CHECK=true pour l'activer).
// Elle interroge l'API publique de GitHub (dernière release) : l'adresse IP du serveur et la version de Notabene sont alors
// visibles de GitHub. Aucune donnée de l'instance n'est envoyée. Déclenchée seulement quand un administrateur consulte l'écran
// (pas de tâche de fond), résultat gardé en mémoire 12 heures, requête protégée par la garde réseau (net-guard).
import { z } from 'zod';
import { compareVersions } from './changelog.js';
import { safeFetch } from './net-guard.js';

export interface LatestRelease { version: string; url: string; publishedAt: string | null }
export interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest: LatestRelease | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  error: string | null;
}

export type Fetcher = (repo: string, current: string) => Promise<unknown>;

const payload = z.object({ tag_name: z.string().max(40), html_url: z.string().max(300), published_at: z.string().max(40).nullish(), draft: z.boolean().optional(), prerelease: z.boolean().optional() });
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
    readonly enabled: boolean,
    private readonly repo: string,
    private readonly current: string,
    private readonly fetcher: Fetcher = githubFetcher,
  ) {}

  async status(): Promise<UpdateStatus> {
    const base = { enabled: this.enabled, current: this.current };
    if (!this.enabled) return { ...base, latest: null, updateAvailable: false, checkedAt: null, error: null };
    const now = Date.now();
    if (!this.#cached || now - this.#cached.at > this.#cached.ttl) {
      try {
        const raw = await this.fetcher(this.repo, this.current);
        const parsed = raw === null ? null : payload.parse(raw);
        const version = parsed?.tag_name.replace(/^v/, '') ?? '';
        const valid = !!parsed && !parsed.draft && !parsed.prerelease && /^\d+\.\d+\.\d+$/.test(version) && parsed.html_url.startsWith('https://github.com/');
        this.#cached = { at: now, ttl: OK_TTL, latest: valid ? { version, url: parsed!.html_url, publishedAt: parsed!.published_at ?? null } : null, error: null };
      } catch {
        this.#cached = { at: now, ttl: ERROR_TTL, latest: null, error: 'Vérification impossible (GitHub injoignable ou réponse inattendue).' };
      }
    }
    const { latest, error, at } = this.#cached;
    return { ...base, latest, updateAvailable: !!latest && compareVersions(latest.version, this.current) > 0, checkedAt: at, error };
  }
}
