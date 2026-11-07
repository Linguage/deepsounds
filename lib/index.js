import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHandler, PREFIX } from './http.js';
import { createSessionStore } from './session-store.js';
import { createUpdater } from './update.js';

export const name = 'deepsounds';
export const inject = ['webServer'];

export function apply(ctx) {
  const updater = createUpdater({ getManager: () => ctx.get?.('pluginManager') });
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  ctx.effect(() => {
    const store = createSessionStore(join(home, 'storages', 'deepsounds-dsh'));
    const unregister = ctx.webServer.register({
      kind: 'prefix', path: PREFIX.slice(0, -1), handler: createHandler(undefined, undefined, undefined, updater, store),
    });
    return () => {
      try { unregister(); } finally { store.close(); }
    };
  });
}
