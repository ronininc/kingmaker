/** Dispatches one leased job through a named, explicitly supplied adapter. */
export function createJobDispatcher({ pool, workerId, adapters = {} }) {
  if (!pool || !workerId) throw new Error('DISPATCHER_CONFIG_REQUIRED');
  const names = Object.keys(adapters);
  return {
    async runOne() {
      const job = pool.claim(workerId, names);
      if (!job) return null;
      const handler = adapters[job.adapter];
      if (typeof handler !== 'function') throw new Error('ADAPTER_NOT_CONFIGURED');
      pool.acknowledge(job.id, workerId, job.leaseToken);
      try {
        const evidence = await handler({ id: job.id, text: job.text, attempt: job.attempts });
        return pool.complete(job.id, workerId, job.leaseToken, evidence);
      } catch (error) {
        return pool.fail(job.id, workerId, job.leaseToken, error?.message ?? error);
      }
    },
  };
}

/** Cloud execution remains unavailable unless an owner configures a real adapter. */
export function disabledCloudAdapter() {
  throw new Error('CLOUD_ADAPTER_NOT_CONFIGURED');
}
