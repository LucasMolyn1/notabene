// Formulaires des bases : une configuration d'une base dont chaque question remplit une colonne, et un lien public par jeton
// pour répondre. Ce fichier ne contrôle pas l'accès de gestion (les routes ouvrent la base en écriture) ; il porte les règles
// du lien public et de la réponse.
//
// Règles de sécurité (testées dans test/base-forms.test.ts) :
//  - Désactivé par défaut : réglage d'instance (administrateur) ET réglage de l'espace (administrateur), jamais dans un espace
//    personnel. Couper l'un ou l'autre révoque les liens concernés (les réactiver ne fait rien réapparaître).
//  - Jeton du lien : 24 octets aléatoires (192 bits), montré une seule fois ; seule son empreinte SHA-256 est gardée. Révocable,
//    renouvelable, retiré avec la base (corbeille, changement d'espace) ou avec le compte qui l'a créé (désactivé, supprimé),
//    et absent des sauvegardes.
//  - Rien n'est définitif : à chaque lecture on revérifie instance, espace, base hors corbeille et restriction de la base,
//    identique à celle confirmée. Sinon le formulaire est introuvable (404 uniforme, sans raison).
//  - Mode « réservé aux comptes » par défaut ; « anonyme » est un choix explicite. En anonyme, ni colonne Personne ni colonne
//    Page (rien qui demande de connaître les personnes ou les pages de l'instance).
//  - Questions : seulement les types qu'un modèle de ligne remplit (TEMPLATE_TYPES) ; jamais formule, cumul, relation, ID unique
//    ni colonne dérivée. Les valeurs sont validées par checkValue, comme une écriture normale ; une clé qui n'est pas une
//    question exposée est refusée.
//  - Aucune lecture par le formulaire : la page publique ne reçoit que la configuration (titre, textes, questions, options des
//    colonnes exposées), jamais une ligne, un nom de personne, le nom de la base ni celui d'une colonne non exposée.
//  - Anti-robot maison : champ piège, et ticket signé HMAC (clé dérivée de ENCRYPTION_KEY) délivré à l'affichage, valable
//    après MIN_FILL_MS et pendant MAX_TICKET_AGE_MS, à usage unique. Aucun CAPTCHA tiers.
//  - Plafonds : réponses par heure par formulaire et par base, débit par adresse IP (route), taille du corps et de chaque
//    valeur ; un formulaire n'écrit plus au-delà de 80 % des plafonds de lignes et de taille de la base (place des membres).
//  - Le lien ne vaut que tant que le compte qui l'a créé est actif et peut modifier la base.
import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { authOf } from './base-automations.js';
import { addRow, baseLevel, checkValue, type Ctx, MAX_BASE_CHARS, MAX_ROW_CHARS, MAX_ROWS, propertiesOf, type Property, rowCount, TEMPLATE_TYPES } from './bases.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';
import { HttpError, idSchema, newId } from './http.js';
import { restrictionKey } from './shares.js';
import { spaceRoles } from './space-access.js';

export const MAX_FORMS = 10;
export const MAX_QUESTIONS = 30;
export const MAX_FORM_TITLE = 120;
export const MAX_FORM_TEXT = 1000;
export const MAX_LABEL = 200;
/** Réponses acceptées par heure et par formulaire (tous répondants confondus). */
export const MAX_RESPONSES_PER_HOUR = 100;
/** Réponses acceptées par heure pour tous les formulaires d'une même base. */
export const MAX_BASE_RESPONSES_PER_HOUR = 200;
/**
 * Part des plafonds de la base (lignes, taille) au-delà de laquelle les formulaires n'écrivent plus : le reste est gardé pour
 * les membres, qu'un formulaire ne doit jamais bloquer.
 */
export const FORM_ROOM_RATIO = 0.8;
/** Réponses par minute et par adresse IP (préfixe /64 en IPv6), tous formulaires confondus (limite de la route). */
export const SUBMIT_PER_MINUTE = 5;
/** Taille maximale d'une valeur (JSON) et du corps d'une réponse. */
export const MAX_ANSWER_CHARS = 4000;
export const MAX_BODY_BYTES = 32 * 1024;
/** Délai minimal entre l'affichage du formulaire et l'envoi, et durée de validité du ticket. */
export const MIN_FILL_MS = 3000;
export const MAX_TICKET_AGE_MS = 2 * 3_600_000;
export const FORM_MODES = ['accounts', 'anonymous'] as const;
export type FormMode = typeof FORM_MODES[number];
/** Forme d'un jeton de formulaire : 24 octets en base64url. */
export const FORM_TOKEN = /^[A-Za-z0-9_-]{32}$/;
/** Types de colonnes jamais exposés dans un formulaire anonyme. */
export const ANONYMOUS_FORBIDDEN = new Set(['person', 'page_link']);

const KEY = 'base_forms';

export const formsEnabled = (db: DB): boolean => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  try { return !!row && (JSON.parse(row.value) as { enabled?: boolean }).enabled === true; } catch { return false; }
};

/** Active ou coupe les formulaires de l'instance. Couper révoque tous les liens (renvoie leur nombre) ; la configuration reste. */
export function setFormsEnabled(db: DB, enabled: boolean, userId: string): number {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(KEY, JSON.stringify({ enabled }), Date.now(), userId);
    return enabled ? 0 : revokeWhere(db, '1 = 1');
  })();
}

/** Révoque les liens des formulaires des bases d'un espace (espace dont les formulaires sont coupés). */
export const revokeSpaceForms = (db: DB, spaceId: string): number =>
  revokeWhere(db, 'base_id IN (SELECT id FROM pages WHERE space_id = ?)', spaceId);
const revokeWhere = (db: DB, where: string, ...args: unknown[]): number =>
  db.prepare(`UPDATE base_forms SET token_hash = NULL, link_created_at = NULL WHERE token_hash IS NOT NULL AND ${where}`).run(...args).changes;

// ---------- Configuration ----------

export interface Question { propertyId: string; label: string; required: boolean }
export interface FormRow {
  id: string; base_id: string; title: string; description: string; thanks: string; questions: string; mode: FormMode; notify: number;
  token_hash: string | null; link_created_at: number | null; link_by: string | null; restricted_key: string | null; author_id: string | null;
  hour_start: number; hour_count: number; responses: number; last_response_at: number | null; position: number; created_at: number; updated_at: number;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_LINE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Texte d'une ligne (titre, libellé) : sans caractère de contrôle ni de direction, espaces de bord retirés. */
const line = (max: number) => z.string().max(max * 2).transform((v) => v.replace(CONTROL_LINE, '').normalize('NFC').trim()).pipe(z.string().max(max));
/** Texte libre en texte brut (description, remerciement) : retours à la ligne gardés, autres caractères de contrôle retirés. */
const text = (max: number) => z.string().max(max * 2).transform((v) => v.replace(CONTROL, '').replace(/\r\n?/g, '\n').normalize('NFC').trim()).pipe(z.string().max(max));

export const formTitle = line(MAX_FORM_TITLE).pipe(z.string().min(1));
export const formText = text(MAX_FORM_TEXT);
export const questionsInput = z.array(z.object({
  propertyId: idSchema,
  label: line(MAX_LABEL).optional(),
  required: z.boolean().optional(),
}).strict()).min(1).max(MAX_QUESTIONS);

export const formsOf = (db: DB, baseId: string) =>
  db.prepare('SELECT * FROM base_forms WHERE base_id = ? ORDER BY position, created_at').all(baseId) as FormRow[];

export function formById(db: DB, baseId: string, id: string): FormRow {
  const f = db.prepare('SELECT * FROM base_forms WHERE id = ? AND base_id = ?').get(id, baseId) as FormRow | undefined;
  if (!f) throw new HttpError(404, 'Formulaire introuvable');
  return f;
}

const parseQuestions = (raw: string): Question[] => {
  try { return JSON.parse(raw) as Question[]; } catch { return []; }
};

/** Une colonne peut-elle être une question de ce formulaire ? */
const exposable = (p: Property, mode: FormMode) => TEMPLATE_TYPES.has(p.type) && !(mode === 'anonymous' && ANONYMOUS_FORBIDDEN.has(p.type));

/** Valide des questions pour un mode. Lève 400 (colonne inconnue, type non admis, doublon, Personne ou Page en anonyme). */
export function checkQuestions(props: Property[], input: z.output<typeof questionsInput>, mode: FormMode): Question[] {
  const byId = new Map(props.map((p) => [p.id, p]));
  const seen = new Set<string>();
  return input.map((q) => {
    const p = byId.get(q.propertyId);
    if (!p) throw new HttpError(400, 'Colonne inconnue');
    if (seen.has(p.id)) throw new HttpError(400, `Colonne « ${p.name} » : déjà posée dans ce formulaire`);
    seen.add(p.id);
    if (!TEMPLATE_TYPES.has(p.type)) throw new HttpError(400, `Colonne « ${p.name} » : ce type de colonne ne peut pas être une question`);
    if (mode === 'anonymous' && ANONYMOUS_FORBIDDEN.has(p.type)) throw new HttpError(400, `Colonne « ${p.name} » : une colonne Personne ou Page n’est pas permise dans un formulaire anonyme`, { reason: 'anonymous_type' });
    return { propertyId: p.id, label: q.label ?? '', required: q.required === true };
  });
}

/** Questions encore valables (colonne présente et admise pour le mode), avec leur colonne. */
export function liveQuestions(props: Property[], form: Pick<FormRow, 'questions' | 'mode'>): { q: Question; p: Property }[] {
  const byId = new Map(props.map((p) => [p.id, p]));
  return parseQuestions(form.questions).flatMap((q) => {
    const p = byId.get(q.propertyId);
    return p && exposable(p, form.mode) ? [{ q, p }] : [];
  });
}

/** Vue de gestion (droit d'écriture sur la base). Jamais le jeton : il n'est montré qu'à sa création. */
export function presentForm(db: DB, form: FormRow, props = propertiesOf(db, form.base_id)) {
  const key = restrictionKey(db, form.base_id);
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    thanks: form.thanks,
    mode: form.mode,
    notify: !!form.notify,
    questions: liveQuestions(props, form).map(({ q }) => q),
    active: form.token_hash !== null,
    linkCreatedAt: form.link_created_at,
    confirmed: key === null || form.restricted_key === key,
    responses: form.responses,
    lastResponseAt: form.last_response_at,
    createdAt: form.created_at,
    updatedAt: form.updated_at,
  };
}

/**
 * Base restreinte : confirmation exigée, sauf si ce formulaire l'a déjà reçue pour exactement cette restriction. Rend la clé de
 * restriction à enregistrer.
 */
export function confirmRestriction(db: DB, baseId: string, confirmed: boolean | undefined, current: FormRow | null): string | null {
  const key = restrictionKey(db, baseId);
  if (key !== null && confirmed !== true && current?.restricted_key !== key) {
    throw new HttpError(409, 'Cette base a des permissions restreintes : confirmez pour y ouvrir un formulaire', { reason: 'restricted' });
  }
  return key;
}

export interface FormInput {
  title?: string; description?: string; thanks?: string; mode?: FormMode; notify?: boolean;
  questions?: z.output<typeof questionsInput>;
}

/** Le passage du mode comptes au mode anonyme (qui révoque le lien en cours : il faut en recréer un). */
export const opensToAnonymous = (input: Pick<FormInput, 'mode'>, current: FormRow | null) =>
  !!current && current.mode !== 'anonymous' && input.mode === 'anonymous';

/**
 * Crée ou modifie un formulaire. Celui qui enregistre en devient l'auteur (destinataire de la notification). Passer en anonyme
 * révoque le lien : un lien distribué pour des comptes ne s'ouvre jamais à l'anonyme sans nouvelle décision.
 */
export function saveForm(db: DB, baseId: string, userId: string, input: FormInput, restricted: string | null, current: FormRow | null): FormRow {
  return db.transaction(() => {
    const props = propertiesOf(db, baseId);
    const mode = input.mode ?? current?.mode ?? 'accounts';
    // Questions reçues, sinon les questions actuelles revalidées pour le mode (passer en anonyme refuse Personne et Page).
    const raw = input.questions ?? (current ? liveQuestions(props, { questions: current.questions, mode: 'accounts' }).map(({ q }) => ({ propertyId: q.propertyId, label: q.label, required: q.required })) : undefined);
    if (!raw) throw new HttpError(400, 'Au moins une question');
    const questions = checkQuestions(props, raw, mode);
    if (!questions.length) throw new HttpError(400, 'Au moins une question');
    const now = Date.now();
    if (!current) {
      const existing = formsOf(db, baseId);
      if (existing.length >= MAX_FORMS) throw new HttpError(409, `Au plus ${MAX_FORMS} formulaires par base`);
      const id = newId();
      db.prepare(`INSERT INTO base_forms (id, base_id, title, description, thanks, questions, mode, notify, restricted_key, author_id, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, baseId, input.title ?? 'Formulaire', input.description ?? '', input.thanks ?? '', JSON.stringify(questions), mode, input.notify ? 1 : 0,
          restricted, userId, existing.length ? existing[existing.length - 1]!.position + 1 : 0, now, now);
      return formById(db, baseId, id);
    }
    db.prepare('UPDATE base_forms SET title = ?, description = ?, thanks = ?, questions = ?, mode = ?, notify = ?, restricted_key = ?, author_id = ?, updated_at = ? WHERE id = ?')
      .run(input.title ?? current.title, input.description ?? current.description, input.thanks ?? current.thanks, JSON.stringify(questions), mode,
        input.notify === undefined ? current.notify : input.notify ? 1 : 0, restricted, userId, now, current.id);
    if (opensToAnonymous(input, current)) db.prepare('UPDATE base_forms SET token_hash = NULL, link_created_at = NULL WHERE id = ?').run(current.id);
    return formById(db, baseId, current.id);
  })();
}

/** Crée le lien du formulaire ou fait tourner son jeton (l'ancien cesse aussitôt de valoir). Rend le jeton, une seule fois. */
export function createOrRotateLink(db: DB, form: FormRow, restricted: string | null, userId: string): { token: string; rotated: boolean } {
  const token = randomToken(24);
  db.prepare('UPDATE base_forms SET token_hash = ?, link_created_at = ?, link_by = ?, restricted_key = ? WHERE id = ?').run(sha256(token), Date.now(), userId, restricted, form.id);
  return { token, rotated: form.token_hash !== null };
}

export const revokeLink = (db: DB, form: FormRow): boolean =>
  db.prepare('UPDATE base_forms SET token_hash = NULL, link_created_at = NULL WHERE id = ? AND token_hash IS NOT NULL').run(form.id).changes > 0;

// ---------- Lien public ----------

/** Formulaire servi par le jeton, s'il est encore valable. Sinon null (jamais de détail sur la raison). */
export function activeForm(db: DB, token: string): { form: FormRow; spaceId: string; props: Property[]; questions: { q: Question; p: Property }[] } | null {
  if (!FORM_TOKEN.test(token) || !formsEnabled(db)) return null;
  const hash = sha256(token);
  const form = db.prepare('SELECT * FROM base_forms WHERE token_hash = ?').get(hash) as FormRow | undefined;
  if (!form?.token_hash || !safeEqual(form.token_hash, hash)) return null;
  const base = db.prepare(
    `SELECT p.id, p.space_id FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE p.id = ? AND p.deleted_at IS NULL AND p.kind = 'base' AND s.forms_enabled = 1 AND s.kind != 'personal'`,
  ).get(form.base_id) as { id: string; space_id: string } | undefined;
  if (!base) return null;
  // Restriction changée (posée, retirée ou modifiée) depuis la confirmation : le formulaire se tait jusqu'à une reconfirmation.
  if (restrictionKey(db, base.id) !== form.restricted_key) return null;
  // Le compte qui a créé le lien doit être actif et pouvoir encore modifier la base (espace, permissions de page, rôle) : sinon le
  // lien est mort, comme un accès qu'il n'a plus le droit de prêter.
  const creator = authOf(db, form.link_by);
  if (!creator || baseLevel({ db, auth: creator, spaces: new Set(spaceRoles(db, creator).keys()) }, base.id) !== 'write') return null;
  const props = propertiesOf(db, base.id);
  const questions = liveQuestions(props, form);
  if (!questions.length) return null;
  return { form, spaceId: base.space_id, props, questions };
}

/** Configuration publique : rien d'autre que ce que le rédacteur a choisi d'exposer. */
export function publicForm(form: FormRow, questions: { q: Question; p: Property }[]) {
  return {
    title: form.title,
    description: form.description,
    mode: form.mode,
    questions: questions.map(({ q, p }) => ({
      id: p.id,
      label: q.label || p.name,
      type: p.type,
      required: q.required,
      ...(p.type === 'select' || p.type === 'multi_select' || p.type === 'status' ? { options: p.options.map((o) => ({ id: o.id, name: o.name, color: o.color })) } : {}),
    })),
  };
}

// ---------- Débit ----------

/**
 * Clé de débit d'une adresse : l'adresse IPv4 telle quelle, le préfixe /64 d'une adresse IPv6 (un hôte en dispose
 * d'ordinaire en entier). Une IPv4 notée en IPv6 (::ffff:a.b.c.d) redevient une IPv4.
 */
export function ipRateKey(ip: string): string {
  const mapped = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : null;
  if (mapped && isIPv4(mapped)) return mapped;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail] = ip.toLowerCase().split('%')[0]!.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  // Une IPv4 en fin d'adresse compte pour deux groupes ; seuls les quatre premiers servent ici.
  const width = (gs: string[]) => gs.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - width(left) - width(right))).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// ---------- Ticket anti-robot ----------

const TICKET = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const MAX_USED = 100_000;

export type TicketCheck = { ok: true; nonce: string } | { ok: false; reason: 'ticket' | 'too_fast' };

/**
 * Tickets signés : `<émis à, base 36>.<nonce>.<HMAC-SHA256>`, liés au formulaire et à l'empreinte de son jeton (renouveler le
 * lien invalide les tickets en cours). Usage unique : le nonce est consommé à la réponse acceptée.
 */
export class FormTickets {
  readonly #key: Buffer;
  readonly #used = new Map<string, number>();

  constructor(encryptionKey: string) {
    // Clé dérivée, propre à cet usage : la clé de chiffrement n'est jamais employée telle quelle.
    this.#key = createHmac('sha256', Buffer.from(encryptionKey, 'base64')).update('notabene:base-form-ticket:v1').digest();
  }

  #mac(form: Pick<FormRow, 'id' | 'token_hash'>, at: number, nonce: string) {
    return createHmac('sha256', this.#key).update(`${form.id}|${form.token_hash ?? ''}|${at}|${nonce}`).digest('base64url');
  }

  issue(form: Pick<FormRow, 'id' | 'token_hash'>, now = Date.now()): string {
    const nonce = randomToken(12);
    return `${now.toString(36)}.${nonce}.${this.#mac(form, now, nonce)}`;
  }

  check(form: Pick<FormRow, 'id' | 'token_hash'>, ticket: string, now = Date.now()): TicketCheck {
    const m = TICKET.exec(ticket);
    if (!m) return { ok: false, reason: 'ticket' };
    const at = parseInt(m[1]!, 36);
    const nonce = m[2]!;
    if (!Number.isSafeInteger(at) || !safeEqual(m[3]!, this.#mac(form, at, nonce))) return { ok: false, reason: 'ticket' };
    if (now - at > MAX_TICKET_AGE_MS || at > now + 60_000) return { ok: false, reason: 'ticket' };
    if (this.#used.has(nonce)) return { ok: false, reason: 'ticket' };
    if (now - at < MIN_FILL_MS) return { ok: false, reason: 'too_fast' };
    return { ok: true, nonce };
  }

  consume(nonce: string, now = Date.now()) {
    if (this.#used.size >= MAX_USED) {
      for (const [n, exp] of this.#used) if (exp <= now) this.#used.delete(n);
      // Toujours plein : les plus anciens partent (le plafond horaire par formulaire borne de toute façon un rejeu).
      for (const n of this.#used.keys()) { if (this.#used.size < MAX_USED) break; this.#used.delete(n); }
    }
    this.#used.set(nonce, now + MAX_TICKET_AGE_MS);
  }
}

// ---------- Réponse ----------

const bad = (q: Question, p: Property, reason: string, message: string): never => {
  throw new HttpError(400, `${message} : « ${q.label || p.name} »`, { reason, questionId: p.id });
};
// Réponse donnée : une case obligatoire doit être cochée, un texte obligatoire ne peut pas être fait que d'espaces.
const answered = (p: Property, v: unknown) => v !== null && !(p.type === 'checkbox' && v !== true) && !(typeof v === 'string' && !v.trim());

/**
 * Valide les réponses et rend les valeurs de la ligne. `respondent` : compte qui répond (mode comptes), null en anonyme.
 * Lève 400 avec `reason` : unknown_question, invalid, required, too_large.
 */
export function checkAnswers(ctx: Ctx, form: FormRow, questions: { q: Question; p: Property }[], answers: Record<string, unknown>, respondent: Auth | null): Record<string, unknown> {
  const byId = new Map(questions.map((x) => [x.p.id, x]));
  for (const key of Object.keys(answers)) {
    if (!byId.has(key)) throw new HttpError(400, 'Réponse à une question inconnue', { reason: 'unknown_question' });
  }
  const vals = new Map<string, unknown>();
  for (const { q, p } of questions) {
    const raw = Object.hasOwn(answers, p.id) ? answers[p.id] : null;
    if (raw !== null && raw !== undefined && JSON.stringify(raw).length > MAX_ANSWER_CHARS) bad(q, p, 'too_large', 'Réponse trop longue');
    // Défense en profondeur : un formulaire anonyme ne remplit jamais une colonne Personne ou Page.
    if (form.mode === 'anonymous' && ANONYMOUS_FORBIDDEN.has(p.type)) bad(q, p, 'invalid', 'Question non permise');
    // Mode comptes : une colonne Personne n'accepte que la personne qui répond (le formulaire ne liste personne).
    if (p.type === 'person' && raw !== null && raw !== undefined && raw !== respondent?.user.id) bad(q, p, 'invalid', 'Réponse invalide');
    let v: unknown;
    try { v = raw === undefined ? null : checkValue(ctx, p, raw); } catch (err) {
      // Le message de checkValue nomme la colonne : on ne rend que le libellé de la question.
      if (err instanceof HttpError && err.statusCode === 400) bad(q, p, 'invalid', 'Réponse invalide');
      throw err;
    }
    if (q.required && !answered(p, v)) bad(q, p, 'required', 'Réponse obligatoire');
    if (v !== null) vals.set(p.id, v);
  }
  const out = Object.fromEntries(vals);
  if (JSON.stringify(out).length > MAX_ROW_CHARS) throw new HttpError(400, 'Réponse trop volumineuse', { reason: 'too_large' });
  return out;
}

/**
 * Écrit la réponse comme une ligne de la base, dans une transaction avec le plafond horaire du formulaire. `createdBy` : compte
 * (mode comptes) ou null (anonyme). Plafond horaire atteint : 429 ; base pleine : 409.
 */
export function writeResponse(ctx: Ctx, form: FormRow, vals: Record<string, unknown>, createdBy: string | null, now = Date.now()): string {
  const { db } = ctx;
  return db.transaction(() => {
    const cur = db.prepare('SELECT hour_start, hour_count FROM base_forms WHERE id = ?').get(form.id) as { hour_start: number; hour_count: number };
    const hour = now - cur.hour_start < 3_600_000 ? { start: cur.hour_start, count: cur.hour_count } : { start: now, count: 0 };
    if (hour.count >= MAX_RESPONSES_PER_HOUR) throw new HttpError(429, 'Ce formulaire a reçu trop de réponses : réessayez plus tard', { reason: 'quota' });
    // Tous les formulaires de la base (fenêtres encore ouvertes) : plusieurs formulaires ne contournent pas le plafond.
    const baseHour = (db.prepare('SELECT COALESCE(SUM(hour_count), 0) AS n FROM base_forms WHERE base_id = ? AND hour_start > ?').get(form.base_id, now - 3_600_000) as { n: number }).n;
    if (baseHour >= MAX_BASE_RESPONSES_PER_HOUR) throw new HttpError(429, 'Ce formulaire a reçu trop de réponses : réessayez plus tard', { reason: 'quota' });
    // Place gardée aux membres : au-delà de FORM_ROOM_RATIO des plafonds de lignes ou de taille, plus de réponse.
    const chars = (db.prepare('SELECT COALESCE(SUM(length(vals)), 0) AS n FROM base_rows WHERE base_id = ?').get(form.base_id) as { n: number }).n;
    if (rowCount(db, form.base_id) >= Math.floor(MAX_ROWS * FORM_ROOM_RATIO) || chars + JSON.stringify(vals).length > MAX_BASE_CHARS * FORM_ROOM_RATIO) {
      throw new HttpError(409, 'Ce formulaire n’accepte plus de réponses pour le moment', { reason: 'full' });
    }
    let rowId: string;
    try { rowId = addRow(ctx, vals, createdBy).id; } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) throw new HttpError(409, 'Ce formulaire n’accepte plus de réponses pour le moment', { reason: 'full' });
      if (err instanceof HttpError && err.statusCode === 400) throw new HttpError(400, 'Réponse invalide', { reason: 'invalid' });
      throw err;
    }
    db.prepare('UPDATE base_forms SET hour_start = ?, hour_count = ?, responses = responses + 1, last_response_at = ? WHERE id = ?').run(hour.start, hour.count + 1, now, form.id);
    return rowId;
  })();
}
