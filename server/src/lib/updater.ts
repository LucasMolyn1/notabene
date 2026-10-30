// Pont avec le service de mise à jour de l'hôte (scripts/updater). Notabene ne touche jamais à Docker : il dépose une DEMANDE
// dans un dossier d'échange et lit un STATUT que l'hôte y publie. Tout ce qui vient de ce dossier est traité comme non fiable.
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

export interface UpdaterStatus {
  /** Le service de l'hôte répond (signe de vie récent). */
  available: boolean;
  state: 'idle' | 'running' | 'success' | 'failed' | null;
  version: string | null;
  message: string | null;
  /** Dernier changement d'état (millisecondes). */
  at: number | null;
}

const HEARTBEAT_MAX_AGE_MS = 3 * 60_000;
const MAX_STATUS_BYTES = 8192;
const statusSchema = z.object({
  state: z.enum(['idle', 'running', 'success', 'failed']),
  version: z.string().max(20).default(''),
  message: z.string().max(300).default(''),
  at: z.number().int().nonnegative().default(0),
  heartbeat: z.number().int().nonnegative(),
});

const OFF: UpdaterStatus = { available: false, state: null, version: null, message: null, at: null };

export function readUpdater(dir: string | undefined, now = Date.now()): UpdaterStatus {
  if (!dir) return OFF;
  try {
    const file = join(dir, 'status.json');
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_STATUS_BYTES) return OFF;
    const s = statusSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    return {
      available: now - s.heartbeat * 1000 < HEARTBEAT_MAX_AGE_MS,
      state: s.state,
      version: s.version || null,
      message: s.message || null,
      at: s.at ? s.at * 1000 : null,
    };
  } catch {
    return OFF;
  }
}

/** Dépose la demande (fichier temporaire puis renommage : l'hôte ne lit jamais un fichier à moitié écrit). */
export function requestUpdate(dir: string, version: string, userId: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version invalide');
  const tmp = join(dir, `.request.${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify({ version, requestedBy: userId, requestedAt: Date.now() }), { flag: 'wx', mode: 0o640 });
  renameSync(tmp, join(dir, 'request.json'));
}
