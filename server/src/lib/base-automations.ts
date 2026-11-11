// Automatisations et boutons de ligne des bases.
//
// Règles de sécurité (toutes testées dans test/base-automations.test.ts) :
//  - Aucune chaîne : les écritures faites par une automatisation ne déclenchent jamais une autre automatisation. Les déclencheurs
//    ne sont appelés que par les routes d'écriture d'une personne (routes/bases.ts) ; le moteur écrit directement par
//    addRow / patchRow, sans repasser par ces routes, et refuse en plus tout déclenchement pendant une exécution (#depth).
//  - Droits : une automatisation (ligne ajoutée, propriété modifiée, récurrence) agit avec les droits de son AUTEUR, la dernière
//    personne qui a configuré son déclencheur ou ses actions, relus à chaque exécution : compte désactivé ou supprimé, accès en
//    écriture perdu sur la base ou rôle réduit = automatisation suspendue. Jamais plus que l'auteur : chaque action est
//    revalidée avec ses droits (base cible, personnes, pages, options), exactement comme une écriture de sa part.
//  - Bouton de ligne : décision du lot P7, l'action est explicite et immédiate, elle agit donc avec les droits de la personne qui
//    CLIQUE, à condition qu'elle puisse modifier la base (la route l'exige) ; jamais avec ceux de l'auteur. Un lecteur ne peut
//    pas cliquer. Ainsi un bouton configuré par un administrateur ne prête jamais ses droits à un rédacteur.
//  - Modifier le déclencheur ou les actions, ou réactiver, fait de la personne qui modifie le nouvel auteur, après revalidation
//    avec SES droits (impossible de détourner l'automatisation d'une personne plus puissante). Renommer ou désactiver ne change
//    pas l'auteur (cela ne donne aucun pouvoir).
//  - Coupe-circuits : pause après MAX_FAILURES erreurs consécutives, pause si plus de MAX_RUNS_PER_MINUTE ou MAX_RUNS_PER_HOUR
//    exécutions, exécution sautée au-delà de MAX_BASE_RUNS_PER_MINUTE pour toute la base. Plafonds : automatisations par base,
//    actions par automatisation, lignes touchées par exécution, destinataires, filtres.
//  - Entrées : zod strict, identifiants et opérateurs de listes fermées, valeurs validées par le type de la colonne
//    (checkValue) ; aucune expression ni formule libre. Une configuration devenue invalide (colonne, option ou base disparue)
//    met l'automatisation « en panne », sans rien écrire.
//  - Webhook : uniquement par postSigned (garde réseau lib/net-guard.ts, pas de redirection, délai court), désactivé par
//    défaut pour l'instance (réglage d'administration), jamais depuis un espace personnel. L'adresse et le secret sont chiffrés
//    au repos ; les réponses ne montrent que l'origine de l'adresse ; le secret n'est montré qu'à sa création. Le corps ne
//    contient que des identifiants, jamais le contenu des lignes.
//  - Lecture : historique avec des codes fermés et des nombres, jamais de contenu ; une action vers une base que le lecteur ne
//    peut pas lire est masquée ; les personnes citées ne sont nommées que si elles lisent la base.
import { z } from 'zod';
import { type Auth, can, type Scope } from '../auth/context.js';
import type { DB } from '../db.js';
import { audit } from './audit.js';
import { matchesFilter } from './base-chart.js';
import {
  addRow, baseLevel, checkValue, cleanName, FILTER_OPS, MAX_PROPERTIES, patchRow, presentRows, propertiesOf, readBudget, reindexBase,
  TEMPLATE_TYPES, touchBase, type Ctx, type Property,
} from './bases.js';
import type { Budget } from './formula.js';
import type { SecretBox } from './crypto.js';
import { randomToken } from './crypto.js';
import type { EventBus } from './events.js';
import { HttpError, idSchema, newId } from './http.js';
import { readersAmong } from './mentions.js';
import type { Notifier } from './notifications.js';
import { canReadPage } from './page-acl.js';
import { inPersonalSpace } from './personal-spaces.js';
import { spaceRoles } from './space-access.js';
import { postSigned } from './webhooks.js';

export const MAX_AUTOMATIONS = 20;
export const MAX_ACTIONS = 5;
export const MAX_ROWS_TOUCHED = 100;
export const MAX_RECIPIENTS = 20;
export const MAX_FILTERS = 5;
/** Erreurs consécutives avant la mise en pause. */
export const MAX_FAILURES = 5;
export const MAX_RUNS_PER_MINUTE = 20;
export const MAX_RUNS_PER_HOUR = 200;
/** Exécutions par minute pour toutes les automatisations d'une base (au-delà, l'exécution est sautée). */
export const MAX_BASE_RUNS_PER_MINUTE = 60;
/** Exécutions gardées dans l'historique de chaque automatisation. */
export const RUN_HISTORY = 50;
/** Automatisations récurrentes traitées à chaque passage du planificateur, en tout et par auteur (équité). */
export const MAX_DUE_PER_TICK = 20;
export const MAX_DUE_PER_AUTHOR_PER_TICK = 5;
/** Automatisations récurrentes dont une même personne peut être l'auteur (toutes bases confondues). */
export const MAX_RECURRENCES_PER_AUTHOR = 50;
export const TICK_MS = 60_000;

export const TRIGGER_KINDS = ['row_added', 'property_changed', 'recurrence', 'button'] as const;
export type TriggerKind = typeof TRIGGER_KINDS[number];
export const RECURRENCES = ['hour', 'day', 'week', 'month'] as const;
export const STATUSES = ['active', 'paused', 'suspended', 'broken'] as const;
export type Status = typeof STATUSES[number];
/** Raison d'un état autre que « active » : erreurs répétées, fréquence, auteur indisponible, accès perdu, configuration invalide. */
export type Reason = 'errors' | 'frequency' | 'author' | 'access' | 'config';
/** Codes d'une exécution (liste fermée). */
export type RunCode = 'ok' | 'truncated' | 'access' | 'author' | 'config' | 'frequency' | 'limit_base' | 'limit_rows' | 'write_failed' | 'webhook_failed' | 'webhook_disabled' | 'trashed';

const SETTING_KEY = 'automation_webhooks';

// ---------- Schémas ----------

const TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
const timeZone = z.string().max(64).refine((v) => TIME_ZONES.has(v), 'fuseau horaire inconnu');
/** Valeur calculée au moment de l'exécution : date du jour (colonne Date ou Plage), personne qui a déclenché (colonne Personne). */
const dynamicValue = z.object({ dynamic: z.enum(['today', 'actor']) }).strict();
const cellValue = z.union([
  z.string().max(2000), z.number().finite(), z.boolean(), z.array(z.string().max(64)).max(20),
  z.object({ start: z.string().max(10), end: z.string().max(10).nullable().optional() }).strict(), z.null(),
]);
const actionValue = z.union([dynamicValue, cellValue]);
type ActionValue = z.output<typeof actionValue>;
const filterSchema = z.object({
  propertyId: idSchema,
  op: z.enum(FILTER_OPS),
  value: z.union([z.string().max(200), z.number().finite(), z.boolean(), z.object({ dynamic: z.literal('today') }).strict()]).nullable().optional(),
}).strict();
type Filter = z.output<typeof filterSchema>;
const filters = z.array(filterSchema).max(MAX_FILTERS).default([]);

export const triggerSchema = z.discriminatedUnion('type', [
  // Ligne ajoutée par une personne, si elle passe les filtres.
  z.object({ type: z.literal('row_added'), filters }).strict(),
  // Cellule `propertyId` modifiée par une personne, si la ligne passe ensuite les filtres (« Statut devient Terminé »).
  z.object({ type: z.literal('property_changed'), propertyId: idSchema, filters }).strict(),
  // Récurrence : chaque heure (minute 0), chaque jour, semaine (`weekday`, 0 = dimanche) ou mois (`day`, 1 à 28), à `hour`
  // dans le fuseau `timeZone`. « Modifier une propriété » s'applique aux lignes qui passent les filtres.
  z.object({
    type: z.literal('recurrence'), every: z.enum(RECURRENCES), hour: z.number().int().min(0).max(23).default(8),
    weekday: z.number().int().min(0).max(6).default(1), day: z.number().int().min(1).max(28).default(1), timeZone: timeZone.default('UTC'), filters,
  }).strict(),
  // Bouton affiché sur chaque ligne.
  z.object({ type: z.literal('button'), label: cleanName(40) }).strict(),
]);
export type Trigger = z.output<typeof triggerSchema>;

const valuesRecord = z.record(idSchema, actionValue).refine((o) => Object.keys(o).length <= MAX_PROPERTIES, 'trop de cellules')
  .refine((o) => JSON.stringify(o).length <= 20_000, 'valeurs trop volumineuses');
const setAction = z.object({ type: z.literal('set_property'), propertyId: idSchema, value: actionValue }).strict();
// Base cible : celle de l'automatisation par défaut, ou une autre base que l'auteur peut modifier.
const addRowAction = z.object({ type: z.literal('add_row'), baseId: idSchema.optional(), values: valuesRecord.default({}) }).strict();
// Destinataires : des personnes nommées et/ou celles d'une colonne Personne de la ligne déclencheuse.
const notifyAction = z.object({ type: z.literal('notify'), userIds: z.array(idSchema).max(MAX_RECIPIENTS).default([]), propertyId: idSchema.optional() }).strict();
// `url` obligatoire à la création ; absente à la modification, l'adresse enregistrée est gardée.
const webhookInput = z.object({ type: z.literal('webhook'), url: z.string().max(500).optional() }).strict();
export const actionsInput = z.array(z.discriminatedUnion('type', [setAction, addRowAction, notifyAction, webhookInput])).min(1).max(MAX_ACTIONS);
export type ActionInput = z.output<typeof actionsInput>[number];

const webhookStored = z.object({ type: z.literal('webhook'), origin: z.string().max(500) }).strict();
const addRowStored = addRowAction.extend({ baseId: idSchema });
const storedActions = z.array(z.discriminatedUnion('type', [setAction, addRowStored, notifyAction, webhookStored])).min(1).max(MAX_ACTIONS);
type Action = z.output<typeof storedActions>[number];

// ---------- Données ----------

export interface AutomationRow {
  id: string; base_id: string; name: string; kind: TriggerKind; trigger: string; actions: string; enabled: number; status: Status;
  status_reason: Reason | null; author_id: string | null; webhook_url: string | null; webhook_secret: string | null; failures: number;
  minute_start: number; minute_runs: number; hour_start: number; hour_runs: number; next_run_at: number | null; last_run_at: number | null;
  position: number; created_at: number; updated_at: number;
}

export const automationsOf = (db: DB, baseId: string) =>
  db.prepare('SELECT * FROM base_automations WHERE base_id = ? ORDER BY position, created_at').all(baseId) as AutomationRow[];

export function automationById(db: DB, baseId: string, id: string): AutomationRow {
  const r = db.prepare('SELECT * FROM base_automations WHERE id = ? AND base_id = ?').get(id, baseId) as AutomationRow | undefined;
  if (!r) throw new HttpError(404, 'Automatisation introuvable');
  return r;
}

/** Boutons de ligne utilisables d'une base (pour l'affichage) : identifiant et libellé seulement. */
export function buttonsOf(db: DB, baseId: string): { id: string; label: string }[] {
  return (db.prepare("SELECT id, trigger FROM base_automations WHERE base_id = ? AND kind = 'button' AND enabled = 1 AND status = 'active' ORDER BY position, created_at").all(baseId) as { id: string; trigger: string }[])
    .flatMap((r) => { const t = parseTrigger(r.trigger); return t?.type === 'button' ? [{ id: r.id, label: t.label }] : []; });
}

const parseTrigger = (raw: string): Trigger | null => { try { const r = triggerSchema.safeParse(JSON.parse(raw)); return r.success ? r.data : null; } catch { return null; } };
/** Origine de l'adresse du webhook enregistrée (en clair dans les actions ; l'adresse complète reste chiffrée). */
const storedOrigin = (row: AutomationRow): string => {
  const hook = parseActions(row.actions)?.find((x) => x.type === 'webhook');
  return hook?.type === 'webhook' ? hook.origin : '';
};
const parseActions = (raw: string): Action[] | null => { try { const r = storedActions.safeParse(JSON.parse(raw)); return r.success ? r.data : null; } catch { return null; } };

export const webhooksEnabled = (db: DB): boolean => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  try { return !!row && (JSON.parse(row.value) as { enabled?: boolean }).enabled === true; } catch { return false; }
};
export function setWebhooksEnabled(db: DB, enabled: boolean, userId: string) {
  db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(SETTING_KEY, JSON.stringify({ enabled }), Date.now(), userId);
}

/** Droits d'une personne comme si elle ouvrait une session (lecture et écriture, toujours plafonnées par son rôle). */
export function authOf(db: DB, userId: string | null): Auth | null {
  if (!userId) return null;
  const u = db.prepare('SELECT id, name, email, role, disabled FROM users WHERE id = ?').get(userId) as { id: string; name: string; email: string | null; role: Auth['user']['role']; disabled: number } | undefined;
  if (!u || u.disabled) return null;
  return { user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set<Scope>(['read', 'write']) };
}

const ctxFor = (db: DB, auth: Auth | null, baseId: string): Ctx => ({ db, auth, spaces: new Set(spaceRoles(db, can(auth, 'read') ? auth : null).keys()), baseId, touched: new Set() });

// ---------- Validation ----------

/** Types de colonnes qu'une action peut écrire (ceux d'un modèle de ligne : ni calcul, ni relation, ni colonne dérivée). */
const WRITABLE = TEMPLATE_TYPES;

interface Validated { trigger: Trigger; actions: Action[]; webhook: { url: string | null } | null }

/**
 * Vérifie une configuration avec les droits de `ctx` (l'auteur, ou la personne qui clique) : colonnes, options, personnes, pages,
 * base cible modifiable, webhook permis. Lève HttpError : 403 = droits insuffisants, 400 ou 404 = configuration invalide.
 * `keepWebhook` : origine de l'adresse déjà enregistrée (gardée si l'action webhook ne donne pas de nouvelle adresse), sinon null.
 */
export function validate(db: DB, ctx: Ctx, trigger: Trigger, actions: (ActionInput | Action)[], opts: { keepWebhook: string | null; webhooks: boolean }): Validated {
  const baseId = ctx.baseId;
  if (baseLevel(ctx, baseId) !== 'write') throw new HttpError(403, 'Il faut pouvoir modifier la base');
  const props = propertiesOf(db, baseId);
  const prop = (id: string) => props.find((p) => p.id === id);
  const bad = (m: string): never => { throw new HttpError(400, m); };
  const checkFilters = (list: Filter[]) => { for (const f of list) if (!prop(f.propertyId)) bad('Filtre : colonne inconnue'); };
  if (trigger.type === 'row_added' || trigger.type === 'recurrence') checkFilters(trigger.filters);
  if (trigger.type === 'property_changed') {
    const p = prop(trigger.propertyId);
    if (!p || (!WRITABLE.has(p.type) && p.type !== 'relation')) bad('Déclencheur : colonne inconnue ou non modifiable');
    checkFilters(trigger.filters);
  }

  const out: Action[] = [];
  let webhook: Validated['webhook'] = null;
  for (const a of actions) {
    if (a.type === 'set_property') {
      const p = prop(a.propertyId);
      if (!p || !WRITABLE.has(p.type)) bad('Modifier une propriété : colonne inconnue ou non modifiable');
      checkActionValue(ctx, p!, a.value);
      out.push(a);
    } else if (a.type === 'add_row') {
      const target = a.baseId ?? baseId;
      const level = baseLevel(ctx, target);
      if (level === 'none') throw new HttpError(404, 'Ajouter une ligne : base introuvable');
      if (level !== 'write') throw new HttpError(403, 'Ajouter une ligne : il faut pouvoir modifier la base cible');
      const tctx: Ctx = { ...ctx, baseId: target };
      const tprops = target === baseId ? props : propertiesOf(db, target);
      for (const [k, v] of Object.entries(a.values)) {
        const p = tprops.find((x) => x.id === k);
        if (!p || !WRITABLE.has(p.type)) bad('Ajouter une ligne : colonne inconnue ou non modifiable');
        checkActionValue(tctx, p!, v);
      }
      out.push({ type: 'add_row', baseId: target, values: a.values });
    } else if (a.type === 'notify') {
      if (!a.userIds.length && !a.propertyId) bad('Notifier : au moins un destinataire');
      if (a.propertyId && prop(a.propertyId)?.type !== 'person') bad('Notifier : colonne Personne attendue');
      const ids = [...new Set(a.userIds)];
      // Même réponse pour une personne inexistante ou sans accès : on ne révèle pas qui existe ni qui lit la base.
      if (readersAmong(db, baseId, ids, MAX_RECIPIENTS).length !== ids.length) bad('Notifier : personne introuvable ou sans accès à cette base');
      out.push({ type: 'notify', userIds: ids, ...(a.propertyId ? { propertyId: a.propertyId } : {}) });
    } else {
      if (webhook) bad('Un seul webhook par automatisation');
      if (inPersonalSpace(db, baseId)) throw new HttpError(403, 'Rien d’un espace personnel ne sort vers un service externe');
      if (!opts.webhooks) throw new HttpError(403, 'Les webhooks d’automatisation sont désactivés par l’administrateur');
      const url = 'url' in a && a.url !== undefined ? a.url : null;
      if (url === null && !opts.keepWebhook) bad('Webhook : adresse attendue');
      let origin = 'origin' in a ? a.origin : opts.keepWebhook ?? '';
      if (url !== null) {
        let u: URL;
        try { u = new URL(url); } catch { return bad('Webhook : adresse invalide'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') bad('Webhook : adresse https attendue');
        if (u.username || u.password) bad('Webhook : identifiants dans l’adresse interdits');
        origin = u.origin;
      }
      webhook = { url };
      out.push({ type: 'webhook', origin });
    }
  }
  return { trigger, actions: out, webhook };
}

/** Valeur d'action : dynamique (date du jour, personne qui déclenche) ou fixe, validée comme une écriture de `ctx`. */
function checkActionValue(ctx: Ctx, p: Property, v: ActionValue) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'dynamic' in v) {
    if (v.dynamic === 'today' && p.type !== 'date' && p.type !== 'date_range') throw new HttpError(400, `Colonne « ${p.name} » : la date du jour demande une colonne Date ou Plage de dates`);
    if (v.dynamic === 'actor' && p.type !== 'person') throw new HttpError(400, `Colonne « ${p.name} » : la personne qui déclenche demande une colonne Personne`);
    return;
  }
  checkValue(ctx, p, v);
}

const today = () => new Date().toISOString().slice(0, 10);
/**
 * Valeur à écrire dans la base `baseId`. La personne qui déclenche n'est écrite que si elle peut lire cette base (une autre base
 * que celle de l'automatisation, par exemple) ; sinon la cellule reste vide, sans faire échouer l'exécution.
 */
function resolveValue(db: DB, baseId: string, p: Property, v: ActionValue, actorId: string | null): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'dynamic' in v) {
    if (v.dynamic === 'today') return p.type === 'date_range' ? { start: today(), end: null } : today();
    return actorId && readersAmong(db, baseId, [actorId], 1).length ? actorId : null;
  }
  return v;
}

// ---------- Récurrence ----------

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function partsIn(tz: string, ms: number) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formatters.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { day: Number(o.day), hour: Number(o.hour), minute: Number(o.minute), weekday: WEEKDAYS.indexOf(o.weekday ?? '') };
}

const QUARTER = 15 * 60_000;
/**
 * Prochaine échéance strictement après `from`, dans le fuseau de la récurrence (heures d'été comprises) : recherche par quart
 * d'heure, bornée à 32 jours. Les échéances manquées (serveur arrêté) ne sont jamais rattrapées.
 */
export function nextOccurrence(t: Extract<Trigger, { type: 'recurrence' }>, from: number): number {
  const start = Math.floor(from / QUARTER) * QUARTER + QUARTER;
  for (let i = 0; i < 32 * 24 * 4; i++) {
    const at = start + i * QUARTER;
    const p = partsIn(t.timeZone, at);
    if (p.minute !== 0) continue;
    if (t.every === 'hour') return at;
    if (p.hour !== t.hour) continue;
    if (t.every === 'day' || (t.every === 'week' && p.weekday === t.weekday) || (t.every === 'month' && p.day === t.day)) return at;
  }
  return from + 86_400_000;
}

// ---------- Enregistrement ----------

export interface SaveInput { name?: string; enabled?: boolean; trigger?: Trigger; actions?: ActionInput[] }

/** Ce qui change le pouvoir de l'automatisation : déclencheur, actions, réactivation. Le reste (nom, désactivation) ne re-signe pas. */
export const resigns = (b: SaveInput) => b.trigger !== undefined || b.actions !== undefined || b.enabled === true;

/**
 * Crée (`current` absent) ou modifie une automatisation. La configuration complète est revalidée avec les droits de `auth`, qui
 * devient l'auteur, dès que `resigns(input)`. Rend l'automatisation et, si un webhook vient d'être ajouté, son secret (montré une fois).
 */
export function saveAutomation(db: DB, box: SecretBox, auth: Auth, baseId: string, input: SaveInput, current?: AutomationRow): { row: AutomationRow; secret: string | null } {
  return db.transaction(() => {
    const now = Date.now();
    if (!current) {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM base_automations WHERE base_id = ?').get(baseId) as { n: number }).n;
      if (n >= MAX_AUTOMATIONS) throw new HttpError(409, `Au plus ${MAX_AUTOMATIONS} automatisations par base`);
      if (!input.trigger || !input.actions || input.name === undefined) throw new HttpError(400, 'Nom, déclencheur et actions attendus');
    }
    if (current && !resigns(input)) {
      db.prepare('UPDATE base_automations SET name = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(input.name ?? current.name, input.enabled === false ? 0 : current.enabled, now, current.id);
      return { row: automationById(db, baseId, current.id), secret: null };
    }
    const trigger = input.trigger ?? parseTrigger(current!.trigger);
    const actions = input.actions ?? parseActions(current!.actions);
    if (!trigger || !actions) throw new HttpError(400, 'Configuration illisible : redéfinissez le déclencheur et les actions');
    if (trigger.type === 'recurrence') {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM base_automations WHERE author_id = ? AND kind = 'recurrence' AND id != ?").get(auth.user.id, current?.id ?? '') as { n: number }).n;
      if (n >= MAX_RECURRENCES_PER_AUTHOR) throw new HttpError(409, `Au plus ${MAX_RECURRENCES_PER_AUTHOR} automatisations récurrentes par personne`);
    }
    // Changement d'auteur : l'adresse du webhook doit être ressaisie et un nouveau secret est créé (le nouvel auteur ne reprend
    // pas en aveugle la destination choisie par un autre, et l'ancien secret cesse de signer).
    const sameAuthor = !!current && current.author_id === auth.user.id;
    const ctx = ctxFor(db, auth, baseId);
    const v = validate(db, ctx, trigger, actions, { keepWebhook: sameAuthor && current?.webhook_url ? storedOrigin(current) : null, webhooks: webhooksEnabled(db) });
    const id = current?.id ?? newId();
    let url = sameAuthor ? current!.webhook_url : null;
    let secretSealed = sameAuthor ? current!.webhook_secret : null;
    let secret: string | null = null;
    if (!v.webhook) { url = null; secretSealed = null; }
    else {
      if (v.webhook.url !== null) url = box.seal(v.webhook.url, `automation-url:${id}`);
      if (!secretSealed) { secret = `whsec_${randomToken(24)}`; secretSealed = box.seal(secret, `automation:${id}`); }
    }
    const next = v.trigger.type === 'recurrence' ? nextOccurrence(v.trigger, now) : null;
    if (!current) {
      const pos = (db.prepare('SELECT MAX(position) AS m FROM base_automations WHERE base_id = ?').get(baseId) as { m: number | null }).m;
      db.prepare(`INSERT INTO base_automations (id, base_id, name, kind, trigger, actions, enabled, author_id, webhook_url, webhook_secret, next_run_at, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, baseId, input.name, v.trigger.type, JSON.stringify(v.trigger), JSON.stringify(v.actions), input.enabled === false ? 0 : 1, auth.user.id, url, secretSealed, next, pos === null ? 0 : pos + 1, now, now);
    } else {
      // Revalidée : l'état repart à « active » et les compteurs d'erreurs à zéro.
      db.prepare(`UPDATE base_automations SET name = ?, kind = ?, trigger = ?, actions = ?, enabled = ?, status = 'active', status_reason = NULL, author_id = ?,
        webhook_url = ?, webhook_secret = ?, failures = 0, next_run_at = ?, updated_at = ? WHERE id = ?`)
        .run(input.name ?? current.name, v.trigger.type, JSON.stringify(v.trigger), JSON.stringify(v.actions), input.enabled === false ? 0 : input.enabled === true ? 1 : current.enabled,
          auth.user.id, url, secretSealed, next, now, id);
    }
    return { row: automationById(db, baseId, id), secret };
  })();
}

/** Nouveau secret de webhook (l'ancien cesse aussitôt de signer). */
export function rotateSecret(db: DB, box: SecretBox, row: AutomationRow): string {
  if (!row.webhook_url) throw new HttpError(409, 'Cette automatisation n’a pas de webhook');
  const secret = `whsec_${randomToken(24)}`;
  db.prepare('UPDATE base_automations SET webhook_secret = ?, updated_at = ? WHERE id = ?').run(box.seal(secret, `automation:${row.id}`), Date.now(), row.id);
  return secret;
}

/**
 * Colonne supprimée : toute automatisation qui la cite (déclencheur, filtres, actions, y compris depuis une autre base) est mise
 * en panne. Les identifiants de colonnes sont aléatoires : une recherche de la chaîne suffit, la configuration est ensuite revalidée.
 */
export function breakUsing(db: DB, propertyId: string): string[] {
  const rows = db.prepare("SELECT id, base_id FROM base_automations WHERE status != 'broken' AND (instr(trigger, ?) > 0 OR instr(actions, ?) > 0)")
    .all(`"${propertyId}"`, `"${propertyId}"`) as { id: string; base_id: string }[];
  const upd = db.prepare("UPDATE base_automations SET status = 'broken', status_reason = 'config', updated_at = ? WHERE id = ?");
  for (const r of rows) upd.run(Date.now(), r.id);
  return rows.map((r) => r.base_id);
}

// ---------- Présentation ----------

export interface PresentedAutomation {
  id: string; name: string; enabled: boolean; status: Status; statusReason: Reason | null; trigger: Trigger | null; actions: unknown[];
  author: { id: string; name: string } | null; masked: boolean; failures: number; nextRunAt: number | null; lastRunAt: number | null;
  createdAt: number; updatedAt: number;
}

/**
 * Automatisation telle que la voit `viewer` (qui peut modifier la base) : une action vers une base qu'il ne lit pas est masquée
 * (`masked`), les personnes ne sont citées que si elles lisent la base visée, les pages que s'il les lit, le webhook par son origine.
 */
export function presentAutomation(db: DB, viewer: Auth | null, row: AutomationRow): PresentedAutomation {
  const ctx = ctxFor(db, viewer, row.base_id);
  let masked = false;
  const propsCache = new Map<string, Property[]>();
  const propsOf = (b: string) => { if (!propsCache.has(b)) propsCache.set(b, propertiesOf(db, b)); return propsCache.get(b)!; };
  const maskValue = (baseId: string, propId: string, v: unknown): { keep: boolean } => {
    const p = propsOf(baseId).find((x) => x.id === propId);
    if (typeof v !== 'string' || !p) return { keep: true };
    if (p.type === 'person') return { keep: readersAmong(db, baseId, [v], 1).length === 1 };
    if (p.type === 'page_link') return { keep: canReadPage(db, viewer, v) };
    return { keep: true };
  };
  const actions = (parseActions(row.actions) ?? []).map((a): unknown => {
    if (a.type === 'add_row') {
      if (baseLevel(ctx, a.baseId) === 'none') { masked = true; return { type: 'add_row', baseId: null, values: {} }; }
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.values)) { if (maskValue(a.baseId, k, v).keep) values[k] = v; else masked = true; }
      return { ...a, values };
    }
    if (a.type === 'set_property') {
      if (maskValue(row.base_id, a.propertyId, a.value).keep) return a;
      masked = true;
      return { ...a, value: null };
    }
    if (a.type === 'notify') {
      const kept = readersAmong(db, row.base_id, a.userIds, MAX_RECIPIENTS);
      if (kept.length !== a.userIds.length) masked = true;
      return { ...a, userIds: kept.map((u) => u.id), users: kept };
    }
    return a;
  });
  const author = row.author_id ? readersAmong(db, row.base_id, [row.author_id], 1)[0] ?? null : null;
  return {
    id: row.id, name: row.name, enabled: !!row.enabled, status: row.status, statusReason: row.status_reason, trigger: parseTrigger(row.trigger), actions,
    author, masked, failures: row.failures, nextRunAt: row.kind === 'recurrence' ? row.next_run_at : null, lastRunAt: row.last_run_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function runsOf(db: DB, row: AutomationRow) {
  const runs = db.prepare('SELECT at, kind, status, code, rows, actor_id FROM base_automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?').all(row.id, RUN_HISTORY) as { at: number; kind: string; status: string; code: string; rows: number; actor_id: string | null }[];
  const names = new Map(readersAmong(db, row.base_id, runs.flatMap((r) => (r.actor_id ? [r.actor_id] : [])), RUN_HISTORY).map((u) => [u.id, u.name]));
  return runs.map((r) => ({ at: r.at, trigger: r.kind, status: r.status, code: r.code, rows: r.rows, actor: r.actor_id && names.has(r.actor_id) ? { id: r.actor_id, name: names.get(r.actor_id)! } : null }));
}

// ---------- Moteur ----------

export interface EngineDeps { db: DB; bus: EventBus; box: SecretBox; notifier: Notifier; allowPrivate: boolean; log?: (err: unknown) => void }
export interface RunResult { status: 'ok' | 'error' | 'skipped'; code: RunCode; rows: string[] }

class RunError extends Error { constructor(readonly code: RunCode, readonly reason: Reason | null) { super(code); } }

export class AutomationEngine {
  #depth = 0;
  #pending = new Set<Promise<unknown>>();
  /** Bases écrites pendant un appel (rowWritten, runDue, bouton) : réindexées et signalées une seule fois, à la fin. */
  #batch: Map<string, { spaceId: string; by: { id: string; name: string } }> | null = null;
  /** Budget de lecture (formules, cumuls) partagé par toutes les exécutions d'un même appel. */
  #budget: Budget | null = null;

  #batched<T>(fn: () => T): T {
    if (this.#batch) return fn();
    this.#batch = new Map();
    this.#budget = readBudget();
    try { return fn(); } finally {
      const batch = this.#batch;
      this.#batch = null;
      this.#budget = null;
      for (const [id, x] of batch) {
        try {
          reindexBase(this.d.db, id);
          touchBase(this.d.db, id, x.by.id);
          this.d.bus.publish({ type: 'base.changed', spaceId: x.spaceId, pageId: id, by: x.by });
        } catch (err) { this.d.log?.(err); }
      }
    }
  }
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: EngineDeps) {}

  /** Attend la fin des webhooks en cours (tests, arrêt). */
  async idle() { while (this.#pending.size) await Promise.allSettled([...this.#pending]); }

  start() {
    this.#timer = setInterval(() => { try { this.runDue(); } catch (err) { this.d.log?.(err); } }, TICK_MS).unref();
    return () => { if (this.#timer) clearInterval(this.#timer); this.#timer = null; };
  }

  /**
   * Écriture d'une ligne par une personne (seul point d'entrée des déclencheurs « ligne ajoutée » et « propriété modifiée »).
   * `changed` : colonnes dont la valeur a changé, `null` pour un ajout. Jamais appelé pour une écriture d'automatisation, et
   * sans effet pendant une exécution. Ne lève jamais : une automatisation ne fait pas échouer l'écriture qui l'a déclenchée.
   * Rend les identifiants des bases modifiées par les automatisations.
   * `anonymous` : ligne écrite par une réponse anonyme à un formulaire (lib/base-forms.ts) ; l'automatisation agit toujours avec
   * les droits de son auteur, et la valeur « personne qui déclenche » reste vide (jamais l'auteur à la place de l'anonyme).
   * `fromForm` : ligne écrite par une réponse à un formulaire. Celui qui répond ne doit pas pouvoir mettre l'automatisation en
   * pause : au-delà des plafonds de fréquence, l'exécution est seulement sautée, et ses échecs (écriture, webhook) ne comptent
   * pas pour la mise en pause.
   */
  rowWritten(baseId: string, rowId: string, changed: Set<string> | null, actorId: string | null, opts: { anonymous?: boolean; fromForm?: boolean } = {}): Set<string> {
    const touched = new Set<string>();
    if (this.#depth > 0) return touched;
    return this.#batched(() => { try {
      const kinds = changed === null ? ['row_added'] : ['property_changed'];
      const rows = (this.d.db.prepare(`SELECT * FROM base_automations WHERE base_id = ? AND enabled = 1 AND status = 'active' AND kind IN (SELECT value FROM json_each(?)) ORDER BY position, created_at`)
        .all(baseId, JSON.stringify(kinds)) as AutomationRow[]);
      for (const a of rows) {
        const t = parseTrigger(a.trigger);
        if (t?.type === 'property_changed' && !changed?.has(t.propertyId)) continue;
        const r = this.#run(a, { kind: 'row', rowId, actorId, runAs: null, anonymous: opts.anonymous === true, fromForm: opts.fromForm === true });
        for (const b of r.touched) touched.add(b);
      }
    } catch (err) { this.d.log?.(err); }
    return touched; });
  }

  /** Bouton de ligne : avec les droits de `auth` (la route a vérifié qu'il peut modifier la base). */
  runButton(row: AutomationRow, rowId: string, auth: Auth): RunResult & { touched: Set<string> } {
    if (row.kind !== 'button') throw new HttpError(400, 'Cette automatisation n’est pas un bouton');
    if (!row.enabled || row.status !== 'active') throw new HttpError(409, 'Ce bouton est désactivé');
    if (!this.d.db.prepare('SELECT 1 FROM base_rows WHERE id = ? AND base_id = ?').get(rowId, row.base_id)) throw new HttpError(404, 'Ligne introuvable');
    return this.#batched(() => this.#run(row, { kind: 'row', rowId, actorId: auth.user.id, runAs: auth }));
  }

  /**
   * Récurrences échues : au plus MAX_DUE_PER_TICK par passage, dont MAX_DUE_PER_AUTHOR_PER_TICK par auteur (une personne ne
   * monopolise pas le planificateur ; le reste passe aux tours suivants). La prochaine échéance est posée AVANT l'exécution :
   * une erreur ne boucle pas.
   */
  runDue(now = Date.now()): number {
    if (this.#depth > 0) return 0;
    const due = this.d.db.prepare(`SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(author_id, '') ORDER BY next_run_at, id) AS rank_in_author FROM base_automations
        WHERE kind = 'recurrence' AND enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?)
      WHERE rank_in_author <= ? ORDER BY next_run_at, id LIMIT ?`).all(now, MAX_DUE_PER_AUTHOR_PER_TICK, MAX_DUE_PER_TICK) as AutomationRow[];
    return this.#batched(() => this.#runDueList(due, now));
  }

  #runDueList(due: AutomationRow[], now: number): number {
    for (const a of due) {
      const t = parseTrigger(a.trigger);
      this.d.db.prepare('UPDATE base_automations SET next_run_at = ? WHERE id = ?').run(t?.type === 'recurrence' ? nextOccurrence(t, now) : null, a.id);
      try { this.#run(a, { kind: 'recurrence', rowId: null, actorId: null, runAs: null }, now); } catch (err) { this.d.log?.(err); }
    }
    return due.length;
  }

  #run(a: AutomationRow, how: { kind: 'row' | 'recurrence'; rowId: string | null; actorId: string | null; runAs: Auth | null; anonymous?: boolean; fromForm?: boolean }, now = Date.now()): RunResult & { touched: Set<string> } {
    const { db } = this.d;
    const touched = new Set<string>();
    const done = (status: RunResult['status'], code: RunCode, rows: string[] = []) => {
      this.#record(a, status, code, rows.length, how.actorId, now);
      return { status, code, rows, touched };
    };
    this.#depth++;
    try {
      const base = db.prepare('SELECT id, space_id, deleted_at, kind FROM pages WHERE id = ?').get(a.base_id) as { id: string; space_id: string; deleted_at: number | null; kind: string } | undefined;
      if (!base || base.kind !== 'base') return done('skipped', 'config');
      if (base.deleted_at) return done('skipped', 'trashed');
      // Bouton : droits de la personne qui clique ; sinon : droits de l'auteur, relus maintenant.
      const runAs = how.runAs ?? authOf(db, a.author_id);
      if (!runAs) { this.#setStatus(a, 'suspended', 'author'); return done('skipped', 'author'); }
      const trigger = parseTrigger(a.trigger);
      const actions = parseActions(a.actions);
      if (!trigger || !actions) { this.#setStatus(a, 'broken', 'config'); return done('skipped', 'config'); }
      const ctx = ctxFor(db, runAs, a.base_id);
      const webhooks = webhooksEnabled(db);
      try {
        // Validation complète avec les droits de maintenant ; un webhook coupé par l'administrateur est sauté, pas en erreur.
        validate(db, ctx, trigger, actions.filter((x) => webhooks || x.type !== 'webhook'), { keepWebhook: a.webhook_url ? storedOrigin(a) : null, webhooks });
      } catch (err) {
        const status = err instanceof HttpError ? err.statusCode : 500;
        if (how.runAs) {
          // Bouton : la configuration est-elle valide pour son auteur ? Si oui, c'est la personne qui clique qui n'a pas les droits
          // voulus (base cible illisible, page…) : refus, sans rien changer au bouton. Sinon, une erreur de configuration (400)
          // le met en panne ; un refus d'accès reste un refus.
          const author = authOf(db, a.author_id);
          let validForAuthor = false;
          if (author) {
            try { validate(db, ctxFor(db, author, a.base_id), trigger, actions.filter((x) => webhooks || x.type !== 'webhook'), { keepWebhook: a.webhook_url ? storedOrigin(a) : null, webhooks }); validForAuthor = true; } catch { /* invalide aussi pour l'auteur */ }
          }
          // Auteur absent ou désactivé : on ne peut pas trancher, le bouton n'est jamais mis en panne pour autant.
          if (!author || validForAuthor || status !== 400) throw new HttpError(403, 'Ce bouton demande des droits que vous n’avez pas');
          this.#setStatus(a, 'broken', 'config');
          throw new HttpError(409, 'Ce bouton n’est plus valide (colonne, option ou base disparue) : il a été mis en panne');
        }
        if (status === 403) {
          this.#setStatus(a, 'suspended', 'access');
          return done('skipped', 'access');
        }
        this.#setStatus(a, 'broken', 'config');
        return done('skipped', 'config');
      }
      // Lignes concernées, évaluées telles que les voit `runAs` (filtres de vue, même sémantique que le client).
      const props = propertiesOf(db, a.base_id);
      const flt = 'filters' in trigger ? trigger.filters : [];
      const resolved = flt.map((f) => ({ ...f, value: f.value !== null && typeof f.value === 'object' ? today() : f.value }));
      let rows: string[];
      let truncated = false;
      const adds = actions.filter((x) => x.type === 'add_row').length;
      if (how.kind === 'row') {
        const presented = presentRows(ctx, props, true, how.rowId!, this.#budget ?? readBudget());
        if (!presented.length || !resolved.every((f) => matchesFilter(props, presented[0]!, f))) {
          // Filtres non satisfaits : rien n'est compté ni enregistré (sauf pour un bouton, qui est explicite).
          if (how.runAs) return done('skipped', 'ok');
          return { status: 'skipped', code: 'ok', rows: [], touched };
        }
        rows = [how.rowId!];
      } else {
        const room = Math.max(0, MAX_ROWS_TOUCHED - adds);
        const matched = presentRows(ctx, props, true, undefined, this.#budget ?? readBudget()).filter((r) => resolved.every((f) => matchesFilter(props, r, f))).map((r) => r.id);
        truncated = matched.length > room;
        rows = matched.slice(0, room);
      }
      // Coupe-circuits de fréquence (avant toute écriture).
      const freq = this.#frequency(a, now, how.fromForm === true);
      if (freq) return done('skipped', freq);
      const written = new Set<string>();
      let elsewhere = 0;
      const recipients = new Set<string>();
      // Personne qui déclenche : la personne qui a écrit, sinon l'auteur (récurrence) ; personne pour une réponse anonyme.
      const who = how.anonymous ? null : how.actorId ?? runAs.user.id;
      try {
        db.transaction(() => {
          let count = 0;
          const bump = (n = 1) => { count += n; if (count > MAX_ROWS_TOUCHED) throw new RunError('limit_rows', null); };
          for (const act of actions) {
            if (act.type === 'set_property') {
              const p = props.find((x) => x.id === act.propertyId)!;
              const value = resolveValue(db, a.base_id, p, act.value, who);
              for (const r of rows) { bump(); patchRow(ctx, r, { [p.id]: value }, runAs.user.id); written.add(r); }
            } else if (act.type === 'add_row') {
              bump();
              const tctx: Ctx = { ...ctx, baseId: act.baseId, touched: ctx.touched };
              const tprops = act.baseId === a.base_id ? props : propertiesOf(db, act.baseId);
              const vals: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(act.values)) vals[k] = resolveValue(db, act.baseId, tprops.find((x) => x.id === k)!, v, who);
              const created = addRow(tctx, vals, runAs.user.id);
              if (act.baseId === a.base_id) written.add(created.id); else { touched.add(act.baseId); elsewhere++; }
            } else if (act.type === 'notify') {
              for (const u of act.userIds) recipients.add(u);
              if (act.propertyId) {
                const stmt = db.prepare('SELECT vals FROM base_rows WHERE id = ? AND base_id = ?');
                for (const r of rows) {
                  const vals = JSON.parse((stmt.get(r, a.base_id) as { vals: string } | undefined)?.vals ?? '{}') as Record<string, unknown>;
                  const who = vals[act.propertyId];
                  if (typeof who === 'string') recipients.add(who);
                }
              }
            }
          }
        })();
      } catch (err) {
        if (how.runAs && err instanceof HttpError && err.statusCode === 403) throw err;
        const code: RunCode = err instanceof RunError ? err.code : 'write_failed';
        if (how.runAs) {
          // Bouton : l'échec est rendu à la personne qui clique ; il ne compte pas pour la mise en pause (une personne ne doit pas
          // pouvoir mettre en pause, par des clics voués à l'échec, un bouton dont les autres se servent).
          this.#record(a, 'error', code, 0, how.actorId, now);
          throw err instanceof HttpError ? err : new HttpError(409, code === 'limit_rows' ? `Au plus ${MAX_ROWS_TOUCHED} lignes touchées par exécution` : 'L’automatisation a échoué');
        }
        if (!how.fromForm) this.#fail(a);
        return done('error', code);
      }
      for (const b of ctx.touched ?? []) touched.add(b);
      if (written.size || touched.size) this.#afterWrite(a.base_id, base.space_id, written.size > 0, touched, runAs);
      // Notifications : chaque destinataire doit lire la base au moment de l'envoi (deliver le revérifie) ; au plus MAX_RECIPIENTS.
      for (const u of [...recipients].slice(0, MAX_RECIPIENTS)) this.d.notifier.deliver(u, 'automation', a.base_id, how.actorId, { allowSelf: true });
      const hook = actions.find((x) => x.type === 'webhook');
      let code: RunCode = truncated ? 'truncated' : 'ok';
      if (hook && !webhooks) code = 'webhook_disabled';
      const runId = this.#record(a, 'ok', code, written.size + elsewhere, how.actorId, now);
      if (hook && webhooks && a.webhook_url && a.webhook_secret) this.#sendWebhook(a, base.space_id, trigger.type, rows, runId, !how.fromForm);
      else this.#succeed(a);
      return { status: 'ok', code, rows: [...written], touched };
    } finally {
      this.#depth--;
    }
  }

  /**
   * Fenêtres d'une minute et d'une heure : au-delà, pause (coupe-circuit) ; base trop sollicitée : exécution sautée. `soft` :
   * exécution déclenchée par un formulaire, sautée sans pause.
   */
  #frequency(a: AutomationRow, now: number, soft = false): RunCode | null {
    const { db } = this.d;
    const baseRuns = (db.prepare("SELECT COUNT(*) AS n FROM base_automation_runs WHERE base_id = ? AND at > ? AND status != 'skipped'").get(a.base_id, now - 60_000) as { n: number }).n;
    if (baseRuns >= MAX_BASE_RUNS_PER_MINUTE) return 'limit_base';
    const cur = db.prepare('SELECT minute_start, minute_runs, hour_start, hour_runs FROM base_automations WHERE id = ?').get(a.id) as Pick<AutomationRow, 'minute_start' | 'minute_runs' | 'hour_start' | 'hour_runs'>;
    const minute = now - cur.minute_start < 60_000 ? { start: cur.minute_start, runs: cur.minute_runs } : { start: now, runs: 0 };
    const hour = now - cur.hour_start < 3_600_000 ? { start: cur.hour_start, runs: cur.hour_runs } : { start: now, runs: 0 };
    if (minute.runs >= MAX_RUNS_PER_MINUTE || hour.runs >= MAX_RUNS_PER_HOUR) {
      if (!soft) this.#setStatus(a, 'paused', 'frequency');
      return 'frequency';
    }
    db.prepare('UPDATE base_automations SET minute_start = ?, minute_runs = ?, hour_start = ?, hour_runs = ? WHERE id = ?').run(minute.start, minute.runs + 1, hour.start, hour.runs + 1, a.id);
    return null;
  }

  #record(a: AutomationRow, status: RunResult['status'], code: RunCode, rows: number, actorId: string | null, now: number): number {
    const { db } = this.d;
    if (!db.prepare('SELECT 1 FROM base_automations WHERE id = ?').get(a.id)) return 0;
    const id = Number(db.prepare('INSERT INTO base_automation_runs (automation_id, base_id, at, kind, status, code, rows, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.base_id, now, a.kind, status, code, rows, actorId).lastInsertRowid);
    db.prepare('UPDATE base_automations SET last_run_at = ? WHERE id = ?').run(now, a.id);
    db.prepare('DELETE FROM base_automation_runs WHERE automation_id = ? AND id <= ?').run(a.id, id - RUN_HISTORY);
    return id;
  }

  #fail(a: AutomationRow) {
    const { db } = this.d;
    const r = db.prepare('UPDATE base_automations SET failures = failures + 1 WHERE id = ? RETURNING failures').get(a.id) as { failures: number } | undefined;
    if (r && r.failures >= MAX_FAILURES) this.#setStatus(a, 'paused', 'errors');
  }

  #succeed(a: AutomationRow) { this.d.db.prepare('UPDATE base_automations SET failures = 0 WHERE id = ?').run(a.id); }

  #setStatus(a: AutomationRow, status: Status, reason: Reason) {
    const { db } = this.d;
    const r = db.prepare("UPDATE base_automations SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(status, reason, Date.now(), a.id);
    if (!r.changes) return;
    // Journal d'audit, sans auteur (décision du serveur) ; aucun détail dans un espace personnel.
    audit(db, null, `base.automation.${status}`, a.base_id, inPersonalSpace(db, a.base_id) ? undefined : { automationId: a.id, reason });
  }

  /** Bases écrites : ajoutées au lot de l'appel en cours (réindexation et événement uniques, voir #batched). */
  #afterWrite(baseId: string, spaceId: string, own: boolean, others: Set<string>, runAs: Auth) {
    if (!this.#batch) { this.#batched(() => this.#afterWrite(baseId, spaceId, own, others, runAs)); return; }
    const by = { id: runAs.user.id, name: runAs.user.name };
    const batch = this.#batch;
    if (own) batch.set(baseId, { spaceId, by });
    for (const id of others) {
      if (id === baseId) continue;
      const other = this.d.db.prepare('SELECT space_id FROM pages WHERE id = ?').get(id) as { space_id: string } | undefined;
      if (other) batch.set(id, { spaceId: other.space_id, by });
    }
  }

  /** Webhook : identifiants seulement. Le résultat met à jour l'exécution et le compteur d'erreurs (coupe-circuit). */
  #sendWebhook(a: AutomationRow, spaceId: string, kind: string, rows: string[], runId: number, countFailure = true) {
    const { db, box, allowPrivate } = this.d;
    let url: string;
    let secret: string;
    try {
      url = box.open(a.webhook_url!, `automation-url:${a.id}`);
      secret = box.open(a.webhook_secret!, `automation:${a.id}`);
    } catch {
      this.#setStatus(a, 'broken', 'config');
      return;
    }
    const body = JSON.stringify({ event: 'base.automation', at: new Date().toISOString(), data: { automationId: a.id, baseId: a.base_id, spaceId, trigger: kind, rowIds: rows.slice(0, MAX_ROWS_TOUCHED) } });
    const p = postSigned(url, secret, 'base.automation', body, allowPrivate).then((status) => {
      const ok = status >= 200 && status < 300;
      if (ok) { this.#succeed(a); return; }
      db.prepare("UPDATE base_automation_runs SET status = 'error', code = 'webhook_failed' WHERE id = ?").run(runId);
      if (countFailure) this.#fail(a);
    }).catch((err) => this.d.log?.(err)).finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }
}
