// Client OIDC (Authentik ou tout fournisseur conforme) : Authorization Code + PKCE,
// state et nonce à usage unique, rôle dérivé des groupes à chaque connexion.
import * as oidc from 'openid-client';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { HttpError, newId } from '../lib/http.js';
import type { Role } from './context.js';

const STATE_TTL = 10 * 60_000;

export class OidcClient {
  #config: Promise<oidc.Configuration> | null = null;

  constructor(private readonly cfg: Config, private readonly db: DB) {}

  get redirectUri() {
    return `${this.cfg.PUBLIC_URL}/auth/callback`;
  }

  #discover() {
    if (!this.#config) {
      const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, NODE_ENV } = this.cfg;
      const options = NODE_ENV !== 'production' && OIDC_ISSUER!.startsWith('http://')
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined;
      this.#config = oidc
        .discovery(new URL(OIDC_ISSUER!), OIDC_CLIENT_ID!, OIDC_CLIENT_SECRET!, undefined, options)
        .catch((err) => {
          this.#config = null; // nouvelle tentative au prochain login
          throw err;
        });
    }
    return this.#config;
  }

  async authorizationUrl(returnTo: string) {
    const config = await this.#discover();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    this.db.prepare('INSERT INTO login_states (state, code_verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, codeVerifier, nonce, returnTo, Date.now() + STATE_TTL);
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.cfg.OIDC_SCOPES,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
  }

  async handleCallback(callbackUrl: URL) {
    const config = await this.#discover();
    const state = callbackUrl.searchParams.get('state') ?? '';
    // Le state est consommé immédiatement : un rejeu échoue.
    const saved = this.db.prepare('DELETE FROM login_states WHERE state = ? RETURNING code_verifier, nonce, return_to, expires_at')
      .get(state) as { code_verifier: string; nonce: string; return_to: string; expires_at: number } | undefined;
    if (!saved || saved.expires_at < Date.now()) throw new HttpError(400, 'Tentative de connexion expirée, recommencez.');

    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: saved.code_verifier,
      expectedState: state,
      expectedNonce: saved.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub) throw new HttpError(400, 'Réponse du fournisseur d’identité invalide');

    let profile: Record<string, unknown> = claims;
    if (!Array.isArray(claims.groups)) {
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

export function upsertUser(db: DB, input: { sub: string; email: string | null; name: string; role: Role }) {
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM users WHERE sub = ?').get(input.sub) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE users SET email = ?, name = ?, role = ?, last_login_at = ? WHERE id = ?')
      .run(input.email, input.name, input.role, now, existing.id);
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
