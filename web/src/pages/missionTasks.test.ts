import { describe, it, expect } from 'vitest';
import {
  partitionTasks,
  isTerminal,
  statusTone,
  hasMoreHistory,
  TERMINAL,
  type MissionTask,
} from './missionTasks';

function task(over: Partial<MissionTask> = {}): MissionTask {
  return {
    id: 'id-' + Math.random().toString(36).slice(2),
    title: 't',
    prompt: 'p',
    assigned_agent: null,
    status: 'queued',
    priority: 0,
    created_by: 'main',
    created_at: 1,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    ...over,
  };
}

describe('partitionTasks', () => {
  it('routes a queued (assigned) task to the queue, not active', () => {
    const { queue, active } = partitionTasks([task({ status: 'queued', assigned_agent: 'sleuth' })]);
    expect(queue).toHaveLength(1);
    expect(active).toHaveLength(0);
  });

  it('routes a queued, unassigned task to the queue', () => {
    const { queue } = partitionTasks([task({ status: 'queued', assigned_agent: null })]);
    expect(queue).toHaveLength(1);
  });

  it('routes a running, assigned task to active and keeps it out of the queue', () => {
    const { queue, active } = partitionTasks([task({ status: 'running', assigned_agent: 'cipher' })]);
    expect(active).toHaveLength(1);
    expect(queue).toHaveLength(0);
  });

  it('keeps an orphaned running task (no agent) visible in BOTH buckets so it is never hidden', () => {
    // Exercises the second operand of the queue OR-rule (!assigned_agent) on a
    // non-queued status. running + unassigned should not normally happen, but
    // if it does we surface it rather than dropping it on the floor.
    const t = task({ status: 'running', assigned_agent: null });
    const { queue, active } = partitionTasks([t]);
    expect(queue.map((x) => x.id)).toContain(t.id);
    expect(active.map((x) => x.id)).toContain(t.id);
  });

  it('excludes every terminal task from both buckets (they belong to history)', () => {
    const tasks = (['completed', 'failed', 'cancelled'] as const).map((s) =>
      task({ status: s, assigned_agent: 'x' }),
    );
    const { queue, active } = partitionTasks(tasks);
    expect(queue).toHaveLength(0);
    expect(active).toHaveLength(0);
  });
});

describe('statusTone', () => {
  it("maps 'completed' to the 'done' palette tone (the missing-color bug fix)", () => {
    expect(statusTone('completed')).toBe('done');
  });

  it('passes the other statuses through as valid Pill tones', () => {
    expect(statusTone('queued')).toBe('queued');
    expect(statusTone('running')).toBe('running');
    expect(statusTone('failed')).toBe('failed');
    expect(statusTone('cancelled')).toBe('cancelled');
  });
});

describe('isTerminal + TERMINAL', () => {
  it('treats completed/failed/cancelled as terminal and queued/running as live', () => {
    expect(TERMINAL).toEqual(['completed', 'failed', 'cancelled']);
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});

describe('hasMoreHistory', () => {
  it('reports more pages only while shown rows are fewer than the server total', () => {
    expect(hasMoreHistory(30, 90)).toBe(true);
    expect(hasMoreHistory(90, 90)).toBe(false);
    expect(hasMoreHistory(0, 0)).toBe(false);
  });
});
