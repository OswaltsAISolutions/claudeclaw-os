import type { Tone } from '@/components/Pill';

// Domain types + pure view-logic for Mission Control. Kept free of preact so
// the rules that decide which bucket a task lands in (and how it is colored)
// can be unit-tested without a DOM.

export type MissionTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MissionTask {
  id: string;
  title: string;
  prompt: string;
  assigned_agent: string | null;
  status: MissionTaskStatus;
  priority: number;
  created_by: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
}

export const TERMINAL: MissionTaskStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminal(status: MissionTaskStatus): boolean {
  return TERMINAL.includes(status);
}

// queue  = waiting to run (status='queued') OR not yet assigned, excluding
//          anything already terminal.
// active = currently running.
// Terminal tasks are not returned here; they live in the history archive.
export function partitionTasks(all: MissionTask[]): { queue: MissionTask[]; active: MissionTask[] } {
  const queue = all.filter(
    (t) => !isTerminal(t.status) && (t.status === 'queued' || !t.assigned_agent),
  );
  const active = all.filter((t) => t.status === 'running');
  return { queue, active };
}

// The status enum uses 'completed' but the Pill palette names the green tone
// 'done'. Map it so a finished task actually gets its color instead of an
// undefined style class. Every other status is already a valid Pill tone.
export function statusTone(status: MissionTaskStatus): Tone {
  return status === 'completed' ? 'done' : status;
}

// The Completed tab pages the history archive; show "Load more" only while the
// rows we have are fewer than the server's reported total.
export function hasMoreHistory(shownCount: number, total: number): boolean {
  return shownCount < total;
}
