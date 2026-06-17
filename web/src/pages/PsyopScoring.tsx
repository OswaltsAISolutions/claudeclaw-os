import { useState } from 'preact/hooks';

import { Pill, StatusDot, type Tone } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiDelete } from '@/lib/api';

// Mirrors src/psyop-scorer.ts PsyopScoreResult + the db row.
interface PsyopItemScore { id: number; category: string; score: number; evidence: string }
interface PsyopScoreResult {
  subject: string;
  items: PsyopItemScore[];
  total: number;
  band: 'low' | 'moderate' | 'strong' | 'overwhelming';
  bandLabel: string;
  truthAgendaNote: string | null;
  localModel: string | null;
  verifyModel: string | null;
  disclaimer: string;
}
interface PsyopScoreRow {
  id: string;
  subject: string;
  input_text: string | null;
  source_url: string | null;
  status: string;
  total: number | null;
  band: string | null;
  final_json: string | null;
  model_local: string | null;
  model_verify: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const BAND_TONE: Record<string, Tone> = {
  low: 'done', moderate: 'medium', strong: 'high', overwhelming: 'failed',
};

function parseResult(row: PsyopScoreRow): PsyopScoreResult | null {
  if (!row.final_json) return null;
  try { return JSON.parse(row.final_json) as PsyopScoreResult; } catch { return null; }
}

function scoreColor(score: number): string {
  if (score >= 4) return 'var(--color-status-failed)';
  if (score === 3) return 'var(--color-priority-medium)';
  return 'var(--color-text-faint)';
}

function ScoreBar({ score }: { score: number }) {
  return (
    <span class="inline-flex gap-0.5 shrink-0" title={`${score}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          class="w-2.5 h-2.5 rounded-[3px]"
          style={{ backgroundColor: n <= score ? scoreColor(score) : 'var(--color-elevated)' }}
        />
      ))}
    </span>
  );
}

export function PsyopScoring() {
  const { data, loading, refresh } = useFetch<{ scores: PsyopScoreRow[] }>('/api/psyop/scores', 4000);
  const scores = data?.scores ?? [];

  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function submit() {
    if (!subject.trim() || text.trim().length < 20) {
      setErr('Add a subject label and at least a few sentences of material to score.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await apiPost<{ score: PsyopScoreRow }>('/api/psyop/score', {
        subject: subject.trim(), text: text.trim(), source_url: sourceUrl.trim() || undefined,
      });
      setSubject(''); setText(''); setSourceUrl('');
      setOpenId(res.score.id);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try { await apiDelete(`/api/psyop/scores/${id}`); if (openId === id) setOpenId(null); refresh(); } catch { /* ignore */ }
  }

  return (
    <div class="h-full overflow-y-auto px-4 md:px-8 py-6 max-w-4xl mx-auto">
      <header class="mb-5">
        <h1 class="text-xl font-semibold flex items-center gap-2">Psyop Score</h1>
        <p class="text-sm text-[var(--color-text-muted)] mt-1">
          Chase Hughes' NCI Engineered Reality Scoring System — 20 patterns, scored 1–5, total 20–100.
          A local uncensored model scores it, then a cloud model verifies. It rates manipulation
          <em> form</em>, not truth: a high score means the narrative is engineered, not that its claim is false.
        </p>
      </header>

      {/* Input */}
      <div class="rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] p-4 mb-6 space-y-3">
        <input
          class="w-full bg-[var(--color-elevated)] rounded-lg px-3 py-2 text-sm outline-none border border-transparent focus:border-[var(--color-accent)]"
          placeholder="Subject — what are you scoring? (e.g. 'WHO pandemic-treaty push')"
          value={subject}
          onInput={(e) => setSubject((e.target as HTMLInputElement).value)}
        />
        <textarea
          class="w-full bg-[var(--color-elevated)] rounded-lg px-3 py-2 text-sm outline-none border border-transparent focus:border-[var(--color-accent)] min-h-[140px] resize-y"
          placeholder="Paste the claim, article, or transcript to score. The score is only as good as what it sees — paste the substance, not a summary."
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
        <input
          class="w-full bg-[var(--color-elevated)] rounded-lg px-3 py-2 text-sm outline-none border border-transparent focus:border-[var(--color-accent)]"
          placeholder="Source URL (optional)"
          value={sourceUrl}
          onInput={(e) => setSourceUrl((e.target as HTMLInputElement).value)}
        />
        {err && <p class="text-sm text-[var(--color-status-failed)]">{err}</p>}
        <div class="flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            class="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-semibold disabled:opacity-50"
          >
            {busy ? 'Scoring…' : 'Run NCI score'}
          </button>
        </div>
      </div>

      {/* History */}
      {loading && scores.length === 0 && <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>}
      {!loading && scores.length === 0 && (
        <p class="text-sm text-[var(--color-text-muted)]">No scores yet. Paste something above to run the first one.</p>
      )}

      <div class="space-y-3">
        {scores.map((row) => {
          const result = parseResult(row);
          const open = openId === row.id;
          const tone: Tone = row.band ? (BAND_TONE[row.band] ?? 'neutral') : 'neutral';
          return (
            <div key={row.id} class="rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : row.id)}
                class="w-full flex items-center gap-3 px-4 py-3 text-left"
              >
                <div class="min-w-0 flex-1">
                  <div class="font-medium truncate">{row.subject}</div>
                  <div class="text-xs text-[var(--color-text-muted)] mt-0.5 flex items-center gap-2">
                    {row.status === 'scoring' && (<><StatusDot tone="running" /> scoring…</>)}
                    {row.status === 'failed' && (<span class="text-[var(--color-status-failed)]">failed</span>)}
                    {row.status === 'ready' && row.final_json && (
                      <span>{result?.verifyModel ? `verified by ${result.verifyModel.replace('claude-', '')}` : 'ready'}</span>
                    )}
                  </div>
                </div>
                {row.status === 'ready' && row.total != null && (
                  <div class="flex items-center gap-3 shrink-0">
                    <span class="text-2xl font-bold tabular-nums">{row.total}<span class="text-sm text-[var(--color-text-faint)]">/100</span></span>
                    <Pill tone={tone}>{row.band}</Pill>
                  </div>
                )}
              </button>

              {open && (
                <div class="px-4 pb-4 border-t border-[var(--color-border)] pt-3">
                  {row.status === 'failed' && (
                    <p class="text-sm text-[var(--color-status-failed)]">{row.error || 'scoring failed'}</p>
                  )}
                  {row.status === 'scoring' && (
                    <p class="text-sm text-[var(--color-text-muted)]">Local pass + cloud verify usually takes a minute or two. This panel refreshes itself.</p>
                  )}
                  {result && (
                    <>
                      <p class="text-sm mb-1"><span class="font-semibold">{result.bandLabel}</span></p>
                      {result.truthAgendaNote && (
                        <p class="text-sm text-[var(--color-priority-medium)] mb-2">{result.truthAgendaNote}</p>
                      )}
                      <div class="space-y-1.5 my-3">
                        {[...result.items].sort((a, b) => b.score - a.score).map((it) => (
                          <div key={it.id} class="flex items-start gap-3 text-sm">
                            <ScoreBar score={it.score} />
                            <div class="min-w-0">
                              <span class="font-medium">{it.category}</span>
                              <span class="text-[var(--color-text-muted)]"> — {it.evidence}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <p class="text-xs text-[var(--color-text-faint)] mt-3 italic">{result.disclaimer}</p>
                      {row.source_url && (
                        <a href={row.source_url} target="_blank" rel="noreferrer" class="text-xs text-[var(--color-accent)] block mt-2 truncate">{row.source_url}</a>
                      )}
                    </>
                  )}
                  <div class="flex justify-end mt-3">
                    <button type="button" onClick={() => void remove(row.id)} class="text-xs text-[var(--color-text-faint)] hover:text-[var(--color-status-failed)]">Delete</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
