import type { Manager } from './manager';
export function startCollector(manager: Manager, onError: () => void, intervalMs = 20 * 60_000) {
  const run = () => { void manager.reconcile().catch(onError); };
  run();
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}
