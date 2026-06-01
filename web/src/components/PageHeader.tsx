import type { ComponentChildren } from 'preact';

export interface PageHeaderProps {
  title: string;
  breadcrumb?: string;
  actions?: ComponentChildren;
  tabs?: ComponentChildren;
}

/**
 * Unified iOS-style page header. ONE mode for every tab (the previous
 * largeTitle/compact split is gone) so titles sit at the same y-coordinate,
 * same size, same weight across the whole dashboard.
 *
 * Layout: 3-column CSS grid (breadcrumb | title | actions) where the
 * left + right columns each take 1fr of available space. This keeps the
 * title GEOMETRICALLY centered regardless of how wide the action chips
 * get on the right side — the macOS-toolbar pattern.
 *
 * The JARVIS tab uses no PageHeader (the orb is the centerpiece). Every
 * other tab uses this component as the single header treatment.
 */
export function PageHeader({ title, breadcrumb, actions, tabs }: PageHeaderProps) {
  return (
    <div class="glass border-b border-[var(--color-border)] sticky top-0 z-20">
      <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-6 md:px-8 py-[18px]">
        {/* Left: breadcrumb (or empty spacer) */}
        <div class="flex items-center gap-2 text-[13.5px] text-[var(--color-text-muted)] justify-self-start min-w-0 truncate">
          {breadcrumb && (
            <>
              <span class="truncate">{breadcrumb}</span>
              <span class="text-[var(--color-text-faint)] shrink-0">›</span>
            </>
          )}
        </div>

        {/* Center: title — same size and position on every tab */}
        <h1
          class="font-bold text-[var(--color-text)] tracking-tight text-center leading-tight whitespace-nowrap"
          style={{ fontSize: 'clamp(22px, 2.6vmin, 28px)' }}
        >
          {title}
        </h1>

        {/* Right: actions (or empty spacer) */}
        <div class="flex items-center gap-2.5 justify-self-end min-w-0">
          {actions}
        </div>
      </div>

      {/* Optional tabs row — centered below the title */}
      {tabs && (
        <div class="px-6 md:px-8 pb-3 md:pb-4 flex justify-center">
          <div class="inline-flex items-center gap-0.5 p-1 rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)]">
            {tabs}
          </div>
        </div>
      )}
    </div>
  );
}

export interface TabProps {
  label: string;
  active?: boolean;
  count?: number;
  onClick?: () => void;
}

/**
 * iOS segmented-control tab. Rendered inside the PageHeader's capsule
 * track. Active state fills the pill with the card surface; inactive
 * sits flat. Press-scale for tactile feel.
 */
export function Tab({ label, active, count, onClick }: TabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={[
        'press-target px-4 md:px-5 py-2 rounded-full text-[13px] md:text-[14px] font-semibold transition-all flex items-center gap-1.5',
        active
          ? 'bg-[var(--color-card)] text-[var(--color-text)] shadow-[0_1px_3px_rgba(0,0,0,0.3)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
      ].join(' ')}
    >
      {label}
      {typeof count === 'number' && (
        <span class={[
          'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums',
          active ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-border)] text-[var(--color-text-faint)]',
        ].join(' ')}>{count}</span>
      )}
    </button>
  );
}
