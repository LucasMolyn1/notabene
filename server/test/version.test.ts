import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const root = resolve(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as { version: string; packages: { '': { version: string } } };
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

describe('version', () => {
  it('est une version sémantique', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('concorde partout : package.json, verrou, journal des changements et serveur', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    // Premier titre « ## [x.y.z] - date » du journal = version courante.
    const first = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m.exec(changelog);
    expect(first?.[1]).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });
});
