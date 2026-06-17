// AI agency demo generators. First product: the DAY-BEFORE service notice
// (Good Nature's actual stated problem, per Gabe 2026-06-10: the current
// day-before text only says "we'll be out", it does NOT say which service.
// They want it automated from the account + the tech routes, including the
// Friday quirk where Friday texts cover both Saturday and Monday visits).
// A second mode generates after-service recap texts (upsell material).
//
// Input: a pasted route sheet (CSV / TSV / pipe lines, header optional).
// Output: one friendly, specific SMS per customer, generated in a single
// scribe call, stored as a client artifact so the pitch demo is replayable.
// Honest by design: rows that fail to parse are reported, never invented;
// the model is forbidden from inventing policies or appointment details.

import { createClientArtifact, getClient, type ClientArtifact } from './db.js';
import { exportArtifactDocs } from './clients-export.js';
import { delegate } from './specialists.js';
import { logger } from './logger.js';

const log = (msg: string) => logger.info({ scope: 'clients' }, msg);

export interface RouteRow {
  customer: string;
  address?: string;
  services: string;
  tech?: string;
  notes?: string;
  visitDay?: string;   // per-row override: "Saturday" / "Monday" (Friday sends cover both)
}

const MAX_ROWS = 25;

/** Liberal route-sheet parser: detects delimiter, tolerates a header row. */
export function parseRouteSheet(raw: string): { rows: RouteRow[]; skipped: string[] } {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows: RouteRow[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const delim = line.includes('\t') ? '\t' : line.includes('|') ? '|' : ',';
    const parts = line.split(delim).map((p) => p.trim());
    // Header detection: first cell looks like a column label.
    if (/^(customer|client|name)s?$/i.test(parts[0] ?? '')) continue;
    if (parts.length < 2 || !parts[0]) {
      skipped.push(line.slice(0, 80));
      continue;
    }
    rows.push({
      customer: parts[0],
      address: parts.length >= 3 ? parts[1] : undefined,
      services: parts.length >= 3 ? parts[2] : parts[1],
      tech: parts[3] || undefined,
      notes: parts[4] || undefined,
      visitDay: parts[5] || undefined,
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return { rows, skipped };
}

interface GeneratedText {
  i: number;
  customer: string;
  sms: string;
}

export type DemoMode = 'day_before' | 'after_service';

/**
 * Generate per-customer service texts in one scribe call and persist the
 * batch as a client artifact. Returns the artifact (content = full JSON).
 *
 * mode 'day_before' (default, the Good Nature problem): "we'll be out
 * <visitDay> and here is the specific service planned for your account".
 * visitDay defaults to "tomorrow"; a per-row 6th column overrides it (the
 * Friday send covers both "Saturday" and "Monday" visits).
 * mode 'after_service': same-day completion recap.
 */
export async function generateServiceTexts(
  clientId: string,
  businessName: string,
  rawSheet: string,
  mode: DemoMode = 'day_before',
  visitDay = 'tomorrow',
): Promise<{ artifact: ClientArtifact; messages: GeneratedText[]; skipped: string[]; mode: DemoMode }> {
  const { rows, skipped } = parseRouteSheet(rawSheet);
  if (!rows.length) throw new Error('no parseable rows (expected: customer, [address,] services, [tech, notes, visit day])');

  const shared = [
    `- Max 300 characters. Warm but professional, no emojis, no marketing fluff.`,
    `- Sign off as ${businessName}. NEVER invent services, prices, time windows, prep policies, or appointment details that are not in the row.`,
    'Respond with ONLY this JSON: {"messages":[{"i":1,"sms":"..."}]}',
  ];
  const prompt = (mode === 'day_before'
    ? [
      `You write day-before service-notice text messages for ${businessName}, a local service business.`,
      'For EACH numbered visit below, write ONE friendly SMS telling that customer the team will be out and EXACTLY which service is planned for their account. Rules:',
      `- State when: use the row's "visit day" if present, otherwise "${visitDay}".`,
      '- Name the SPECIFIC planned service(s) from the row; that is the entire point of the message (today their notices say "we\'ll be out" with no service named).',
      '- Frame the service as SCHEDULED ("your scheduled organic fertilization", "we\'re scheduled to..."): schedules can shift with weather, so never promise an exact time or guarantee.',
      '- If the row notes something the customer should do (gate, pets), include it as a gentle reminder; otherwise add NO prep instructions.',
      '- If the row has a tech name, you may mention who is coming.',
      ...shared,
    ]
    : [
      `You write same-day service-completion text messages for ${businessName}, a local service business.`,
      'For EACH numbered visit below, write ONE friendly SMS to that customer. Rules:',
      '- Name the SPECIFIC services performed today (from the row). Include one practical aftercare or what-to-expect line when it clearly fits the service.',
      '- If the row has a tech name, mention them ("Mike completed...").',
      ...shared,
    ]);

  const fullPrompt = [
    ...prompt,
    '',
    ...rows.map((r, idx) =>
      `${idx + 1}. customer: ${r.customer}${r.address ? ` | address: ${r.address}` : ''} | services: ${r.services}${r.tech ? ` | tech: ${r.tech}` : ''}${r.notes ? ` | notes: ${r.notes}` : ''}${r.visitDay ? ` | visit day: ${r.visitDay}` : ''}`),
  ].join('\n');

  const res = await delegate('scribe' as never, fullPrompt, { shareMemory: false, maxTokens: 2500 });
  const m = res.output.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('model returned no JSON');
  const parsed = JSON.parse(m[0]) as { messages?: Array<{ i: number; sms: string }> };
  if (!parsed.messages?.length) throw new Error('model returned empty message list');

  const messages: GeneratedText[] = parsed.messages
    .filter((x) => typeof x.i === 'number' && rows[x.i - 1] && typeof x.sms === 'string' && x.sms.trim())
    .map((x) => ({ i: x.i, customer: rows[x.i - 1].customer, sms: x.sms.trim().slice(0, 320) }));
  if (!messages.length) throw new Error('no usable messages generated');

  const content = JSON.stringify({
    business_name: businessName,
    mode,
    visit_day_default: visitDay,
    generated_at: Math.floor(Date.now() / 1000),
    input_rows: rows,
    skipped,
    messages,
  });
  const artifact = createClientArtifact(
    clientId,
    'service_texts_demo',
    `${mode === 'day_before' ? 'Day-before notices' : 'After-service recaps'} (${messages.length} customers)`,
    content,
  );
  const owner = getClient(clientId);
  if (owner) exportArtifactDocs(owner, artifact); // mirror into the Desktop folder
  log(`service-texts demo (${mode}) for client ${clientId}: ${messages.length} messages (${skipped.length} rows skipped)`);
  return { artifact, messages, skipped, mode };
}
