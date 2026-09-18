export interface SyncProgress {
  runId: string;
  configId: string;
  status: 'running' | 'completed' | 'failed';
  stage: string;
  processed: number;
  total: number;
  result?: import('../types/index.js').SyncResult;
  error?: string;
  startedAt: number;
}
const runs = new Map<string, SyncProgress>();
const current = new Map<string, string>();
export function beginRun(configId: string): SyncProgress {
  for (const [id, run] of runs) {
    if (run.status !== 'running' && Date.now() - run.startedAt > 3600000) {
      runs.delete(id);
      if (current.get(run.configId) === id) current.delete(run.configId);
    }
  }
  const run: SyncProgress = { runId: crypto.randomUUID(), configId, status: 'running', stage: 'Connecting to database', processed: 0, total: 0, startedAt: Date.now() };
  runs.set(run.runId, run); current.set(configId, run.runId);
  return run;
}
export function currentRun(configId: string): SyncProgress | undefined {
  return runs.get(current.get(configId) || '');
}
export function getRun(configId: string, runId: string): SyncProgress | undefined {
  const run = runs.get(runId);
  return run?.configId === configId ? run : undefined;
}
