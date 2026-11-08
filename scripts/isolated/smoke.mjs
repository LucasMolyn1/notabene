// Parcours minimal exécuté depuis un conteneur du même réseau interne : connexion, création et recherche d'une page.
// Usage : node smoke.mjs http://notabene:3000 admin@iso.test <mot de passe>
const [base, email, password] = process.argv.slice(2);
const must = (cond, msg) => { if (!cond) { console.error(`ECHEC : ${msg}`); process.exit(1); } };

const health = await fetch(`${base}/healthz`);
must(health.ok, `/healthz ${health.status}`);

const login = await fetch(`${base}/auth/local/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
must(login.ok, `connexion ${login.status}`);
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const me = await (await fetch(`${base}/api/v3/me`, { headers: { cookie } })).json();
const headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': me.csrf };

const made = await fetch(`${base}/api/v3/spaces`, { method: 'POST', headers, body: JSON.stringify({ name: 'Espace isolé' }) });
must(made.ok, `création d'espace ${made.status}`);
const space = await made.json();
must(space?.id, 'espace sans identifiant');

const created = await fetch(`${base}/api/v3/pages`, { method: 'POST', headers, body: JSON.stringify({ spaceId: space.id, title: 'Page de test isolé' }) });
must(created.ok, `création de page ${created.status}`);

const found = await fetch(`${base}/api/v3/search?q=isol%C3%A9`, { headers });
must(found.ok, `recherche ${found.status}`);
const config = await fetch(`${base}/api/v3/config`, { headers });
must(config.ok, `config ${config.status}`);
console.log('parcours isolé : ok');
