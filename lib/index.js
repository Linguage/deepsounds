import { createHandler, PREFIX } from './http.js';
import { createUpdater } from './update.js';

export const name = 'deepsounds';
export const inject = ['webServer'];

export function apply(ctx) {
  const updater = createUpdater({ getManager: () => ctx.get?.('pluginManager') });
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: PREFIX.slice(0, -1), handler: createHandler(undefined, undefined, undefined, updater),
  }));
}
