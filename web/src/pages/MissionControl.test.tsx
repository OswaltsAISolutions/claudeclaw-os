import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import type { MissionTask } from './missionTasks';

// The component fetches over the network and renders the Specialist Floor on
// its own data. We mock the data layer (useFetch keyed by path), the mutation
// API, toasts, the router, the personalization signal, and the Floor so the
// test exercises Mission Control's own wiring: tab grouping, the click-to-open
// detail drawer, and the paginated Completed archive.
const h = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock('@/lib/useFetch', () => ({
  useFetch: (path: string | null) => {
    const empty = { data: undefined, loading: false, error: null, refresh: vi.fn() };
    if (!path) return empty;
    const key = path.startsWith('/api/mission/history')
      ? 'history'
      : path.startsWith('/api/mission/tasks/')
        ? 'detail'
        : path;
    return { data: h.data[key], loading: false, error: null, refresh: vi.fn() };
  },
}));
vi.mock('@/lib/api', () => ({ apiPost: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/lib/toasts', () => ({ pushToast: vi.fn() }));
vi.mock('@/lib/personalization', () => ({ workspaceName: { value: 'ClaudeClaw' } }));
vi.mock('wouter-preact', () => ({ useLocation: () => ['/mission', vi.fn()] }));
vi.mock('@/components/SpecialistFloor', () => ({ SpecialistFloor: () => null }));

import { MissionControl } from './MissionControl';

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

beforeEach(() => {
  h.data = {};
  vi.clearAllMocks();
});

describe('MissionControl', () => {
  it('lists live queue tasks on the default tab and keeps running work off it', () => {
    h.data['/api/mission/tasks'] = {
      tasks: [
        task({ id: 'q1', title: 'Index the vault', status: 'queued', assigned_agent: 'sleuth' }),
        task({ id: 'q2', title: 'Scan open ports', status: 'queued', assigned_agent: null }),
        task({ id: 'r1', title: 'Running job', status: 'running', assigned_agent: 'cipher' }),
      ],
    };
    h.data['/api/agents'] = { agents: [{ id: 'sleuth', name: 'Sleuth', description: '', running: true }] };
    h.data['history'] = { tasks: [], total: 0 };

    render(<MissionControl />);

    expect(screen.getByText('Index the vault')).toBeInTheDocument();
    expect(screen.getByText('Scan open ports')).toBeInTheDocument();
    // The running task belongs to the Active tab, not the default Queue tab.
    expect(screen.queryByText('Running job')).not.toBeInTheDocument();
  });

  it('opens the task detail drawer with a fresh server copy when a title is clicked', async () => {
    h.data['/api/mission/tasks'] = {
      tasks: [task({ id: 'abc12345', title: 'Index the vault', status: 'queued', assigned_agent: 'sleuth' })],
    };
    h.data['/api/agents'] = { agents: [] };
    h.data['history'] = { tasks: [], total: 0 };
    // The drawer re-fetches GET /api/mission/tasks/:id; this prompt is unique
    // to that detail copy, so finding it proves the drawer opened on the fetch.
    h.data['detail'] = {
      task: task({ id: 'abc12345', title: 'Index the vault', status: 'queued', prompt: 'enumerate every secret' }),
    };

    render(<MissionControl />);
    fireEvent.click(screen.getByText('Index the vault'));

    expect(await screen.findByText('enumerate every secret')).toBeInTheDocument();
    expect(screen.getByText(/Task . abc12345/)).toBeInTheDocument();
  });

  it('renders the history archive on the Completed tab with a Load more pager when more remain', async () => {
    h.data['/api/mission/tasks'] = { tasks: [] };
    h.data['/api/agents'] = { agents: [] };
    h.data['history'] = {
      tasks: [task({ id: 'c1', title: 'Archived report', status: 'completed', assigned_agent: 'scribe', completed_at: 100 })],
      total: 90,
    };

    render(<MissionControl />);
    fireEvent.click(screen.getByText('Completed'));

    expect(await screen.findByText('Archived report')).toBeInTheDocument();
    expect(screen.getByText(/Load more \(1 of 90\)/)).toBeInTheDocument();
  });
});
