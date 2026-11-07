import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createSessionStore(directory) {
  let database;
  let statements;
  let closed = false;
  function open() {
    if (closed) throw new Error('Account storage is closed');
    if (statements) return statements;
    let file = ':memory:';
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      file = join(directory, 'sessions.sqlite');
      closeSync(openSync(file, 'a', 0o600));
      chmodSync(file, 0o600);
    }
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      `);
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      statements = {
        get: db.prepare('SELECT data, expires FROM sessions WHERE key = ? AND expires > ?'),
        insert: db.prepare('INSERT INTO sessions (key, data, expires) VALUES (?, ?, ?)'),
        update: db.prepare('UPDATE sessions SET data = ?, expires = ? WHERE key = ? AND data = ? AND expires > ?'),
        clear: db.prepare('DELETE FROM sessions WHERE key = ?'),
        clearIfCurrent: db.prepare('DELETE FROM sessions WHERE key = ? AND data = ?'),
      };
      database = db;
      return statements;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  return {
    get: key => open().get.get(key, Date.now()),
    insert: (key, data, expires) => open().insert.run(key, data, expires),
    update: (key, previous, data, expires) => open().update.run(data, expires, key, previous, Date.now()).changes > 0,
    clear: key => open().clear.run(key),
    clearIfCurrent: (key, data) => open().clearIfCurrent.run(key, data),
    close() {
      closed = true;
      database?.close();
      database = statements = undefined;
    },
  };
}
