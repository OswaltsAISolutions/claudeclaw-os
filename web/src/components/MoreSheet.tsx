import { Link, useLocation } from 'wouter-preact';
import { ROUTES } from '@/lib/routes';
import { moreSheetOpen } from './BottomTabBar';

/**
 * iOS-style bottom sheet that slides up when "More" is tapped in the
 * tab bar. Shows all nav items that don't have their own tab.
 * Includes a drag handle, rounded top corners, backdrop blur.
 */

// Paths that already have dedicated tabs — exclude from More
const TAB_PATHS = new Set(['/', '/mission', '/chat', '/agents']);

export function MoreSheet() {
  const open = moreSheetOpen.value;
  const [pathname] = useLocation();

  const moreRoutes = ROUTES.filter((r) => !TAB_PATHS.has(r.path));

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        class="md:hidden fixed inset-0 z-[60] bg-black/50 animate-modal-fade"
        onClick={() => { moreSheetOpen.value = false; }}
      />

      {/* Sheet */}
      <div
        class="md:hidden fixed bottom-0 inset-x-0 z-[70] glass rounded-t-[20px] border-t border-[var(--color-border)] overflow-hidden"
        style={{
          maxHeight: '70vh',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 60px)',
          animation: 'sheet-slide-up 280ms cubic-bezier(0.34, 1.32, 0.64, 1)',
        }}
      >
        {/* Drag handle */}
        <div class="flex justify-center pt-3 pb-2">
          <div class="w-9 h-1 rounded-full bg-[var(--color-text-faint)] opacity-50" />
        </div>

        {/* Title */}
        <div class="px-5 pb-3">
          <h2 class="text-[17px] font-bold text-[var(--color-text)]">More</h2>
        </div>

        {/* Nav grid */}
        <div class="px-4 pb-4 grid grid-cols-4 gap-3 overflow-y-auto">
          {moreRoutes.map((r) => {
            const Icon = r.icon;
            const active = pathname === r.path;
            return (
              <Link
                key={r.path}
                href={r.path}
                onClick={() => { moreSheetOpen.value = false; }}
                class="press-target flex flex-col items-center gap-1.5 py-3 px-1 rounded-2xl transition-colors"
              >
                <span
                  class={[
                    'inline-flex items-center justify-center w-11 h-11 rounded-[14px] transition-all',
                    active
                      ? 'bg-[var(--color-accent)] text-white shadow-[0_2px_8px_color-mix(in_srgb,var(--color-accent)_50%,transparent)]'
                      : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)]',
                  ].join(' ')}
                >
                  <Icon size={20} />
                </span>
                <span
                  class={[
                    'text-[11px] font-medium text-center leading-tight',
                    active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]',
                  ].join(' ')}
                >
                  {r.label}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
