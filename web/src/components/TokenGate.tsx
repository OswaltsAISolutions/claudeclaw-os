// Token gate shown when the dashboard SPA loads without a valid token in
// either the URL (`?token=...`) or sessionStorage. Without this gate the
// SPA shell renders happily but every `/api/*` call 401s, leaving pages
// like Mission Control showing cryptic "Failed to load: ApiError 401"
// messages with no path forward. This component intercepts the empty-token
// case early and offers two recovery paths:
//   1) paste a token directly (we save to sessionStorage and reload), or
//   2) follow the Telegram deep-link flow (DM /dashboard to the bot).
//
// Why no localStorage: the dashboard token is sensitive (full API surface
// including chat, voice, agents). sessionStorage scopes it to the tab so
// closing the browser revokes the cached copy. Same posture as api.ts.

import { useState } from 'preact/hooks';

export function TokenGate() {
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: Event) {
    e.preventDefault();
    const t = pasted.trim();
    if (!t) {
      setErr('Paste a token first');
      return;
    }
    setBusy(true);
    setErr(null);
    // Validate by hitting a cheap auth-gated endpoint. If it 200s, the
    // token is good; persist and reload so the rest of the app picks it
    // up via api.ts's URL-or-sessionStorage flow.
    try {
      const res = await fetch(`/api/health?token=${encodeURIComponent(t)}`);
      if (res.status === 401) {
        setErr('Token rejected. Check it against DASHBOARD_TOKEN in .env.');
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setErr(`Unexpected response: HTTP ${res.status}`);
        setBusy(false);
        return;
      }
      try { sessionStorage.setItem('claudeclaw.token', t); } catch {}
      // Reload onto a clean URL so subsequent navigations don't carry
      // the token in the address bar (it's now in sessionStorage).
      window.location.replace(window.location.pathname);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setBusy(false);
    }
  }

  return (
    <div class="min-h-screen w-full flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-text)] px-6">
      <div class="max-w-md w-full">
        <div class="text-center mb-6">
          <div class="text-[18px] font-semibold mb-1.5">Dashboard locked</div>
          <div class="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
            This dashboard needs a token to talk to the ClaudeClaw API.
            Your browser session does not have one cached.
          </div>
        </div>

        <form onSubmit={save} class="space-y-3">
          <label class="block">
            <div class="text-[11.5px] uppercase tracking-wide text-[var(--color-text-faint)] mb-1.5">
              Dashboard token
            </div>
            <input
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={pasted}
              onInput={(e) => setPasted((e.target as HTMLInputElement).value)}
              placeholder="paste DASHBOARD_TOKEN from .env"
              class="w-full px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] text-[13px] font-mono outline-none focus:border-[var(--color-accent)]"
            />
          </label>

          {err && (
            <div class="text-[12px] text-[var(--color-status-failed)]">{err}</div>
          )}

          <button
            type="submit"
            disabled={busy}
            class="w-full py-2 rounded-md bg-[var(--color-accent)] text-white text-[13px] font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
          >
            {busy ? 'Verifying…' : 'Unlock'}
          </button>
        </form>

        <div class="mt-6 text-[12px] text-[var(--color-text-muted)] leading-relaxed space-y-2">
          <div>
            <span class="text-[var(--color-text-faint)]">Other ways in:</span>
          </div>
          <ul class="list-disc list-inside space-y-1">
            <li>DM <span class="font-mono">/dashboard</span> to your Telegram bot for a fresh deep link.</li>
            <li>
              Or load the dashboard directly with the token in the URL:
              <span class="font-mono break-all"> /?token=&lt;your-token&gt;</span>
            </li>
            <li>The token lives in <span class="font-mono">.env</span> as <span class="font-mono">DASHBOARD_TOKEN</span>.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
