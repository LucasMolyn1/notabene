// Sonde de test (jamais chargée en production) : signale toute tentative de connexion ou de résolution DNS vers une
// adresse qui n'est ni locale ni privée. Chargée par NODE_OPTIONS=--require dans le test de déploiement isolé (CI).
// Chaque tentative écrit une ligne « EGRESS-ATTEMPT {...} » sur la sortie d'erreur.
'use strict';
const process = require('node:process');
const net = require('node:net');
const dns = require('node:dns');

const LOCAL = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:|f[cd][0-9a-f]{2}:)/i;
const note = (kind, target) => process.stderr.write(`EGRESS-ATTEMPT ${JSON.stringify({ kind, target: String(target) })}\n`);
const external = (host) => typeof host === 'string' && host !== '' && !LOCAL.test(host);

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  let host = null;
  if (o && typeof o === 'object') host = o.path ? null : (o.host || 'localhost');
  else if (typeof o === 'number') host = typeof args[1] === 'string' ? args[1] : 'localhost';
  if (external(host)) note('connect', host);
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function patchedLookup(host, ...rest) {
  if (external(host)) note('dns', host);
  return lookup.call(this, host, ...rest);
};
