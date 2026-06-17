import { useState } from 'preact/hooks';
import { ExternalLink, RefreshCw, Bookmark, Home, Camera } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';

// Live X / Instagram feeds, served by the self-hosted neko Chromium
// container (docker/neko). X and IG cannot be iframed directly, but our
// own streamed browser showing them can. Gabe logs in once inside it;
// the session persists in the container's profile volume.
//
// The container listens on 127.0.0.1:8081. On the phone it rides the same
// Tailscale host the dashboard already uses, so we derive the neko origin
// from the current window host rather than hardcoding localhost.

function nekoOrigin(): string {
  const host = window.location.hostname || '127.0.0.1';
  return `http://${host}:8081/`;
}

const QUICK_NAV = [
  { label: 'X Home', icon: Home, url: 'https://x.com/home' },
  { label: 'X Bookmarks', icon: Bookmark, url: 'https://x.com/i/bookmarks' },
  { label: 'Instagram', icon: Camera, url: 'https://www.instagram.com/' },
  { label: 'IG Saved', icon: Bookmark, url: 'https://www.instagram.com/' },
];

export function Feeds() {
  const [origin] = useState(nekoOrigin());
  const [reloadKey, setReloadKey] = useState(0);
  const [down, setDown] = useState(false);

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Feeds"
        actions={
          <div class="flex items-center gap-2">
            {QUICK_NAV.map((n) => (
              <a key={n.label} href={n.url} target="_blank" rel="noreferrer"
                class="press-target hidden md:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[12px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                title={`Open ${n.label} in a normal tab`}>
                <n.icon size={12} /> {n.label}
              </a>
            ))}
            <button type="button" onClick={() => setReloadKey((k) => k + 1)}
              class="press-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[12px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
              <RefreshCw size={12} /> Reload
            </button>
          </div>
        }
      />

      <div class="flex-1 min-h-0 px-4 md:px-6 pb-4">
        {down ? (
          <div class="h-full flex items-center justify-center">
            <div class="max-w-md text-center space-y-3">
              <div class="text-[14px] font-semibold text-[var(--color-text)]">Feed browser not reachable</div>
              <div class="text-[12px] text-[var(--color-text-muted)]">
                The streamed browser container (neko) is not responding at {origin}. Start it with
                <code class="mx-1 px-1.5 py-0.5 rounded bg-[var(--color-elevated)] text-[11px]">cd docker/neko && docker compose up -d</code>,
                then Reload. First time, open it once at the admin login to sign into X and Instagram.
              </div>
              <a href={origin} target="_blank" rel="noreferrer"
                class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
                <ExternalLink size={12} /> Open in a tab
              </a>
            </div>
          </div>
        ) : (
          <iframe
            key={reloadKey}
            src={origin}
            class="w-full h-full rounded-[16px] border border-[var(--color-border)] bg-black"
            allow="autoplay; clipboard-read; clipboard-write; fullscreen; microphone; camera"
            onError={() => setDown(true)}
          />
        )}
      </div>
    </div>
  );
}
