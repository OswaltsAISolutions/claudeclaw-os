// Client docs exporter (Gabe 2026-06-11): every research artifact also lands
// as a readable file in a per-company folder on his Windows desktop:
//   Desktop\Oswalts AI Solutions\Clients\<Company>\Deep Dive.html, Pitch.html,
//   Demo Site.html, Service Texts.html
// so the file explorer mirrors the Clients tab. HTML (not .md) because a
// double-click opens a clean, printable document for a non-technical reader.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { type Client, type ClientArtifact } from './db.js';
import { logger } from './logger.js';

const log = (msg: string) => logger.info({ scope: 'clients' }, msg);

// WSL view of the Windows desktop; explorer.exe gets the Windows-native path.
const EXPORT_BASE_WSL = '/mnt/c/Users/GCruise/Desktop/Oswalts AI Solutions/Clients';
const EXPORT_BASE_WIN = 'C:\\Users\\GCruise\\Desktop\\Oswalts AI Solutions\\Clients';

export function clientFolderName(company: string): string {
  // Windows cannot open folders whose names end in '.' or ' ' (they were
  // being created via the WSL mount, then unreachable from Explorer).
  return company.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '');
}

export function winFolderPath(company: string): string {
  return `${EXPORT_BASE_WIN}\\${clientFolderName(company)}`;
}

function ensureDir(company: string): string {
  const dir = path.join(EXPORT_BASE_WSL, clientFolderName(company));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Public helper so the backfill script can pre-create every company folder. */
export function ensureClientFolder(company: string): string {
  return ensureDir(company);
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tiny Markdown-to-HTML for pitch docs: headings, bold, bullets, paragraphs. */
function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>');
    if (/^###\s+/.test(line)) { closeList(); out.push(`<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`); }
    else if (/^##\s+/.test(line)) { closeList(); out.push(`<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`); }
    else if (/^#\s+/.test(line)) { closeList(); out.push(`<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`); }
    else if (/^[-*]\s+/.test(line)) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`); }
    else if (!line.trim()) { closeList(); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('\n');
}

const DOC_CSS = `
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #16202e; max-width: 820px; margin: 40px auto; padding: 0 28px; line-height: 1.65; }
  h1 { font-size: 30px; letter-spacing: -0.02em; margin-bottom: 4px; }
  h2 { font-size: 19px; margin: 34px 0 10px; border-bottom: 2px solid #e7ecf3; padding-bottom: 6px; }
  h3 { font-size: 15.5px; margin: 20px 0 6px; }
  p, li { font-size: 14.5px; }
  .meta { color: #7a8698; font-size: 12.5px; margin-bottom: 28px; }
  .opp { border: 1px solid #e7ecf3; border-radius: 12px; padding: 16px 18px; margin: 12px 0; }
  .opp b.t { font-size: 15px; display: block; margin-bottom: 6px; }
  .lbl { font-weight: 700; color: #0b66ff; }
  .src { color: #7a8698; font-size: 11.5px; word-break: break-all; }
  .tag { display: inline-block; background: #eef4ff; color: #0b66ff; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 99px; margin-right: 6px; }
  ul { padding-left: 22px; }
  footer { margin-top: 48px; color: #7a8698; font-size: 11.5px; border-top: 1px solid #e7ecf3; padding-top: 14px; }
  @media print { body { margin: 0 auto; } }
`;

function docShell(title: string, sub: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title><style>${DOC_CSS}</style></head>
<body><h1>${esc(title)}</h1><div class="meta">${esc(sub)}</div>${body}
<footer>Prepared by Oswalt's AI Solutions — internal document</footer></body></html>`;
}

function renderDossier(client: Client, d: Record<string, any>): string {
  const parts: string[] = [];
  if (d.profile) parts.push(`<h2>Company profile</h2><p>${esc(d.profile)}</p>`);
  const opps = Array.isArray(d.opportunities) ? d.opportunities : [];
  if (opps.length) {
    parts.push('<h2>How we could help (ranked by impact)</h2>');
    opps.forEach((o: any, i: number) => {
      parts.push(`<div class="opp"><b class="t">${i + 1}. ${esc(o.title)}</b>
        <p><span class="lbl">What's broken:</span> ${esc(o.whats_broken)}</p>
        <p><span class="lbl">What we'd build:</span> ${esc(o.what_wed_build)}</p>
        <p><span class="lbl">Business impact:</span> ${esc(o.business_impact)}</p></div>`);
    });
  }
  const themes = Array.isArray(d.review_themes) ? d.review_themes : [];
  if (themes.length) parts.push(`<h2>What customers keep saying</h2><ul>${themes.map((t: string) => `<li>${esc(t)}</li>`).join('')}</ul>`);
  const ops = Array.isArray(d.internal_ops_signals) ? d.internal_ops_signals : [];
  if (ops.length) parts.push(`<h2>Inside the business (public signals)</h2><ul>${ops.map((t: string) => `<li>${esc(t)}</li>`).join('')}</ul>`);
  const fixables = Array.isArray(d.fixable_problems) ? d.fixable_problems : [];
  if (fixables.length) {
    parts.push('<h2>Fixable problems we found (bugs, inefficiencies, subscription pain)</h2>');
    fixables.forEach((f: any) => {
      parts.push(`<div class="opp"><b class="t">${esc(f.problem)}</b>
        ${f.evidence ? `<p><span class="lbl">Evidence:</span> ${esc(f.evidence)}</p>` : ''}
        ${f.fix ? `<p><span class="lbl">Our fix:</span> ${esc(f.fix)}</p>` : ''}</div>`);
    });
  }
  if (d.ads_status || d.social_status) {
    parts.push('<h2>Marketing posture</h2>');
    if (d.ads_status) parts.push(`<p><span class="lbl">Advertising:</span> ${esc(d.ads_status)}</p>`);
    if (d.social_status) parts.push(`<p><span class="lbl">Social media:</span> ${esc(d.social_status)}</p>`);
  }
  const comps = Array.isArray(d.competitors) ? d.competitors : [];
  if (comps.length) parts.push(`<h2>Competitors</h2><ul>${comps.map((c: any) => `<li><b>${esc(c.name)}:</b> ${esc(c.digital_edge)} <i>${esc(c.implication)}</i></li>`).join('')}</ul>`);
  if (d.outreach) {
    const o = d.outreach;
    parts.push(`<h2>How to reach out</h2>
      <p><span class="lbl">Who:</span> ${esc(o.who)}</p>
      <p><span class="lbl">Channel:</span> ${esc(o.channel)}</p>
      <p><span class="lbl">Opening angle:</span> ${esc(o.angle)}</p>
      ${o.timing ? `<p><span class="lbl">Timing:</span> ${esc(o.timing)}</p>` : ''}`);
  }
  const contacts = Array.isArray(d.contacts) ? d.contacts : [];
  if (contacts.length) {
    parts.push(`<h2>Contacts</h2><ul>${contacts.map((c: any) =>
      `<li><b>${esc(c.name ?? 'Company')}</b>${c.role ? ` (${esc(c.role)})` : ''}${c.phone ? ` — ${esc(c.phone)}` : ''}${c.email ? ` — ${esc(c.email)}` : ''}${c.linkedin ? ` — ${esc(c.linkedin)}` : ''}${c.note ? `<br><span class="src">${esc(c.note)}</span>` : ''}</li>`).join('')}</ul>`);
  }
  const sources = Array.isArray(d.sources) ? d.sources : [];
  if (sources.length) parts.push(`<h2>Sources</h2><p class="src">${sources.map((s: string) => esc(s)).join('<br>')}</p>`);
  const when = d.completed_at ? new Date(d.completed_at * 1000).toLocaleString('en-US') : '';
  return docShell(`Deep Dive — ${client.company}`, `${client.industry ?? ''} · ${client.location ?? ''} · researched ${when}`, parts.join('\n'));
}

function renderServiceTexts(client: Client, d: Record<string, any>): string {
  const msgs = Array.isArray(d.messages) ? d.messages : [];
  const body = msgs.map((m: any) =>
    `<div class="opp"><b class="t">${esc(m.customer)}</b><p>${esc(m.sms)}</p><p class="src">${String(m.sms ?? '').length} characters</p></div>`).join('\n');
  return docShell(`Service Texts — ${client.company}`,
    `${d.mode === 'day_before' ? 'Day-before notices' : 'After-service recaps'} · generated ${d.generated_at ? new Date(d.generated_at * 1000).toLocaleString('en-US') : ''}`,
    body);
}

/** Write the artifact's readable doc(s) into the company folder. Never throws. */
export function exportArtifactDocs(client: Client, artifact: ClientArtifact): void {
  try {
    let parsed: Record<string, any> = {};
    try { parsed = artifact.content ? JSON.parse(artifact.content) : {}; } catch { return; }
    if (parsed.status && parsed.status !== 'ready') return;
    const dir = ensureDir(client.company);

    if (artifact.kind === 'deep_dive') {
      fs.writeFileSync(path.join(dir, 'Deep Dive.html'), renderDossier(client, parsed));
    } else if (artifact.kind === 'full_pitch' && parsed.markdown) {
      fs.writeFileSync(path.join(dir, 'Pitch.html'),
        docShell(`Pitch — ${client.company}`, 'Draft for review before any outreach', mdToHtml(String(parsed.markdown))));
      fs.writeFileSync(path.join(dir, 'Pitch.md'), String(parsed.markdown));
    } else if (artifact.kind === 'demo_site' && parsed.html) {
      fs.writeFileSync(path.join(dir, 'Demo Site.html'), String(parsed.html));
    } else if (artifact.kind === 'service_texts_demo') {
      fs.writeFileSync(path.join(dir, 'Service Texts.html'), renderServiceTexts(client, parsed));
    } else {
      return;
    }
    log(`exported ${artifact.kind} docs for ${client.company}`);
  } catch (err) {
    log(`doc export failed for ${client.company}: ${String(err).slice(0, 160)}`);
  }
}

/** Open the company folder in Windows Explorer (WSL interop). Returns the
 *  Windows path either way so the UI can offer copy-paste as fallback.
 *  IMPORTANT: spawn ENOENT arrives via the async 'error' event; without a
 *  listener it is an uncaughtException that kills the whole service (it did,
 *  once, 2026-06-11). Resolve opened:false on error, true if it survives. */
export function openClientFolder(company: string): Promise<{ path: string; opened: boolean }> {
  const winPath = winFolderPath(company);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (opened: boolean) => { if (!settled) { settled = true; resolve({ path: winPath, opened }); } };
    try {
      ensureDir(company);
      // systemd context has no Windows PATH; use the interop mount directly.
      const exe = fs.existsSync('/mnt/c/Windows/explorer.exe') ? '/mnt/c/Windows/explorer.exe' : 'explorer.exe';
      const proc = spawn(exe, [winPath], { detached: true, stdio: 'ignore' });
      proc.on('error', () => settle(false));
      proc.unref();
      setTimeout(() => settle(true), 450);
    } catch {
      settle(false);
    }
  });
}
