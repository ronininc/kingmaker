/**
 * Dispatches one leased job through a named, explicitly supplied adapter.
 * Handler effects are at-least-once: a process can perform an effect and die
 * before recording completion. Adapters must use the job id as their own
 * downstream idempotency key; lease fencing protects queue state, not effects.
 */
export function createJobDispatcher({ pool, workerId, adapters = {}, heartbeatMs = 10_000 }) {
  if (!pool || !workerId) throw new Error('DISPATCHER_CONFIG_REQUIRED');
  const names = Object.keys(adapters);
  return {
    async runOne() {
      const job = pool.claim(workerId, names);
      if (!job) return null;
      const handler = adapters[job.adapter];
      if (typeof handler !== 'function') throw new Error('ADAPTER_NOT_CONFIGURED');
      pool.acknowledge(job.id, workerId, job.leaseToken);
      const controller = new AbortController(); let heartbeatError = null;
      const heartbeat = setInterval(() => {
        try { pool.renewLease(job.id, workerId, job.leaseToken); }
        catch (error) { heartbeatError = error; controller.abort(error); }
      }, Math.max(10, heartbeatMs));
      heartbeat.unref?.();
      try {
        const evidence = await handler({ id: job.id, text: job.text, attempt: job.attempts, signal: controller.signal });
        if (heartbeatError) throw heartbeatError;
        return pool.complete(job.id, workerId, job.leaseToken, evidence);
      } catch (error) {
        return pool.fail(job.id, workerId, job.leaseToken, error?.message ?? error);
      } finally { clearInterval(heartbeat); }
    },
  };
}

/** Cloud execution remains unavailable unless an owner configures a real adapter. */
export function disabledCloudAdapter() {
  throw new Error('CLOUD_ADAPTER_NOT_CONFIGURED');
}
