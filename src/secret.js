// Local HMAC key and keyed digests. The key never leaves the state directory;
// digests let the index group by path, session, project and account without
// holding the raw values.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'identity.key';
const KEY_BYTES = 32;

function keyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readKey(file) {
  const key = fs.readFileSync(file);
  if (key.length !== KEY_BYTES) throw keyError('key_invalid');
  return key;
}

/** Returns the 32-byte key in <stateDir>/identity.key, creating it once. */
export function loadOrCreateKey(stateDir) {
  const file = path.join(stateDir, KEY_FILE);
  try {
    return readKey(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error.code === 'key_invalid' ? error : keyError('key_unreadable');
  }

  const key = crypto.randomBytes(KEY_BYTES);
  try {
    // 'wx' fails if another process won the race; fall back to its key.
    fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (error) {
    if (error.code === 'EEXIST') return readKey(file);
    throw keyError('key_unwritable');
  }
}

/** Domain-separated, truncated HMAC-SHA256 digest (22 base64url chars). */
export function keyed(key, domain, value) {
  return crypto
    .createHmac('sha256', key)
    .update(`tibotattle/${domain}/v1\0`)
    .update(String(value))
    .digest('base64url')
    .slice(0, 22);
}
