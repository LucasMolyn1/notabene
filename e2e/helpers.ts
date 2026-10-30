import { createHmac } from 'node:crypto';
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN } from './accounts';

export const PASSWORD = 'Test-e2e-pass-12345';

// ---- TOTP (RFC 6238, SHA-1, 6 chiffres) : copie minimale pour ne pas coupler les tests au code serveur ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text: string) {
  let bits = '';
  for (const c of text.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secret: string, offsetSteps = 0) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

// ---- Sessions ----
export async function loginUi(page: Page, email: string, password: string, code?: string, { expectSuccess = true } = {}) {
  await page.goto('/?login');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  if (code) {
    await page.getByLabel('Code de vérification').fill(code);
    await page.getByRole('button', { name: 'Se connecter' }).click();
  }
  // Attend la redirection qui suit une connexion réussie (la page ne doit plus porter « ?login »).
  if (expectSuccess) await page.waitForURL((u) => !u.search.includes('login'), { timeout: 15_000 });
}

// Une seule connexion par compte pour toute la série (la route de connexion est limitée à 10 par minute et par IP).
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();

// Contexte navigateur déjà connecté (cookie posé par l'API de connexion, puis réutilisé).
export async function sessionContext(browser: Browser, email: string, password: string): Promise<BrowserContext> {
  const known = sessions.get(email);
  if (known) return browser.newContext({ baseURL: 'http://localhost:3100', storageState: known });
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const res = await ctx.request.post('/auth/local/login', { data: { email, password } });
  expect(res.ok(), `connexion ${email}`).toBeTruthy();
  sessions.set(email, await ctx.storageState());
  return ctx;
}

export const adminContext = (browser: Browser) => sessionContext(browser, ADMIN.email, ADMIN.password);

// Appel d'API authentifié avec jeton CSRF (session déjà ouverte dans le contexte).
export async function api(request: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown) {
  const me = await (await request.get('/api/v3/me')).json();
  return request.fetch(`/api/v3${url}`, { method, data, headers: { 'x-csrf-token': me.csrf ?? '' } });
}

export async function createLocalUser(admin: APIRequestContext, email: string, name: string, role: 'editor' | 'reader' | 'admin') {
  const res = await api(admin, 'POST', '/admin/local-users', { email, name, role, password: PASSWORD });
  expect([201, 409]).toContain(res.status());
}
