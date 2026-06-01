import type { ComponentChildren } from 'preact';

export interface CardGroupProps {
  /** Section title shown above the card group (like iOS Settings headers) */
  title?: string;
  /** Optional footer text below the group (like iOS Settings footers) */
  footer?: string;
  children: ComponentChildren;
  class?: string;
}

/**
 * iOS Settings-style inset card group. Renders children inside a rounded
 * container with consistent padding. Items inside are separated by
 * hairline borders. Use with CardRow for the full iOS look.
 *
 * Example:
 * ```
 * <CardGroup title="GENERAL">
 *   <CardRow label="Model" value="Opus 4.7" />
 *   <CardRow label="Status" value="Online" />
 * </CardGroup>
 * ```
 */
export function CardGroup({ title, footer, children, class: cls }: CardGroupProps) {
  return (
    <div class={cls}>
      {title && (
        <div class="px-5 pb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-faint)]">
          {title}
        </div>
      )}
      <div class="rounded-2xl bg-[var(--color-card)] border border-[var(--color-border)] overflow-hidden divide-y divide-[var(--color-border)]">
        {children}
      </div>
      {footer && (
        <div class="px-5 pt-2 text-[12px] text-[var(--color-text-faint)] leading-relaxed">
          {footer}
        </div>
      )}
    </div>
  );
}

export interface CardRowProps {
  /** Left-side label */
  label: string;
  /** Optional inline hint shown directly below the label (small muted text) */
  description?: string;
  /** Right-side value or content */
  value?: string | ComponentChildren;
  /** Optional icon on the left */
  icon?: ComponentChildren;
  /** If true, shows a chevron indicating it's tappable */
  chevron?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Destructive styling (red text) */
  destructive?: boolean;
}

/**
 * A single row inside a CardGroup. Mimics the iOS Settings row pattern:
 *   icon | label ............. value >
 *          description
 */
export function CardRow({ label, description, value, icon, chevron, onClick, destructive }: CardRowProps) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      class={[
        'w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors',
        onClick ? 'press-target hover:bg-[var(--color-elevated)]' : '',
      ].join(' ')}
    >
      {icon && (
        <span class="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-elevated)] text-[var(--color-text-muted)] shrink-0">
          {icon}
        </span>
      )}
      <div class="flex-1 min-w-0">
        <div class={[
          'text-[15px] leading-tight',
          destructive ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text)]',
        ].join(' ')}>
          {label}
        </div>
        {description && (
          <div class="text-[12px] text-[var(--color-text-faint)] mt-1 leading-snug">
            {description}
          </div>
        )}
      </div>
      {value && (
        <span class="text-[15px] text-[var(--color-text-muted)] shrink-0">
          {value}
        </span>
      )}
      {chevron && (
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none" class="text-[var(--color-text-faint)] shrink-0 ml-1">
          <path d="M1 1l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      )}
    </Tag>
  );
}
