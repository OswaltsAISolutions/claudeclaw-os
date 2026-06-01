import { describe, it, expect, vi } from 'vitest';
import { filterActions, buildActions, type PaletteAction } from './command-palette';
import { ROUTES } from './routes';

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

// buildActions assembles the palette's action list from ROUTES + fixed
// Actions/Theme entries. The parity + wiring here is what silently breaks
// when a route is added/removed or a deep-link target is renamed, so we pin
// the contract against ROUTES rather than a hardcoded copy.
describe('buildActions', () => {
  it('emits one Navigation action per route, in route order', () => {
    const navIds = buildActions()
      .filter((a) => a.group === 'Navigation')
      .map((a) => a.id);
    expect(navIds).toEqual(ROUTES.map((r) => 'nav:' + r.path));
  });

  it('appends the Actions then Theme groups after Navigation', () => {
    const groups = buildActions().map((a) => a.group);
    const navCount = ROUTES.length;
    expect(groups.slice(0, navCount).every((g) => g === 'Navigation')).toBe(true);
    expect(groups.slice(navCount)).toEqual(['Actions', 'Actions', 'Theme', 'Theme', 'Theme']);
  });

  it('wires every nav action to navigate to its own route path', () => {
    const navigate = vi.fn();
    for (const a of buildActions().filter((x) => x.group === 'Navigation')) {
      navigate.mockClear();
      a.run({ navigate });
      expect(navigate).toHaveBeenCalledWith(a.id.slice('nav:'.length));
    }
  });

  it('uppercases a route shortcut into the hint, leaving shortcutless routes hintless', () => {
    const actions = buildActions();
    expect(actions.find((a) => a.id === 'nav:/')!.hint).toBe('G J'); // shortcut 'g j'
    expect(actions.find((a) => a.id === 'nav:/audit')!.hint).toBeUndefined(); // no shortcut
  });

  it('points the quick-create actions at the right deep links', () => {
    const navigate = vi.fn();
    const actions = buildActions();
    actions.find((a) => a.id === 'action:new-task')!.run({ navigate });
    expect(navigate).toHaveBeenCalledWith('/mission?new=1');
    navigate.mockClear();
    actions.find((a) => a.id === 'action:new-agent')!.run({ navigate });
    expect(navigate).toHaveBeenCalledWith('/agents?new=1');
  });

  it('exposes a Theme action per theme', () => {
    const themeIds = buildActions()
      .filter((a) => a.group === 'Theme')
      .map((a) => a.id);
    expect(themeIds).toEqual(['theme:graphite', 'theme:midnight', 'theme:crimson']);
  });
});
