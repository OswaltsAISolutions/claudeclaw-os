import { describe, it, expect } from 'vitest';
import { ROUTES, SECTION_LABEL, DEFAULT_ROUTE } from './routes';

// ROUTES is the single source of truth for the sidebar, command palette,
// and router. The table is hand-edited, so the failure modes are silent:
// a duplicate path makes a route ambiguous, a duplicate shortcut steals a
// hotkey from another route, a section with no SECTION_LABEL renders an
// empty group header, and a DEFAULT_ROUTE that isn't in the table breaks
// the unknown-path fallback. These invariants fail loudly on a bad edit.
describe('ROUTES invariants', () => {
  it('has unique paths', () => {
    const paths = ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('has unique keyboard shortcuts', () => {
    const shortcuts = ROUTES.map((r) => r.shortcut).filter((s): s is string => !!s);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('gives every route section a display label', () => {
    for (const r of ROUTES) {
      expect(SECTION_LABEL[r.section]).toBeTruthy();
    }
  });

  it('points DEFAULT_ROUTE at a real route', () => {
    expect(ROUTES.some((r) => r.path === DEFAULT_ROUTE)).toBe(true);
  });

  it('gives every route a rooted path and a non-empty label', () => {
    for (const r of ROUTES) {
      expect(r.path.startsWith('/')).toBe(true);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });
});
