import { describe, it, expect } from 'vitest';
import { filterActions, type PaletteAction } from './command-palette';

const noop = () => {};
const actions: PaletteAction[] = [
  { id: 'nav:/mission', label: 'Mission Control', group: 'Navigation', run: noop },
  { id: 'action:new-task', label: 'New mission task', group: 'Actions', run: noop },
  { id: 'theme:midnight', label: 'Theme: Midnight', group: 'Theme', run: noop },
];

const labels = (xs: PaletteAction[]) => xs.map((a) => a.label);

describe('filterActions', () => {
  it('returns the original list (same reference) for an empty or whitespace query', () => {
    expect(filterActions('', actions)).toBe(actions);
    expect(filterActions('   ', actions)).toBe(actions);
  });

  it('matches when every whitespace token appears in the label, order-independent', () => {
    expect(labels(filterActions('new task', actions))).toEqual(['New mission task']);
    expect(labels(filterActions('task new', actions))).toEqual(['New mission task']);
  });

  it('matches a single substring token across multiple labels', () => {
    expect(labels(filterActions('mission', actions))).toEqual([
      'Mission Control',
      'New mission task',
    ]);
  });

  it('falls back to initials matching', () => {
    expect(labels(filterActions('mc', actions))).toEqual(['Mission Control']);
    // Initials split on whitespace AND colons, so "Theme: Midnight" -> "tm".
    expect(labels(filterActions('tm', actions))).toEqual(['Theme: Midnight']);
  });

  it('is case-insensitive', () => {
    expect(labels(filterActions('MISSION', actions))).toEqual([
      'Mission Control',
      'New mission task',
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterActions('zzz', actions)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const before = [...actions];
    filterActions('mission', actions);
    expect(actions).toEqual(before);
  });
});
