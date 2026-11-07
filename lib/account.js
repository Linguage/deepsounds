import { createHash, randomBytes } from 'node:crypto';
import qrcode from './vendor/qrcode.mjs';
import { MusicError } from './netease.js';

const QR_LIFETIME = 3 * 60_000;
const DAY = 24 * 60 * 60_000;
const SESSION_LIFETIME = 90 * DAY;
const POLL_INTERVAL = 1800;

export function createAccounts(service, name, scope, store) {
  const pending = new Map();
  const active = new Map();
  const loginRequired = () => new MusicError(401, '请先扫码登录' + name + '。');
  const keyFor = token => createHash('sha256').update(scope + ':' + token).digest('hex');

  function encode({ profile, credentials }) {
    return JSON.stringify({ profile, credentials: credentials instanceof Map ? [...credentials] : credentials });
  }

  function getAccount(key, row) {
    const current = active.get(key);
    if (current?.saved === row.data) return current;
    const { profile, credentials } = JSON.parse(row.data);
    const account = { profile, credentials: Array.isArray(credentials) ? new Map(credentials) : credentials };
    const entry = { account, saved: row.data, expires: row.expires, users: 0 };
    account.saveCredentials = () => {
      const data = encode(account);
      const expires = Date.now() + SESSION_LIFETIME;
      if (data === entry.saved && expires - entry.expires < DAY) return;
      if (store.update(key, entry.saved, data, expires)) {
        entry.saved = data;
        entry.expires = expires;
      }
    };
    active.set(key, entry);
    return entry;
  }

  function removePending(token) {
    clearTimeout(pending.get(token)?.expiry);
    pending.delete(token);
  }

  function expirePending(token, session) {
    clearTimeout(session.expiry);
    session.expiresAt = Date.now() + QR_LIFETIME;
    session.expiry = setTimeout(() => removePending(token), QR_LIFETIME).unref();
  }

  function getPending(token) {
    const session = pending.get(token);
    if (session && session.expiresAt > Date.now()) return session;
    removePending(token);
    return null;
  }

  return {
    async start() {
      for (const token of pending.keys()) getPending(token);
      if (pending.size >= 20) throw new MusicError(429, '登录请求过多，请稍后重试。');
      const token = randomBytes(32).toString('base64url');
      const session = { state: 'waiting' };
      pending.set(token, session);
      expirePending(token, session);
      try {
        const { key, url } = await service.loginStart();
        session.key = key;
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        session.state = 'waiting';
        expirePending(token, session);
        return { token, qr: qr.createDataURL(5, 20) };
      } catch (error) {
        removePending(token);
        throw error;
      }
    },

    async check(token) {
      if (!token) return { state: 'expired' };
      const key = keyFor(token);
      const session = getPending(token);
      if (!session) {
        const row = store.get(key);
        return row ? { state: 'signed-in', profile: JSON.parse(row.data).profile } : { state: 'expired' };
      }
      if (session.checking || session.nextPoll > Date.now()) return { state: session.state };
      session.checking = true;
      session.nextPoll = Date.now() + POLL_INTERVAL;
      try {
        if (!session.credentials) {
          const result = await service.loginPoll(session.key);
          if (!getPending(token) || result.state === 'expired') {
            removePending(token);
            return { state: 'expired' };
          }
          session.state = result.state;
          if (!result.credentials) return { state: session.state };
          session.credentials = result.credentials;
        }
        const profile = await service.profile(session.credentials);
        if (!getPending(token)) return { state: 'expired' };
        store.insert(key, encode({ profile, credentials: session.credentials }), Date.now() + SESSION_LIFETIME);
        removePending(token);
        return { state: 'signed-in', profile };
      } catch (error) {
        if (error.status === 401) removePending(token);
        throw error;
      } finally {
        session.checking = false;
      }
    },

    async use(token, action, required = false) {
      if (!token && !required) return action(null);
      if (!token || getPending(token)) throw loginRequired();
      const key = keyFor(token);
      const row = store.get(key);
      if (!row) throw loginRequired();
      const entry = getAccount(key, row);
      entry.users++;
      try {
        const data = await action(entry.account);
        if (!store.get(key)) throw loginRequired();
        return data;
      } catch (error) {
        if (error.status === 401) store.clearIfCurrent(key, entry.saved);
        throw error;
      } finally {
        try {
          entry.account.saveCredentials();
        } finally {
          if (--entry.users === 0 && active.get(key) === entry) active.delete(key);
        }
      }
    },

    clear(token) {
      if (token && !getPending(token)) store.clear(keyFor(token));
      removePending(token);
      return { ok: true };
    },
  };
}
