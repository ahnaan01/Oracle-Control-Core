import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { Store } from './database/store.js';
import { hashPassword, randomToken } from './security/crypto.js';

process.umask(0o077);
const config = loadConfig();
const username = process.argv[2] ?? 'admin';
if (!/^[a-zA-Z0-9_-]{1,50}$/.test(username)) throw new Error('Use a simple username (letters, digits, underscore, hyphen)');
const store = new Store(config.OCC_DB_PATH);
try {
  if (store.db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw new Error('User exists; refusing to overwrite credentials');
  const password = process.env.OCC_ADMIN_PASSWORD ?? randomToken();
  if (password.length < 16 || password.length > 256) throw new Error('Password must contain 16–256 characters');
  const id = randomUUID();
  store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, username, await hashPassword(password), JSON.stringify(['admin']));
  console.log(`Created local OCC administrator: ${username}\nInternal OCC user ID: ${id}`);
  if (!process.env.OCC_ADMIN_PASSWORD) console.log(`Generated password (shown once; keep private): ${password}`);
} finally { store.close(); }
