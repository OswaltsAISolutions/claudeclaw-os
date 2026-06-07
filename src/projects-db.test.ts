import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  createProject, getProject, listProjects, updateProject, deleteProject,
  createProjectItem, getProjectItems, getProjectItem, updateProjectItem, deleteProjectItem,
} from './db.js';

// The Workspace hub persists in two tables: projects + project_items (a single
// flexible store discriminated by kind = goal/task/research). These lock the
// CRUD, the summary counts the list endpoint depends on, the archive filter,
// the research status write-back path the scheduler uses, and the cascade.
describe('workspace: projects + project_items', () => {
  beforeEach(() => { _initTestDatabase(); });

  it('creates and reads a project with defaults', () => {
    createProject('p1', 'Research X', 'a desc', 'jarvis instructions');
    const p = getProject('p1');
    expect(p?.name).toBe('Research X');
    expect(p?.status).toBe('active');
    expect(p?.description).toBe('a desc');
    expect(p?.instructions).toBe('jarvis instructions');
  });

  it('summarizes goal/task/research counts for the list', () => {
    createProject('p1', 'Alpha');
    createProjectItem('g1', 'p1', 'goal', { title: 'goal a', status: 'open' });
    createProjectItem('t1', 'p1', 'task', { title: 'task a', status: 'done' });
    createProjectItem('t2', 'p1', 'task', { title: 'task b', status: 'open' });
    createProjectItem('r1', 'p1', 'research', { category: 'note', title: 'note a' });
    const p1 = listProjects().find((p) => p.id === 'p1')!;
    expect(p1.goal_count).toBe(1);
    expect(p1.task_count).toBe(2);
    expect(p1.task_done_count).toBe(1);
    expect(p1.research_count).toBe(1);
  });

  it('hides archived projects by default and includes them on request', () => {
    createProject('p1', 'Active one');
    createProject('p2', 'Archived one');
    updateProject('p2', { status: 'archived' });
    expect(listProjects().map((p) => p.id)).toEqual(['p1']);
    expect(listProjects(true).map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('updates a project and keeps updated_at monotonic', () => {
    createProject('p1', 'Old name');
    const before = getProject('p1')!.updated_at;
    expect(updateProject('p1', { name: 'New name', color: 'amber' })).toBe(true);
    const after = getProject('p1')!;
    expect(after.name).toBe('New name');
    expect(after.color).toBe('amber');
    expect(after.updated_at).toBeGreaterThanOrEqual(before);
  });

  it('flips a research item from running to done (the scheduler write-back path)', () => {
    createProject('p1', 'P');
    createProjectItem('r1', 'p1', 'research', { category: 'analysis', title: 'Q', content: 'researching...', status: 'running' });
    expect(getProjectItem('r1')!.status).toBe('running');
    updateProjectItem('r1', { content: 'final report', status: 'done' });
    const item = getProjectItem('r1')!;
    expect(item.status).toBe('done');
    expect(item.content).toBe('final report');
  });

  it('filters items by kind', () => {
    createProject('p1', 'P');
    createProjectItem('g1', 'p1', 'goal', { title: 'g' });
    createProjectItem('t1', 'p1', 'task', { title: 't' });
    expect(getProjectItems('p1', 'goal').map((i) => i.id)).toEqual(['g1']);
    expect(getProjectItems('p1', 'task').map((i) => i.id)).toEqual(['t1']);
    expect(getProjectItems('p1').length).toBe(2);
  });

  it('deletes a project and cascades its items', () => {
    createProject('p1', 'P');
    createProjectItem('i1', 'p1', 'goal', { title: 'g' });
    expect(deleteProject('p1')).toBe(true);
    expect(getProject('p1')).toBeNull();
    expect(getProjectItems('p1').length).toBe(0);
  });

  it('deletes a single item without touching the project', () => {
    createProject('p1', 'P');
    createProjectItem('i1', 'p1', 'task', { title: 't' });
    expect(deleteProjectItem('i1')).toBe(true);
    expect(getProjectItem('i1')).toBeNull();
    expect(getProject('p1')).not.toBeNull();
  });
});
