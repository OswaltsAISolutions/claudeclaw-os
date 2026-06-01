import { Link, useLocation } from 'wouter-preact';
import {
  Sparkles,
  LayoutGrid,
  MessageSquare,
  Users,
  MoreHorizontal,
} from 'lucide-preact';
import { chatUnread } from '@/lib/chat-stream';
import { signal } from '@preact/signals';

/** Whether the "More" sheet is open */
export const moreSheetOpen = signal(false);

interface TabItem {
  path: string;
  label: string;
  icon: typeof Sparkles;
  badge?: () => number;
}

const TABS: TabItem[] = [
  { path: '/', label: 'Home', icon: Sparkles },
  { path: '/mission', label: 'Missions', icon: LayoutGrid },
  { path: '/chat', label: 'Chat', icon: MessageSquare, badge: () => chatUnread.value },
  { path: '/agents', label: 'Agents', icon: Users },
];

/**
 * iOS-style bottom tab bar. Shows on mobile only (md:hidden).
 * Five tabs: Home, Missions, Chat, Agents, More.
 * The "More" tab opens a bottom sheet with the remaining nav items.
 */
export function BottomTabBar() {
  const [pathname] = useLocation();

  // Check if current path matches any of the "more" pages
  const isMoreActive = !['/','/ mission', '/chat', '/agents'].some(
    (p) => pathname === p || (p !== '/' && pathname.startsWith(p))
  ) && pathname !== '/';

  return (
    <nav class="md:hidden fixed bottom-0 inset-x-0 z-50 glass border-t border-[var(--color-border)]"
         style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div class="flex items-stretch justify-around h-[52px]">
        {TABS.map((tab) => {
          const active = tab.path === '/'
            ? pathname === '/'
            : pathname.startsWith(tab.path);
          const Icon = tab.icon;
          const badge = tab.badge?.() ?? 0;
          return (
            <Link
              key={tab.path}
              href={tab.path}
              class="flex-1 flex flex-col items-center justify-center gap-0.5 relative"
            >
              <span class="relative">
                <Icon
                  size={22}
                  class={active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}
                  strokeWidth={active ? 2.2 : 1.8}
                />
                {badge > 0 && (
                  <span class="absolute -top-1 -right-1.5 min-w-[16px] h-[16px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center bg-[var(--color-accent)] text-white shadow-[0_0_6px_var(--color-accent)]">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </span>
              <span
                class={[
                  'text-[10px] font-medium',
                  active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]',
                ].join(' ')}
              >
                {tab.label}
              </span>
            </Link>
          );
        })}

        {/* More tab */}
        <button
          type="button"
          onClick={() => { moreSheetOpen.value = !moreSheetOpen.value; }}
          class="flex-1 flex flex-col items-center justify-center gap-0.5"
        >
          <MoreHorizontal
            size={22}
            class={isMoreActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}
            strokeWidth={isMoreActive ? 2.2 : 1.8}
          />
          <span
            class={[
              'text-[10px] font-medium',
              isMoreActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]',
            ].join(' ')}
          >
            More
          </span>
        </button>
      </div>
    </nav>
  );
}
