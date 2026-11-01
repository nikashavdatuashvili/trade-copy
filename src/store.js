// Persistent settings: connections and copy groups.
// Broker secrets (API keys) are encrypted at rest with AES-256-GCM.
// The master key comes from COPYTRADER_MASTER_KEY (64 hex chars) or is generated once into
// data/master.key (file mode 600). Keep that file out of git and backups you share.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'store.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.key = this._loadKey();
    this.data = { connections: [], groups: [] };
    if (fs.existsSync(this.file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
  }

  _loadKey() {
    const env = process.env.COPYTRADER_MASTER_KEY;
    if (env) {
      if (!/^[0-9a-f]{64}$/i.test(env)) throw new Error('COPYTRADER_MASTER_KEY must be 64 hex characters');
      return Buffer.from(env, 'hex');
    }
    const kf = path.join(this.dir, 'master.key');
    if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    return Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'hex');
  }

  encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  decrypt(box) {
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // connections: { id, type, label, secret?: encrypted, options? }
  get connections() {
    return this.data.connections;
  }
  get groups() {
    return this.data.groups;
  }

  upsert(list, item) {
    const arr = this.data[list];
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = item;
    else arr.push(item);
    this.save();
  }

  remove(list, id) {
    this.data[list] = this.data[list].filter((x) => x.id !== id);
    this.save();
  }
}
