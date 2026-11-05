/** Opt-in scheduler. A running process is not evidence of healthy product use.
 * Only fresh, explicitly sampled observations are sent, never synthesized defaults.
 */
export function createInstallationHealthReporter({ account, sample, hasConsent, now = () => Math.floor(Date.now() / 1000), intervalMs = 60_000, schedule = setInterval, cancel = clearInterval } = {}) {
  if (typeof account?.reportHealth !== 'function' || typeof sample !== 'function' || typeof hasConsent !== 'function') throw new Error('HEALTH_ADAPTERS_REQUIRED');
  let timer = null, inFlight = false, stopped = false;
  const tick = async () => {
    if (stopped || inFlight) return { sent: false, reason: 'inactive_or_busy' };
    if (hasConsent() !== true) return { sent: false, reason: 'consent_required' };
    inFlight = true;
    try {
      const observation = await sample();
      if (stopped || hasConsent() !== true) return { sent: false, reason: 'consent_withdrawn' };
      if (!observation || !Number.isSafeInteger(observation.observedAt) || observation.observedAt > now() + 5 || now() - observation.observedAt > 120
        || !['healthy','degraded'].includes(observation.state)) return { sent: false, reason: 'fresh_observation_required' };
      const receipt = await account.reportHealth({ ...observation, consent: true });
      return { sent: true, receipt };
    } catch { return { sent: false, reason: 'health_report_unconfirmed' }; }
    finally { inFlight = false; }
  };
  return Object.freeze({
    tick,
    start() {
      if (timer !== null) return;
      stopped = false;
      timer = schedule(() => { void tick().catch(() => {}); }, Math.max(60_000, Math.min(Number(intervalMs) || 60_000, 900_000)));
      timer?.unref?.();
    },
    stop() { stopped = true; if (timer !== null) cancel(timer); timer = null; },
  });
}
