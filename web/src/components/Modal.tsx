import { useEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { X } from 'lucide-preact';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number;
  children: ComponentChildren;
  footer?: ComponentChildren;
}

/**
 * iOS-style sheet modal. Glass surface with backdrop-blur, large
 * rounded corners (28px), iOS soft shadow. Backdrop is a translucent
 * blur of the whole page so the modal genuinely floats above it.
 * Title bar uses iOS-display weight; close button is a capsule chip.
 */
export function Modal({ open, onClose, title, width = 520, children, footer }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      class="fixed inset-0 z-[90] flex items-start justify-center pt-[12vh] animate-modal-fade"
      style={{
        backdropFilter: 'blur(12px) saturate(120%)',
        WebkitBackdropFilter: 'blur(12px) saturate(120%)',
        background: 'rgba(0, 0, 0, 0.42)',
      }}
      onClick={onClose}
    >
      <div
        class="glass rounded-[28px] flex flex-col max-h-[80vh] animate-modal-pop"
        style={{
          width: width + 'px',
          maxWidth: '92vw',
          boxShadow: 'var(--shadow-glass)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center px-6 py-4 border-b border-[var(--color-border)] shrink-0">
          <h2 class="text-[17px] font-semibold text-[var(--color-text)] tracking-tight">{title}</h2>
          <button
            type="button"
            class="press-target ml-auto inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <div class="flex items-center gap-2 px-6 py-4 border-t border-[var(--color-border)] shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * iOS-style bottom sheet. Slides up from the bottom with a grab-handle
 * at the top (iOS pattern). Backdrop blurs the page beneath.
 */
export function Drawer({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <div
        class={[
          'fixed inset-0 z-[80] transition-opacity duration-300',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        style={{
          backdropFilter: open ? 'blur(12px) saturate(120%)' : 'none',
          WebkitBackdropFilter: open ? 'blur(12px) saturate(120%)' : 'none',
          background: 'rgba(0, 0, 0, 0.42)',
        }}
        onClick={onClose}
      />
      <div
        class={[
          'glass fixed left-0 right-0 bottom-0 z-[81] rounded-t-[28px] flex flex-col transition-transform duration-300',
          open ? 'translate-y-0' : 'translate-y-full',
        ].join(' ')}
        style={{ height: '85vh', boxShadow: 'var(--shadow-glass)' }}
      >
        {/* iOS grab handle */}
        <div class="pt-2.5 pb-1 flex justify-center shrink-0">
          <div class="w-9 h-1 rounded-full bg-[var(--color-border-strong)]" />
        </div>
        <div class="flex items-center px-6 pb-3 border-b border-[var(--color-border)] shrink-0">
          <h2 class="text-[15px] font-semibold text-[var(--color-text)] tracking-tight">{title}</h2>
          <button
            type="button"
            class="press-target ml-auto inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
