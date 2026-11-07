import { createHandler, PREFIX } from './http.js';

export const name = 'deepsounds';
export const inject = ['webServer'];

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: PREFIX.slice(0, -1), handler: createHandler(),
  }));
}
