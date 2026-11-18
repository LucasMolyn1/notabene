// Clients OIDC nommés : « principal » (Authentik ou tout fournisseur conforme, variables OIDC_*) et « google »
// (émetteur fixe https://accounts.google.com, variables GOOGLE_*). Authorization Code + PKCE, state et nonce à usage
// unique, tentative liée au navigateur et au fournisseur qui l'a lancée.
import * as oidc from 'openid-client';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { HttpError, newId } from '../lib/http.js';
import type { Role } from './context.js';
import { bindingMatches } from './login-binding.js';

const STATE_TTL = 10 * 60_000;

export const OIDC_PROVIDERS = ['principal', 'google'] as const;
export type OidcProviderName = (typeof OIDC_PROVIDERS)[number];
// Fournisseurs servis par les routes génériques /auth/oidc/:provider/* (le principal garde /auth/login et /auth/callback).
export const NAMED_PROVIDERS = OIDC_PROVIDERS.filter((p) => p !== 'principal') as Exclude<OidcProviderName, 'principal'>[];

export const GOOGLE_ISSUER = 'https://accounts.google.com';
// Préfixe de l'identifiant (sub) des comptes Google : un sub Google ne peut pas coïncider avec un sub du fournisseur principal.
export const GOOGLE_SUB_PREFIX = 'google:';
// Domaines grand public de Google : pas de claim `hd`, l'adresse fait foi.
const GOOGLE_CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// Réglages effectifs d'un fournisseur, null s'il n'est pas configuré.
export interface OidcProviderSettings {
  name: OidcProviderName;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  callbackPath: string;
  loginPath: string;
  // Paramètres d'autorisation supplémentaires ; `reauth` : forcer une nouvelle authentification chez le fournisseur.
  extraParams: (reauth: boolean) => Record<string, string>;
  // Profil complété par /userinfo (le principal y lit les groupes) ; jamais pour Google : seul l'id_token signé fait foi.
  useUserInfo: boolean;
  // Confirmation (reauth) : l'id_token doit porter `auth_time` daté d'au plus ce nombre de secondes. Absent : pas de contrôle.
  reauthMaxAge?: number;
}

// Fenêtre acceptée entre l'authentification chez Google et le retour, pour une confirmation (max_age=0 est demandé).
export const REAUTH_MAX_AGE_SECONDS = 120;
// Écart d'horloge toléré pour un `auth_time` daté dans le futur.
const CLOCK_TOLERANCE_SECONDS = 30;

// Confirmation refusée : `auth_time` absent ou trop ancien. Aucune session n'est ouverte.
export class ReauthRejected extends Error {
  constructor() { super('Confirmation refusée : authentification récente non prouvée par le fournisseur.'); }
}

export function providerSettings(cfg: Config, name: OidcProviderName): OidcProviderSettings | null {
  if (name === 'principal') {
    if (!(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID && cfg.OIDC_CLIENT_SECRET)) return null;
    return {
      name, label: 'SSO', issuer: cfg.OIDC_ISSUER, clientId: cfg.OIDC_CLIENT_ID, clientSecret: cfg.OIDC_CLIENT_SECRET, scopes: cfg.OIDC_SCOPES,
      callbackPath: '/auth/callback', loginPath: '/auth/login',
      extraParams: (reauth): Record<string, string> => (reauth ? { prompt: 'login' } : {}),
      useUserInfo: true,
    };
  }
  if (!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET)) return null;
  // Un seul domaine Workspace : suggéré à Google (`hd`) pour présélectionner le bon compte. Simple indication, le contrôle
  // est fait au retour sur la claim signée.
  const domains = cfg.GOOGLE_ALLOWED_DOMAINS;
  const hint: Record<string, string> = domains.length === 1 && !GOOGLE_CONSUMER_DOMAINS.has(domains[0]!) ? { hd: domains[0]! } : {};
  return {
    name, label: 'Google', issuer: GOOGLE_ISSUER, clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET, scopes: 'openid email profile',
    callbackPath: '/auth/oidc/google/callback', loginPath: '/auth/oidc/google/login',
    // Google refuse prompt=login : la confirmation demande max_age=0 (nouvelle authentification) et le choix du compte,
    // puis exige au retour un `auth_time` récent (reauthMaxAge).
    extraParams: (reauth): Record<string, string> => (reauth ? { ...hint, prompt: 'select_account', max_age: '0' } : { ...hint }),
    useUserInfo: false,
    reauthMaxAge: REAUTH_MAX_AGE_SECONDS,
  };
}

const insecureOptions = (cfg: Config, issuer: string) =>
  cfg.NODE_ENV !== 'production' && issuer.startsWith('http://') ? { execute: [oidc.allowInsecureRequests] } : {};

// Test des réglages : découverte du fournisseur sans toucher au client en service.
export async function probeOidc(cfg: Config, name: OidcProviderName = 'principal', fetchImpl?: oidc.CustomFetch): Promise<{ issuer: string; endpoints: string[] }> {
  const p = providerSettings(cfg, name);
  if (!p) throw new Error('Fournisseur non configuré.');
  const conf = await oidc.discovery(new URL(p.issuer), p.clientId, p.clientSecret, undefined, { ...insecureOptions(cfg, p.issuer), ...(fetchImpl ? { [oidc.customFetch]: fetchImpl } : {}) });
  const meta = conf.serverMetadata();
  if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error('Le fournisseur n’expose pas les points d’accès attendus (autorisation, jeton).');
  return { issuer: meta.issuer, endpoints: ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'end_session_endpoint'].filter((k) => (meta as unknown as Record<string, unknown>)[k]) };
}

export interface OidcClientOptions {
  // Implémentation de fetch injectable (tests) : découverte, jeton, JWKS, userinfo.
  fetch?: oidc.CustomFetch;
}

export class OidcClient {
  #config: Promise<oidc.Configuration> | null = null;
  #key = '';

  // `getCfg` renvoie la configuration effective : elle peut changer à chaud (réglages de l'interface).
  constructor(private readonly getCfg: () => Config, private readonly db: DB, readonly name: OidcProviderName = 'principal', private readonly opts: OidcClientOptions = {}) {}

  private get cfg() {
    return this.getCfg();
  }

  get settings() {
    return providerSettings(this.cfg, this.name);
  }

  get enabled() {
    return !!this.settings;
  }

  get redirectUri() {
    return `${this.cfg.PUBLIC_URL}${this.settings?.callbackPath ?? '/auth/callback'}`;
  }

  #discover() {
    const p = this.settings;
    if (!p) return Promise.reject(new HttpError(404, 'Introuvable'));
    const key = JSON.stringify([p.issuer, p.clientId, p.clientSecret]);
    if (key !== this.#key) {
      this.#key = key;
      this.#config = null;
    }
    if (!this.#config) {
      const options = { ...insecureOptions(this.cfg, p.issuer), ...(this.opts.fetch ? { [oidc.customFetch]: this.opts.fetch } : {}) };
      this.#config = oidc
        .discovery(new URL(p.issuer), p.clientId, p.clientSecret, undefined, options)
        .catch((err) => {
          this.#config = null; // nouvelle tentative au prochain login
          this.#key = '';
          throw err;
        });
    }
    return this.#config;
  }

  // `reauth` : demande au fournisseur de réauthentifier la personne (pas de connexion silencieuse), pour confirmer une action sensible.
  async authorizationUrl(returnTo: string, bindingHash: string, reauth = false) {
    const config = await this.#discover();
    const p = this.settings!;
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    // `reauth` est conservé avec la tentative : le contrôle d'`auth_time` au retour ne dépend pas de ce que le navigateur renvoie.
    this.db.prepare('INSERT INTO login_states (state, code_verifier, nonce, return_to, expires_at, binding_hash, provider, reauth) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(state, codeVerifier, nonce, returnTo, Date.now() + STATE_TTL, bindingHash, this.name, reauth ? 1 : 0);
    return oidc.buildAuthorizationUrl(config, {
      ...p.extraParams(reauth),
      redirect_uri: this.redirectUri,
      scope: p.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
  }

  async handleCallback(callbackUrl: URL, bindingToken: string | undefined) {
    const state = callbackUrl.searchParams.get('state') ?? '';
    // Le state est consommé immédiatement : un rejeu échoue. Il n'est valable que pour le fournisseur qui l'a émis
    // (un retour présenté sur la route d'un autre fournisseur est refusé).
    const saved = this.db.prepare('DELETE FROM login_states WHERE state = ? AND provider = ? RETURNING code_verifier, nonce, return_to, expires_at, binding_hash, reauth')
      .get(state, this.name) as { code_verifier: string; nonce: string; return_to: string; expires_at: number; binding_hash: string | null; reauth: number } | undefined;
    if (!saved || saved.expires_at < Date.now()) throw new HttpError(400, 'Tentative de connexion expirée, recommencez.');
    // La tentative doit revenir dans le navigateur qui l'a lancée (pas de cookie, pas de connexion).
    if (saved.binding_hash === null || !bindingMatches(saved.binding_hash, bindingToken)) throw new HttpError(400, 'Tentative de connexion lancée depuis un autre navigateur, recommencez.');

    const config = await this.#discover();
    // Confirmation : openid-client exige alors `auth_time` et refuse une authentification plus ancienne que maxAge.
    const maxAge = saved.reauth ? this.settings!.reauthMaxAge : undefined;
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: saved.code_verifier,
        expectedState: state,
        expectedNonce: saved.nonce,
        idTokenExpected: true,
        ...(maxAge !== undefined ? { maxAge } : {}),
      });
    } catch (err) {
      // openid-client enveloppe l'erreur d'oauth4webapi : le motif est dans `cause`.
      const e = err as { message?: unknown; cause?: { message?: unknown } };
      if (maxAge !== undefined && /auth_time|End-User authentication/.test(`${String(e?.message)} ${String(e?.cause?.message)}`)) throw new ReauthRejected();
      throw err;
    }
    const claims = tokens.claims();
    if (!claims?.sub) throw new HttpError(400, 'Réponse du fournisseur d’identité invalide');
    // Défense en profondeur, indépendante de la bibliothèque : `auth_time` numérique, récent et pas dans le futur.
    if (maxAge !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      const at = claims.auth_time;
      if (typeof at !== 'number' || at > now + CLOCK_TOLERANCE_SECONDS || at < now - maxAge - CLOCK_TOLERANCE_SECONDS) throw new ReauthRejected();
    }

    let profile: Record<string, unknown> = claims;
    if (this.settings!.useUserInfo && !Array.isArray(claims.groups)) {
      profile = { ...claims, ...(await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)) };
    }
    return { profile, idToken: tokens.id_token ?? null, returnTo: saved.return_to };
  }

  async logoutUrl(idToken: string | null) {
    try {
      const config = await this.#discover();
      if (!config.serverMetadata().end_session_endpoint) return null;
      return oidc.buildEndSessionUrl(config, {
        post_logout_redirect_uri: `${this.cfg.PUBLIC_URL}/`,
        ...(idToken ? { id_token_hint: idToken } : {}),
      }).href;
    } catch {
      return null;
    }
  }
}

// Ensemble des clients OIDC de l'instance, un par fournisseur nommé.
export class OidcProviders {
  readonly #clients: Record<OidcProviderName, OidcClient>;

  constructor(getCfg: () => Config, db: DB, opts: OidcClientOptions = {}) {
    this.#clients = Object.fromEntries(OIDC_PROVIDERS.map((n) => [n, new OidcClient(getCfg, db, n, opts)])) as Record<OidcProviderName, OidcClient>;
  }

  get(name: OidcProviderName): OidcClient {
    return this.#clients[name];
  }

  // Fournisseurs actifs, pour l'écran de connexion : identifiant, libellé, URL de départ. Aucun secret ni identifiant client.
  active(): { id: OidcProviderName; label: string; loginUrl: string }[] {
    return OIDC_PROVIDERS.flatMap((n) => {
      const s = this.#clients[n].settings;
      return s ? [{ id: n, label: s.label, loginUrl: s.loginPath }] : [];
    });
  }
}

// Fournisseur OIDC d'un compte d'après son identifiant ; null pour un compte local, LDAP, SAML ou de développement.
export function oidcProviderOfSub(sub: string): OidcProviderName | null {
  if (sub.startsWith(GOOGLE_SUB_PREFIX)) return 'google';
  // Préfixes réservés, sans tenir compte de la casse (même règle que SCIM) : un sub « Google:1 » ou « LOCAL:x » venu du
  // fournisseur principal est refusé plutôt que traité comme principal.
  if (/^(local|ldap|saml|scim|google):/i.test(sub) || /^dev-/i.test(sub)) return null;
  return 'principal';
}

// Valeurs `amr` (RFC 8176) qui prouvent un second facteur.
const MFA_METHODS = new Set(['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face', 'iris', 'retina', 'vbm']);

export function hasMfaClaim(claims: Record<string, unknown>): boolean {
  const amr = claims.amr;
  return Array.isArray(amr) && amr.some((m) => typeof m === 'string' && MFA_METHODS.has(m));
}

export function roleFromGroups(groups: unknown, cfg: Config): Role | null {
  const list = Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [];
  const has = (wanted: string[]) => wanted.some((g) => list.includes(g));
  if (has(cfg.OIDC_ADMIN_GROUPS)) return 'admin';
  if (has(cfg.OIDC_EDITOR_GROUPS)) return 'editor';
  if (has(cfg.OIDC_READER_GROUPS)) return 'reader';
  return cfg.OIDC_DEFAULT_ROLE === 'reader' ? 'reader' : null;
}

export type GoogleDecision =
  | { ok: true; sub: string; email: string; role: Role }
  | { ok: false; reason: 'email_unverified' | 'domain' | 'mfa' | 'role' };

// Politique de connexion Google, appliquée aux claims de l'id_token signé (jamais à /userinfo) :
//  - e-mail présent et `email_verified` strictement vrai, sinon refus ;
//  - domaines autorisés (facultatif) : claim `hd` (compte Google Workspace) dans la liste, ou adresse gmail.com /
//    googlemail.com si ce domaine y figure. Un compte Google grand public ouvert avec une adresse d'entreprise (pas de `hd`)
//    est refusé : l'adresse seule ne prouve pas l'appartenance à l'organisation ;
//  - OIDC_REQUIRE_MFA : Google ne transmet pas `amr`, la connexion est donc refusée ;
//  - rôle : GOOGLE_DEFAULT_ROLE, recalculé à chaque connexion (jamais admin) ; « none » refuse.
// Le compte est identifié par `google:<sub>` : jamais de rattachement à un compte existant par l'adresse e-mail.
export function googleDecision(claims: Record<string, unknown>, cfg: Config): GoogleDecision {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254 || claims.email_verified !== true) return { ok: false, reason: 'email_unverified' };
  const domains = cfg.GOOGLE_ALLOWED_DOMAINS;
  if (domains.length) {
    const hd = typeof claims.hd === 'string' ? claims.hd.trim().toLowerCase() : '';
    const emailDomain = email.slice(email.lastIndexOf('@') + 1);
    const allowed = hd ? domains.includes(hd) : GOOGLE_CONSUMER_DOMAINS.has(emailDomain) && domains.includes(emailDomain);
    if (!allowed) return { ok: false, reason: 'domain' };
  }
  if (cfg.OIDC_REQUIRE_MFA && !hasMfaClaim(claims)) return { ok: false, reason: 'mfa' };
  if (cfg.GOOGLE_DEFAULT_ROLE === 'none') return { ok: false, reason: 'role' };
  return { ok: true, sub: `${GOOGLE_SUB_PREFIX}${String(claims.sub)}`, email, role: cfg.GOOGLE_DEFAULT_ROLE };
}

export function upsertUser(db: DB, input: { sub: string; email: string | null; name: string; role: Role }) {
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM users WHERE sub = ?').get(input.sub) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE users SET email = ?, name = ?, role = ?, last_login_at = ? WHERE id = ?')
      .run(input.email, input.name, input.role, now, existing.id);
    // Promu administrateur : retiré des groupes gérés par SCIM, que le fournisseur ne peut plus modifier pour lui (compte
    // invisible par SCIM). Un administrateur a de toute façon accès à tout.
    if (input.role === 'admin') db.prepare('DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT group_id FROM scim_groups)').run(existing.id);
    return existing.id;
  }
  const id = newId();
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.sub, input.email, input.name, input.role, now, now);
  return id;
}

// N'accepte qu'un chemin relatif local : empêche les redirections ouvertes.
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])[^\s]*$/.test(value) && value.length < 512 ? value : '/';
}
