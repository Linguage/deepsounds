import { randomBytes } from 'node:crypto';
import qrcode from './vendor/qrcode.mjs';
import { MusicError } from './netease.js';

const QR_LIFETIME = 3 * 60_000;
const SESSION_LIFETIME = 12 * 60 * 60_000;
const POLL_INTERVAL = 1800;

export function createAccounts(service, name = '网易云音乐') {
  const sessions = new Map();
  const loginRequired = () => new MusicError(401, '请先扫码登录' + name + '。');

  function remove(token) {
    clearTimeout(sessions.get(token)?.expiry);
    sessions.delete(token);
  }

  function expireAfter(token, session, duration) {
    clearTimeout(session.expiry);
    session.expiresAt = Date.now() + duration;
    session.expiry = setTimeout(() => remove(token), duration).unref();
  }

  function get(token) {
    const session = sessions.get(token);
    if (session && session.expiresAt > Date.now()) return session;
    remove(token);
    return null;
  }

  return {
    async start() {
      for (const token of sessions.keys()) get(token);
      if (sessions.size >= 20) throw new MusicError(429, '登录请求过多，请稍后重试。');
      const token = randomBytes(32).toString('base64url');
      const session = { state: 'waiting' };
      sessions.set(token, session);
      expireAfter(token, session, QR_LIFETIME);
      try {
        const { key, url } = await service.loginStart();
        session.key = key;
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        session.state = 'waiting';
        expireAfter(token, session, QR_LIFETIME);
        return { token, qr: qr.createDataURL(5, 20) };
      } catch (error) {
        remove(token);
        throw error;
      }
    },

    async check(token) {
      const session = get(token);
      if (!session) return { state: 'expired' };
      if (session.profile) return { state: 'signed-in', profile: session.profile };
      if (session.checking || session.nextPoll > Date.now()) return { state: session.state };
      session.checking = true;
      session.nextPoll = Date.now() + POLL_INTERVAL;
      try {
        if (!session.credentials) {
          const result = await service.loginPoll(session.key);
          if (!get(token) || result.state === 'expired') {
            remove(token);
            return { state: 'expired' };
          }
          session.state = result.state;
          if (!result.credentials) return { state: session.state };
          session.credentials = result.credentials;
        }
        const profile = await service.profile(session.credentials);
        if (!get(token)) return { state: 'expired' };
        session.profile = profile;
        delete session.key;
        expireAfter(token, session, SESSION_LIFETIME);
        return { state: 'signed-in', profile };
      } catch (error) {
        if (error.status === 401) remove(token);
        throw error;
      } finally {
        session.checking = false;
      }
    },

    async use(token, action, required = false) {
      if (!token && !required) return action(null);
      const session = get(token);
      if (!session?.profile) throw loginRequired();
      try {
        const data = await action(session);
        if (!get(token)) throw loginRequired();
        return data;
      } catch (error) {
        if (error.status === 401) remove(token);
        throw error;
      }
    },

    clear(token) {
      remove(token);
      return { ok: true };
    },
  };
}
