import { Link, useLocation } from 'wouter-preact';
import { Search, ChevronDown, X } from 'lucide-preact';
import { ROUTES, SECTION_LABEL, type RouteSection } from '@/lib/routes';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { commandPaletteOpen } from '@/lib/command-palette';
import { chatUnread } from '@/lib/chat-stream';
import { useFetch } from '@/lib/useFetch';
import { sidebarOpen, closeSidebar } from '@/lib/sidebar';
import {
  collapsedSections,
  toggleSectionCollapsed,
  workspaceName,
  modKeyLabel,
} from '@/lib/personalization';

const SECTIONS: RouteSection[] = ['workspace', 'intelligence', 'collaborate', 'configure'];

export function Sidebar() {
  const [pathname] = useLocation();
  const collapsed = collapsedSections.value;
  const modLabel = modKeyLabel();
  const open = sidebarOpen.value;

  // Mobile: fixed drawer that slides in from the left. Desktop (>=md):
  // always-visible inline column. Tailwind's `md:` prefix flips between
  // the two without extra JS.
  // `glass` gives the iOS translucent surface; on themes without
  // glass-tinted --color-sidebar this falls back to the solid bg.
  // Mobile: hidden entirely (bottom tab bar handles nav). Desktop: always visible.
  const asideClass = [
    'glass flex-col h-screen w-[300px] border-r border-[var(--color-border)]',
    'hidden md:flex md:static md:w-[300px] md:shrink-0',
  ].join(' ');

  return (
    <aside class={asideClass}>
      <WorkspaceSwitcher />

      {/* Mobile-only close button. Inline-flex with absolute position so
       *  it doesn't disturb the existing header layout. */}
      <button
        type="button"
        onClick={closeSidebar}
        class="md:hidden absolute top-3 right-3 p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
        aria-label="Close menu"
      >
        <X size={16} />
      </button>

      {/* iOS Spotlight-style search pill — capsule shape, glass surface,
          subtle inner highlight. Tapping opens the command palette. */}
      <button
        type="button"
        onClick={() => { commandPaletteOpen.value = true; closeSidebar(); }}
        class="press-target mx-4 mt-2 mb-3 flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)] transition-all text-[14px]"
      >
        <Search size={15} />
        <span>Search</span>
        <span class="ml-auto text-[11px] text-[var(--color-text-faint)] tabular-nums">{modLabel}K</span>
      </button>

      <nav class="flex-1 overflow-y-auto px-3 pb-3">
        {SECTIONS.map((section) => {
          const items = ROUTES.filter((r) => r.section === section);
          if (items.length === 0) return null;
          const isCollapsed = collapsed.has(section);
          return (
            <div key={section} class="mt-4 first:mt-2">
              <button
                type="button"
                onClick={() => toggleSectionCollapsed(section)}
                class="w-full flex items-center gap-2 px-3 py-2 section-label hover:text-[var(--color-text-muted)] transition-colors group"
                aria-expanded={!isCollapsed}
              >
                <ChevronDown
                  size={12}
                  class="text-[var(--color-text-faint)] transition-transform"
                  style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                />
                <span>{SECTION_LABEL[section]}</span>
              </button>
              {!isCollapsed && items.map((r) => {
                // Strict path match — only the current route's row lights up.
                // Previous fallback that also activated /mission when pathname
                // was '/' is dead leftover from when Mission Control was the
                // root route; JARVIS now owns '/' and both rows were lighting
                // up together.
                const active = pathname === r.path;
                const Icon = r.icon;
                const unread = r.path === '/chat' ? chatUnread.value : 0;
                // iOS app-tile pattern: icon sits in a 28px rounded-bubble
                // container with its own bg color. Active state lights up
                // the bubble in the accent color and tints the row.
                return (
                  <Link
                    key={r.path}
                    href={r.path}
                    onClick={closeSidebar}
                    class={[
                      'press-target flex items-center gap-3 px-2.5 py-2 my-1 rounded-2xl text-[15px] transition-colors',
                      active
                        ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)]',
                    ].join(' ')}
                  >
                    <span
                      class={[
                        'inline-flex items-center justify-center w-8 h-8 rounded-xl shrink-0 transition-colors',
                        active
                          ? 'bg-[var(--color-accent)] text-white shadow-[0_2px_6px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]'
                          : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)]',
                      ].join(' ')}
                    >
                      <Icon size={17} />
                    </span>
                    <span class="flex-1 font-medium">{r.label}</span>
                    {unread > 0 && (
                      <span class="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full text-[11px] font-semibold tabular-nums bg-[var(--color-accent)] text-white shadow-[0_1px_3px_rgba(0,0,0,0.35)]">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <SidebarFooter />
    </aside>
  );
}

interface Health { killSwitches: Record<string, boolean>; }

function SidebarFooter() {
  const { data } = useFetch<Health>('/api/health', 30_000);
  const switches = data?.killSwitches || {};
  const off = Object.entries(switches).filter(([, on]) => !on);
  const anyOff = off.length > 0;
  const name = workspaceName.value;
  return (
    <Link
      href="/settings"
      class="press-target mx-3 mb-3 px-3 py-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-elevated)] text-[12px] text-[var(--color-text-faint)] hover:border-[var(--color-border-strong)] transition-all"
    >
      <div class="flex items-center gap-3">
        <div
          class="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-[14px] shrink-0 shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
          style={{
            background: anyOff
              ? 'linear-gradient(180deg, var(--color-status-failed), color-mix(in srgb, var(--color-status-failed) 80%, black))'
              : 'linear-gradient(180deg, var(--color-accent), var(--color-accent-hover))',
            color: '#ffffff',
          }}
        >
          {(name || 'J').charAt(0).toUpperCase()}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[var(--color-text)] text-[13px] font-semibold truncate">{name}</div>
          <div class="truncate text-[11px]">
            {anyOff
              ? off.length + ' kill switch' + (off.length === 1 ? '' : 'es') + ' off'
              : 'All systems normal'}
          </div>
        </div>
      </div>
    </Link>
  );
}
