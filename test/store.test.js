import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('secrets are encrypted at rest and decrypt back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
  const s = new Store(dir);
  const box = s.encrypt({ userName: 'trader', apiKey: 'SECRET-KEY-123' });
  s.upsert('connections', { id: 'c1', type: 'projectx', secret: box });
  const raw = fs.readFileSync(path.join(dir, 'store.json'), 'utf8');
  assert.ok(!raw.includes('SECRET-KEY-123'));
  const s2 = new Store(dir);
  assert.deepEqual(s2.decrypt(s2.connections[0].secret), { userName: 'trader', apiKey: 'SECRET-KEY-123' });
  assert.equal(fs.statSync(path.join(dir, 'master.key')).mode & 0o777, 0o600);
  // tampering is detected
  const bad = { ...box, data: Buffer.from('x').toString('base64') };
  assert.throws(() => s2.decrypt(bad));
});
