// Correlation belongs to the open UI/CLI transport, not to engine internals.
import { AsyncLocalStorage } from 'node:async_hooks';
const turns = new AsyncLocalStorage();
export const validRequestId = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id) ? id : null;
export function barEvent(event) {
  const turn = turns.getStore();
  return { ...event, requestId: turn?.open ? turn.id : null };
}
export function createBarTurnQueue({ write, work = { queued: 0, running: 0 } }) {
  let tail = Promise.resolve();
  return (fn, requestId = null) => {
    work.queued++;
    const run = () => turns.run({ id: validRequestId(requestId), open: true }, async () => {
      work.queued--; work.running++;
      try { return await fn(); }
      finally {
        const turn = turns.getStore();
        turn.open = false; work.running--;
        if (turn.id) write({ turnComplete: true, requestId: turn.id });
      }
    });
    const result = tail.then(run);
    tail = result.catch(() => {}); // one failed request cannot poison subsequent requests
    return result;
  };
}
