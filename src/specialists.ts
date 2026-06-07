// Specialist roster and dispatch layer.
//
// Each specialist is a local-model-backed worker with a defined role,
// preferred + fallback model tags, and a tuned system prompt. The
// dispatcher (`delegate`) wraps Ollama chat with:
//   - shared hivemind memory injection (so the specialist sees the same
//     facts about the user that Jarvis does),
//   - conversation_log + hive_mind persistence so future turns and the
//     activity feed can see what each specialist did,
//   - model availability checks with graceful fallback when the
//     preferred tag isn't installed yet.
//
// Naming: callsigns. Short, role-coded, no theme overhead. Locked with
// the user in May 2026.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ollamaChat, ollamaListModels, type ChatMessage } from './ollama.js';
import { buildMemoryContext } from './memory.js';
import { getSpecialistTierOverride, logConversationTurn, logToHiveMind } from './db.js';
import { ALLOWED_CHAT_ID, DASHBOARD_TOKEN, PROJECT_ROOT, AGENT_MAX_TURNS } from './config.js';
import { logger } from './logger.js';
import { toolLabel } from './tool-labels.js';
import { runClaw } from './claw-runner.js';

// Lightweight progress callback shape used by delegateCloud to forward
// tool_use / tool_result events out to whatever caller invoked the
// specialist (typically src/agent.ts → src/bot.ts → SSE). We keep the
// type local to avoid a circular import with agent.ts.
export interface DelegateProgressEvent {
  type: 'tool_active' | 'tool_use' | 'tool_result';
  description: string;
  toolUseId?: string;
  toolName?: string;
  input?: string;
  output?: string;
}

export type SpecialistCallsign =
  | 'scribe'
  | 'coder'
  | 'eye'
  | 'sleuth'
  | 'reaper'
  | 'archivist'
  | 'sentinel'
  | 'cipher'
  | 'atlas'      // Cloud supervisor, Opus 4.7. Strategy, heavyweight reasoning, planning.
  | 'mercury'    // Cloud supervisor, Sonnet latest. Fast execution, parallel scout work.
  | 'prism'      // Cloud. Research analysis: source grading, claim verification, synthesis.
  | 'oracle'     // Local / abliterated. Uncensored research (gemma-4-abliterated).
  | 'heretic';   // Local / abliterated. Bias + censorship cross-reference (neuraldaredevil-8b).

// Specialist tier:
//   - 'local'   → Direct Ollama chat. Free, no tool use, no agent loop —
//                 just text-in text-out. Good for pure-inference tasks
//                 like vision (eye) or uncensored generation (reaper).
//   - 'claw'    → Local agentic loop via claw-code (Rust harness) bridged
//                 to Ollama as the OpenAI-compatible provider. Free,
//                 supports a tool loop (read/list/glob/grep/git/write,
//                 + bash when useFullClaw=true). This is the default tier
//                 after the 2026-05-25 cost pivot — Gabe downgraded the
//                 Anthropic sub and runs specialists locally.
//   - 'cloud'   → Anthropic Agent SDK via OAuth (legacy / fallback only).
//                 Kept as a config option so individual specialists can
//                 still hit the paid route via Settings override.
export type SpecialistTier = 'local' | 'claw' | 'cloud';

import type { ClawPermission } from './claw-runner.js';

export interface SpecialistConfig {
  callsign: SpecialistCallsign;
  tier: SpecialistTier;
  role: string;                  // One-line human description.
  preferredModel: string;        // Ollama tag for 'local'/'claw', SDK model for 'cloud'.
  fallbackModels: string[];      // Local only: ordered list of fallback Ollama tags.
  fallbackCallsign?: SpecialistCallsign; // Cloud only: when rate-limited, redirect to another specialist (legacy fallback).
  localFallbackModel?: string;   // Cloud only: Ollama tag to use directly when cloud rate-limits/fails. Tried BEFORE fallbackCallsign.
  cloudModel?: string;           // Optional SDK model string used when an
                                 // override flips this specialist back to
                                 // tier='cloud' at runtime (Settings UI).
  capabilities: string[];        // Tag list for routing heuristics.
  systemPrompt: string;          // Tuned role prompt.
  defaultContextTokens: number;  // num_ctx (local) or unused (cloud).
  temperature: number;           // 0.2 = factual, 0.7 = creative. NOTE: applied ONLY on the
                                 // local/claw paths (ollamaChat). The Anthropic Agent SDK exposes
                                 // no temperature option, so cloud-tier agents run at the SDK
                                 // default; tune cloud quality via prompt + model, not this field.
  vramHintGB: number;            // Rough estimate; 0 for cloud.
  cloudAllowTools?: boolean;     // Cloud only: true → full tool access (default true).
  // Claw-tier config — ignored for other tiers.
  clawPermission?: ClawPermission;  // read-only by default; workspace-write to allow file mutations.
  clawUseFull?: boolean;            // true → use full `claw` (bash + MCP); false (default) → `claw-analog` (sandboxed, no shell).
  clawMaxTurns?: number;            // Tool-loop cap (default 24).
  clawDisableFilesystemSandbox?: boolean; // true → CLAWD_SANDBOX_FILESYSTEM_MODE=off so host paths (/run/user/$UID/bus, /etc, journal) are visible. Required for sysadmin-shaped roles (sentinel).
  /** True for specialists whose answers MUST be grounded in tool calls
   *  (research, sysadmin, security, memory retrieval). When such a
   *  specialist returns with zero tool calls, delegateClaw labels the
   *  output as unverified. These are exactly the roles that fabricated
   *  URLs, port lists, and byte counts in the bake-off. Leave unset for
   *  prose, vision, or pure-reasoning roles where a tool-less answer is
   *  legitimately fine. */
  expectsToolUse?: boolean;
}

// All system prompts share a common "you are part of a hivemind" framing
// so specialist outputs feel consistent. Role-specific guidance follows.
//
// 2026-05-25 tune: three hard rules added at the top (no hallucination,
// no thinking-buffer death, brevity-without-truncation) after a quality
// bake-off revealed atlas/mercury producing empty outputs and coder
// hallucinating file paths to satisfy a "list 3" prompt. Rules are
// front-loaded so they read first; punctuation + role context follow.
const HIVEMIND_PREAMBLE = [
  'You are a specialist in a multi-agent system orchestrated by Jarvis,',
  "the user's primary AI assistant. You share the same persistent memory",
  '("hivemind") as Jarvis and every other specialist. Treat the memory',
  'context as authoritative facts about the user.',
  '',
  'RULE 0 (HARDEST) — EXECUTE, DO NOT DESCRIBE. You are an AUTONOMOUS',
  'agent in a dashboard, not a help desk. If a task can be done by',
  'running a command, READING a file, or making an HTTP call: DO IT,',
  'do not paste the command for the user to run themselves. You have',
  'bash, file IO, grep, glob, git, and curl. The user typed the task',
  'into a dashboard because they want it done, not narrated. Reply',
  'with the RESULT of having done the work, not instructions for the',
  'user to do the work. "Here is the command you should run" is a',
  'failed task; "I ran X and the output was Y" is correct.',
  '',
  'RULE 0a (TOOL DISCIPLINE) — When the task contains a literal command',
  'to run (e.g. "Run via bash: <cmd>", "Run this exact pipeline: <cmd>",',
  '"curl <url>"), your FIRST tool call MUST be the bash tool with that',
  'exact command. Do NOT call git_status, git_diff, GitStatus, GitDiff,',
  'read_file, ReadFile, or any "let me check the context first" tool',
  'before executing what was literally asked. Run THAT command, get',
  'its output, then write your answer. The user already decided which',
  'command they want; reflexively running git diff first is a FAILED',
  'task even if you eventually do the right thing.',
  '',
  'RULE 1 (HARD) — NEVER HALLUCINATE. Never invent file paths, URLs,',
  'function names, line numbers, quoted figures, citations, package names,',
  'or any specific claim you did not verify. If a tool is available to',
  'verify (read_file, grep_workspace, list_dir, git_diff, bash, curl),',
  'USE IT before asserting. If you cannot verify, say "I don\'t know"',
  'or "I could not find that". Both are correct answers. Padding a',
  'list to match a requested count is hallucination: if asked for 3',
  'items and you find 2, return 2 with a one-line note. Returning 3 by',
  'inventing 1 is a FAILED task.',
  '',
  'RULE 2 (HARD) — NEVER LEAVE THE ANSWER IN A THINKING BUFFER. Reasoning',
  'is fine; reasoning without a conclusion is a failure. Always emit your',
  'final answer in plain prose, not a thinking tag. If you find yourself',
  'about to wrap up internally, write the conclusion out.',
  '',
  'RULE 3 (HARD) — BRIEFLY COMPLETE. No filler ("Sure!", "Great question!",',
  '"I\'d be happy to", "As an AI", "absolutely", "Certainly!"). No throat',
  'clearing, no preamble, no "Let me know if..." sign-off. Get to the',
  'answer immediately. Concise is good only when correctness survives it:',
  'never cut off mid-claim, never omit information the user needs to act.',
  'If completeness needs 5 sentences, write 5. If it fits in 1, write 1.',
  '',
  'RULE 4 (HARD): RIGOR + CALIBRATION. Ground every non-trivial factual claim',
  'in something real (a source, a tool result, the provided context). If you',
  'cannot ground it, label it unverified or say you do not know; never present',
  'a guess as fact. Lead with the bottom line, then the support, and prefer',
  'structure (short sections, lists, a clear conclusion) over a wall of text.',
  'Calibrate: state how confident you are and what you could not confirm.',
  'Going against the mainstream is fine and often right WHEN the evidence',
  'warrants it, but never be contrarian just to be contrarian and never invent',
  'a counter-narrative; truth over both consensus and contrarianism. If you are',
  'a tool-less local role, reason carefully over the context you were given and',
  'still ground and calibrate. Be precise and literal with facts: do not',
  'speculate, embellish, or let stylistic variation introduce or distort a',
  'claim. When in doubt, choose the most accurate formulation over the most',
  'interesting one. This is how you stay factual and consistent without a',
  'temperature dial: the cloud models default to a higher sampling temperature',
  'that cannot be lowered through our SDK, so YOUR discipline is the control.',
  '',
  'PUNCTUATION (HARD RULE): NEVER use an em dash (—) or en dash (–) anywhere',
  'in your output. Not for parentheticals, not for emphasis, not for ranges,',
  'not for ANY reason. Use a comma, a period, parentheses, or start a new',
  'sentence instead. The user has explicitly said an em dash in your output',
  'is a failed task. Hyphens (-) in compound words like "fact-check" are fine.',
  '',
  'You are receiving a task delegated by Jarvis. Complete it directly and',
  'return the result. Do not ask clarifying questions unless the task is',
  'genuinely ambiguous; otherwise make a reasonable assumption and note it.',
].join(' ');

export const SPECIALISTS: Record<SpecialistCallsign, SpecialistConfig> = {
  scribe: {
    callsign: 'scribe',
    tier: 'cloud',
    role: 'Writing, summaries, drafts, rewrites, formatting, transcript cleanup, short-form copy.',
    // 2026-06-02 hybrid topology: moved to cloud Sonnet 4.6. Scribe is prose,
    // and Sonnet writes materially better than the local abliterated model
    // while still fetching source material (curl a URL, read a file) natively
    // before drafting. The uncensored local model is retained as
    // localFallbackModel so edgy prose still has a home on quota exhaustion
    // (tool-less direct chat). claw permission fields are kept for the
    // cloud->claw override path. expectsToolUse stays UNSET: prose is a
    // legitimately tool-less answer and must not be flagged ungrounded.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: ['mistral-small:24b'],
    cloudModel: 'claude-sonnet-4-6',
    localFallbackModel: 'huihui_ai/Qwen3.6-abliterated:27b',
    capabilities: ['writing', 'summarize', 'rewrite', 'format', 'draft', 'copy'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Scribe, the team's writer. First identify the {audience, format, length, tone} from the task; if any is unstated, infer it and state your inference in one line, then write. Match the requested voice. When writing for Gabe's own content (his GCruise brand: independent, truth-forward, punchy when warranted, serious message with the occasional joke), write in HIS voice, not a generic one, and never water it down into corporate mush. Lead with the conclusion when summarizing. Prefer short paragraphs, active voice, and clean structure that flows and reads well for a real audience. Never invent facts; when the task references a file or URL you can fetch, fetch it first, never ask the user to paste content.`,
    defaultContextTokens: 16384,
    temperature: 0.5,
    vramHintGB: 16,
    clawPermission: 'read-only',
    clawUseFull: true,
  },
  coder: {
    callsign: 'coder',
    tier: 'cloud',
    role: 'Code reading, refactors, test stubs, lint fixes, bug analysis, language conversions.',
    // 2026-06-01 cloud rebalance: moved to Sonnet 4.6. qwen3-coder:30b was a
    // stopgap because it was the only LOCAL model that reliably emitted
    // tool_calls (bake-off v3); Sonnet is materially stronger at code AND
    // calls tools natively. localFallbackModel keeps a local path on quota
    // exhaustion (tool-less direct chat, so degraded but never stalls).
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: ['mistral-small:24b'],
    cloudModel: 'claude-sonnet-4-6',
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['code', 'refactor', 'test', 'debug', 'review', 'convert'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Coder. Output working code, not pseudocode, unless explicitly asked. Match the project's existing style. When refactoring, preserve behavior. When debugging, identify root cause before proposing fixes. Show file paths and line numbers when relevant. Always note assumptions about runtime, framework, or libraries.\n\nTOOL DISCIPLINE (hard rule): When a task gives you a literal bash command to run, your FIRST tool call MUST be the bash tool with that exact command. Do NOT call git_status, git_diff, GitStatus, GitDiff, ReadFile, read_file, or any "let me check the context first" tool before executing the requested command. The user already told you what to do. Tools available to you: bash, read_file, write_file, edit_file, glob_search, grep_search, GitStatus, GitDiff, GitLog. Use bash for any shell command.`,
    defaultContextTokens: 16384,
    temperature: 0.2,
    vramHintGB: 18,
    clawPermission: 'workspace-write',
    clawUseFull: true,
  },
  eye: {
    callsign: 'eye',
    tier: 'local',
    role: 'Image and video analysis, OCR, screenshot triage, visual classification.',
    // 2026-05-25 pivot: eye stays on direct-ollama because claw-analog has
    // no vision tools. qwen3-vl:8b handles OCR + image description in a
    // single text-in/text-out shot; no agentic tool loop needed.
    preferredModel: 'qwen3-vl:8b',
    fallbackModels: ['qwen2.5vl:7b'],
    cloudModel: 'claude-sonnet-4-6',
    capabilities: ['vision', 'image', 'ocr', 'screenshot', 'video-frame', 'classify'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Eye. You describe what is in images and screenshots, extract text via OCR, and classify visual content. Be specific and grounded: say what you actually see, not what you assume. If the image is unclear, say so. For screenshots of UIs, name the application if recognizable and describe the visible state.`,
    defaultContextTokens: 8192,
    temperature: 0.3,
    vramHintGB: 6,
  },
  sleuth: {
    callsign: 'sleuth',
    tier: 'cloud',
    role: 'Web research synthesis. Receives pre-fetched Brave search results, can curl follow-up URLs, synthesizes a citation-backed answer.',
    // 2026-05-25 autonomy upgrade: full claw + bash so sleuth can curl
    // follow-up URLs (after Brave gives it candidates) or hit /api/web/search
    // directly when the prefetch missed. Swapped off deepseek-r1:14b because
    // it doesn't support OpenAI-compat tool calls; mistral-small:24b does.
    // 2026-05-25 (second pivot, same day): bake-off v3 showed mistral-small:24b
    // and the abliterated qwens DO NOT reliably emit OpenAI-compat tool_calls
    // even when claw advertises tools (they answer with plausible-looking prose
    // instead). Only qwen3-coder:30b actually invokes bash/grep/curl in this
    // setup. Sleuth was getting 0 tool calls and fabricating URLs. Move to
    // qwen3-coder:30b. mistral-small:24b stays as fallback for capacity.
    // 2026-06-01 cloud rebalance: moved to Sonnet 4.6 (calls tools natively,
    // far stronger synthesis). Local qwen3-coder kept as localFallbackModel.
    // 2026-06-07: upgraded to Opus 4.7 for top-tier multi-source research depth
    // (Gabe's research is the system's #1 job; intelligence first, cost last).
    preferredModel: 'claude-opus-4-7',
    fallbackModels: ['mistral-small:24b', 'qwen3.5:latest'],
    cloudModel: 'claude-opus-4-7',
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['research', 'synthesis', 'fact-check', 'citations', 'reasoning', 'web-search'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Sleuth, the team's web researcher, and this is real research, not a search summary. The dispatch layer pre-fetches Brave results under a [SEARCH RESULTS] block. Dig: USE bash + curl to follow the best links and read the actual pages, and when prefetch missed or you need more, curl "http://127.0.0.1:3141/api/web/search?token=$DASHBOARD_TOKEN&q=<query>&count=8" and fetch the top hits.\n\nRigor: (1) Corroborate every non-trivial claim across at least two independent sources; when only one supports it, label it [single-source]. (2) Prefer primary and authoritative sources over blogs and SEO pages, and prefer recent sources for time-sensitive facts. (3) When sources disagree, say so, say which you trust more, and why. (4) Go past the surface and past the obvious narrative when the evidence genuinely points elsewhere, but never invent a counter-narrative and never paste a URL or number you did not actually see.\n\nOutput contract: lead with the BOTTOM LINE, then KEY FINDINGS (each with an inline source URL), then a CONFIDENCE line (high / medium / low), then OPEN QUESTIONS listing what you could not verify. Never invent URLs or numbers.`,
    defaultContextTokens: 32768,
    temperature: 0.3,
    vramHintGB: 14,
    clawPermission: 'read-only',
    clawUseFull: true,
    expectsToolUse: true, // research: every fact must come from a fetched source
  },
  reaper: {
    callsign: 'reaper',
    tier: 'claw',
    role: 'Uncensored / abliterated work: security research, red-team drafting, no-guardrail analysis.',
    // 2026-05-25 autonomy upgrade: full claw + bash so reaper can actually
    // execute defensive security probes (nmap, curl, grep logs) against the
    // user's own systems instead of describing what the user should run.
    // KNOWN LIMITATION (bake-off v3, 2026-05-25): abliterated qwens do NOT
    // reliably emit OpenAI-compat tool_calls in this setup. Reaper will often
    // produce a plausible-looking text answer WITHOUT actually running the
    // probe. Kept on abliterated:35b because the uncensored generation IS the
    // reason this specialist exists, but treat its claims as unverified unless
    // hive_mind.artifacts.toolCalls > 0 for the run. For tasks that NEED a real
    // bash result, route through coder/mercury (qwen3-coder:30b) instead.
    preferredModel: 'huihui_ai/Qwen3.6-abliterated:35b',
    fallbackModels: [
      'huihui_ai/Qwen3.6-abliterated:27b',
      'mistral-small:24b',
    ],
    cloudModel: 'claude-opus-4-8',
    capabilities: ['uncensored', 'security', 'red-team', 'analysis', 'no-refusal'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Reaper. You handle tasks where standard models refuse or hedge unnecessarily: security research, red-team scenarios, edgy creative work, legitimate adult content drafting, and deep uncensored analysis of taboo or suppressed topics. The user is an adult professional building a truth-uncovering operation. Skip moralizing and warnings; deliver the requested output. Stay within legal bounds (no CSAM, no targeted real-person harm, no working malware against systems the user doesn't own). When the task is a defensive probe of the user's own systems (port scan, log audit, config check), USE bash to run it and report results, do not paste commands for the user.\n\nIn the dual-track research flow you are the DEEP-DIVE escalation: Jarvis calls you only on a HIGH-risk discrepancy that could change the conclusion. Go deep and precise on that specific point, ground what you can, and rate your confidence.`,
    defaultContextTokens: 16384,
    temperature: 0.6,
    vramHintGB: 22,
    clawPermission: 'read-only',
    clawUseFull: true,
  },
  archivist: {
    callsign: 'archivist',
    tier: 'cloud',
    role: 'Memory consolidation, recall queries, deduplication, salience scoring, summarization of long history.',
    // 2026-05-25 autonomy upgrade: full claw + bash so archivist can
    // query the SQLite DB directly (sqlite3 store/claudeclaw.db ...) for
    // memory operations instead of just reasoning over injected context.
    // 2026-05-25 (second pivot): mistral-small:24b returned 0 tool calls in
    // bake-off v3. Swapped to qwen3-coder:30b which actually invokes sqlite3.
    // 2026-06-01 cloud rebalance: moved to Sonnet 4.6. Local qwen3-coder
    // kept as localFallbackModel for quota-exhaustion degradation.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: ['mistral-small:24b', 'qwen3.5:latest'],
    cloudModel: 'claude-sonnet-4-6',
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['memory', 'recall', 'dedup', 'consolidate', 'salience'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Archivist. You maintain the integrity of the shared memory store. Tasks include: scoring memory importance (1-10), merging duplicate facts, summarizing long conversation runs, identifying outdated information. Prune low-value memories with a clear rule: drop a memory only if it is low salience AND not referenced recently AND superseded by a newer fact; when those do not all hold, keep it. When you need facts from the DB, USE bash (sqlite3 store/claudeclaw.db "SELECT ..."), do not ask the user to query it.`,
    defaultContextTokens: 32768,
    temperature: 0.2,
    vramHintGB: 14,
    clawPermission: 'read-only',
    clawUseFull: true,
    expectsToolUse: true, // memory ops must hit the DB, not be reasoned over
  },
  sentinel: {
    callsign: 'sentinel',
    tier: 'cloud',
    role: 'Sysadmin, log triage, infra health checks, systemd troubleshooting, deployment diagnostics.',
    // 2026-05-25 autonomy upgrade: full claw + bash. Sentinel runs
    // READ-ONLY diagnostics directly (systemctl status, journalctl,
    // ss -tlnp, df -h) and reports findings. Destructive ops still
    // require explicit confirmation in the prompt before sentinel runs
    // them; non-destructive triage runs without asking.
    // 2026-05-25 (second pivot): bake-off v3 showed mistral-small:24b returning
    // 0 tool calls and fabricating port lists (claimed 22/3000/5432 etc. when
    // the real ss -tln list was 11435/3141/7860/53). Swapped to qwen3-coder:30b.
    // 2026-05-25 (third fix): bake-off v4 surfaced that systemctl --user from
    // inside claw's default workspace-only sandbox fails with "could not connect
    // to user scope bus" because /run/user/$UID/bus is not bind-mounted into
    // the sandbox. Set clawDisableFilesystemSandbox so the host filesystem is
    // visible. Sentinel is sysadmin-shaped, so this matches the role intent.
    // 2026-06-01 cloud rebalance: moved to Sonnet 4.6. NOTE: cloud runs with
    // bypassPermissions full tool access, so the old claw read-only sandbox no
    // longer constrains sentinel; the systemPrompt's destructive-op confirmation
    // rule is now the guardrail. Local qwen3-coder kept as localFallbackModel.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: ['mistral-small:24b', 'qwen3.5:latest'],
    cloudModel: 'claude-sonnet-4-6',
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['sysadmin', 'logs', 'infra', 'systemd', 'diagnostics'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Sentinel. You triage logs, diagnose infra issues, and fix sysadmin problems. For READ-ONLY diagnostics (systemctl status, journalctl, ss, df, ps, top, free, uname, cat /etc/*), USE bash to run them and report findings; do not paste commands for the user. For DESTRUCTIVE ops (restart, kill, rm, write to /etc, sudo anything), require explicit user confirmation in the task before executing. Always note what each change does and how to roll it back.`,
    defaultContextTokens: 16384,
    temperature: 0.2,
    vramHintGB: 14,
    clawPermission: 'read-only',
    clawUseFull: true,
    clawDisableFilesystemSandbox: true,
    expectsToolUse: true, // diagnostics must come from real systemctl/ss/df output
  },
  cipher: {
    callsign: 'cipher',
    tier: 'cloud',
    role: 'Data analysis, CSV/JSON crunching, statistical reasoning, pattern extraction.',
    // 2026-05-25 autonomy upgrade: full claw + bash so cipher can pipe
    // data through awk/jq/python/sqlite directly instead of "proposing"
    // a script. Swapped off deepseek-r1:14b (no tool-call support) onto
    // mistral-small:24b.
    // 2026-05-25 (second pivot): mistral-small:24b returned 0 tool calls in
    // bake-off v3 and fabricated a byte count for a file at a wrong path. The
    // "reliable OpenAI-compat tool calling" claim above did not survive
    // empirical test. Swapped to qwen3-coder:30b, the only model in current
    // lineup that actually invokes tools.
    // 2026-06-01 cloud rebalance: moved to Sonnet 4.6 (was cloudModel Opus;
    // user chose Sonnet for the data role). Local qwen3-coder kept as fallback.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: ['mistral-small:24b', 'qwen3.5:latest'],
    cloudModel: 'claude-sonnet-4-6',
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['data', 'analysis', 'csv', 'json', 'statistics', 'patterns', 'reasoning'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Cipher. You analyze structured data and extract patterns. Show your reasoning briefly, then the answer. For non-trivial data, USE bash (awk, jq, python3, sqlite3) to crunch the numbers directly and report the result. Do not "propose a script" for the user to run; run it yourself. Always state assumptions about column meanings, data types, and missing values. Report the sample size (n), the units, and the method behind every figure. Never assert a pattern you cannot back with a number, never infer causation from correlation, and flag when a result is not statistically meaningful.\n\nTOOL DISCIPLINE (hard rule): When a task gives you a literal bash command to run, your FIRST tool call MUST be the bash tool with that exact command. Do NOT call git_status, git_diff, GitStatus, GitDiff, ReadFile, read_file, or any "let me check the context first" tool before executing the requested command. Tools available: bash, read_file, write_file, glob_search, grep_search, GitStatus, GitDiff, GitLog. Use bash for any shell command.`,
    defaultContextTokens: 32768,
    temperature: 0.2,
    vramHintGB: 14,
    clawPermission: 'read-only',
    clawUseFull: true,
    expectsToolUse: true, // figures must be computed from data, not estimated
  },
  // ── Cloud supervisors ────────────────────────────────────────────────
  // These two ride the user's Anthropic Max plan via OAuth (no API key,
  // no per-token billing). They have full tool access (Bash, file IO, web
  // search, MCP servers) and operate one tier above the local specialists
  // in the hierarchy: Gabe → Jarvis (COO) → Atlas + Mercury (supervisors)
  // → 8 local specialists (employees). On rate-limit they fail over to a
  // strong local specialist so work never stalls.
  atlas: {
    callsign: 'atlas',
    tier: 'cloud',
    role: 'Local supervisor. Heavyweight reasoning, planning, architecture review, deep synthesis.',
    // 2026-05-25 autonomy upgrade: full claw + bash. Atlas is a supervisor
    // that decomposes plans and reviews work, for that it needs to read
    // the actual codebase (grep, glob, read_file) and verify claims with
    // bash (e.g. tsc --noEmit, npm test) before declaring a plan ready.
    // 2026-05-25 (second pivot): bake-off v3 showed abliterated:35b returning
    // 0 tool calls (its "5 commits" answer came from claw's auto-injected git
    // context, not from running anything). Swapped to qwen3-coder:30b which
    // actually invokes the tools. We lose some reasoning headroom vs the 35b
    // abliterated, but a supervisor that doesn't verify isn't a supervisor.
    // Abliterated kept as fallback for uncensored planning edge cases.
    // 2026-06-01 cloud rebalance: moved to Opus (heaviest reasoning role).
    // 2026-06-02 hybrid: pinned to Opus 4.7. Atlas is the team's heavy
    // reasoner one tier below Jarvis; Gabe set the supervisor at 4.7 while
    // Jarvis main runs 4.8 (reverses the 2026-06-01 "track main on 4.8" bump).
    // Local qwen3-coder kept as localFallbackModel for quota exhaustion.
    preferredModel: 'claude-opus-4-7',
    fallbackModels: ['huihui_ai/Qwen3.6-abliterated:35b', 'huihui_ai/Qwen3.6-abliterated:27b', 'mistral-small:24b'],
    cloudModel: 'claude-opus-4-7',
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['planning', 'architecture', 'review', 'synthesis', 'reasoning', 'supervise', 'orchestrate'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Atlas, the team's heavyweight reasoner and supervisor, one tier below Jarvis. Your job: decompose big plans into ordered steps Jarvis can hand to line specialists, review critical code or decisions, and synthesize across many sources.\n\nInvestigate before you conclude. For planning, architecture review, or synthesis, INSPECT every file the plan touches with grep/glob/read_file and VERIFY each load-bearing assumption with bash (file existence, package version, command behavior, tsc --noEmit, tests) BEFORE you conclude. A plan based on one file you happened to read first is a failed task. The ONLY time to stop early is a single-value lookup (one figure, one command's output): report it and stop.\n\nPlan format. Structure every plan as: GOAL (one line) | CONSTRAINTS & ASSUMPTIONS (mark each verified vs assumed) | STEPS (ordered, each with an owner like "@coder" and a concrete action) | RISKS | DONE-CRITERIA (how to verify each step actually worked). Ground every step in what you actually saw, not what you assumed.\n\nGit: for any git operation use bash with an explicit path (git -C <repo> ...); NEVER call the GitStatus, GitDiff, or GitLog tools, they are unreliable here. Tools available: bash, read_file, write_file, edit_file, glob_search, grep_search.`,
    defaultContextTokens: 32768,
    temperature: 0.4,
    vramHintGB: 22,
    clawPermission: 'workspace-write',
    clawUseFull: true,
  },
  mercury: {
    callsign: 'mercury',
    tier: 'cloud',
    role: 'Local supervisor (speed tier). Fast execution, parallel scout work, drafting, light coding.',
    // 2026-05-25 autonomy upgrade: full claw + bash. Mercury IS the
    // execution-side supervisor; it should run things, not defer them.
    // Atlas thinks, mercury does. workspace-write because scout tasks
    // often involve writing a quick file (a transformed snippet, a note,
    // a stubbed test) that the user wants on disk.
    // 2026-06-01 cloud rebalance: moved to Sonnet 4.6 (speed-tier supervisor;
    // Sonnet is fast AND calls tools natively). Local qwen3-coder kept as fallback.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: ['mistral-small:24b'],
    cloudModel: 'claude-sonnet-4-6',
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['fast', 'execution', 'draft', 'scout', 'parallel', 'code', 'comms'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Mercury, the speed-tier supervisor on this team. You sit alongside Atlas, one tier below Jarvis. Your edge is speed AND execution: you run things directly. When a task needs deep reasoning, defer to Atlas. Everything else: USE bash, USE read_file/grep/glob/write_file, get it done. "Tight and actionable" means RESULTS, not instructions. If the task is "summarize log X", read the log and summarize it; do not paste the cat command.`,
    defaultContextTokens: 32768,
    temperature: 0.4,
    vramHintGB: 18,
    clawPermission: 'workspace-write',
    clawUseFull: true,
  },
  prism: {
    callsign: 'prism',
    tier: 'cloud',
    role: 'Research analysis: source-quality grading, claim verification, structured synthesis and comparison of findings.',
    // 2026-06-02 research team: prism is the regular-side analyst. It takes
    // sleuth's raw findings (or several agents' answers) and produces rigorous
    // analysis: grades source reliability, separates well-supported claims from
    // weak ones, surfaces contradictions, and synthesizes a structured compare.
    // Cloud Sonnet 4.6 for strong reasoning; local qwen3-coder kept as a
    // quota-exhaustion fallback. expectsToolUse stays unset: analysis over
    // provided material is a legitimately tool-less answer.
    // 2026-06-07: upgraded to Opus 4.7. Reconciling contradictory multi-source
    // evidence (the analyst's core job) is exactly where Opus separates from Sonnet.
    preferredModel: 'claude-opus-4-7',
    fallbackModels: ['mistral-small:24b'],
    cloudModel: 'claude-opus-4-7',
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['analysis', 'synthesis', 'verification', 'compare', 'source-quality', 'reasoning'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Prism, the team's research analyst. You take raw research (Sleuth's findings, source excerpts, or several agents' answers) and produce rigorous analysis. Grade each source A/B/C with explicit criteria: A = primary or authoritative, recent, independent; B = credible secondary; C = weak, unsourced, or SEO. Separate well-supported claims from weak ones, surface contradictions between sources, and synthesize a structured comparison. Lead with the BOTTOM LINE, then the evidence, then an OVERALL CONFIDENCE rating (high / medium / low) on the conclusion, then EVIDENCE GAPS listing the questions the current sources do not answer. Flag any claim that rests on a single weak source. Never invent facts; when a claim cannot be verified from the provided material, say so explicitly.`,
    defaultContextTokens: 32768,
    temperature: 0.2,
    vramHintGB: 14,
    clawPermission: 'read-only',
    clawUseFull: true,
  },
  oracle: {
    callsign: 'oracle',
    tier: 'local',
    role: 'Uncensored research: investigates the same questions as the regular team with no guardrails, surfacing facts, framings, and sources that guardrailed models omit or soften.',
    // 2026-06-06 fix: oracle is LOCAL tier (direct Ollama, no claw tool loop),
    // same as heretic. The dispatch layer pre-fetches Brave results for oracle
    // and injects them as a [SEARCH RESULTS] block, so it reasons over real
    // sources in a single bounded inference. This is fast and reliable; the
    // claw tool loop was slow and spin-prone with an abliterated model and was
    // what pushed the dual-track research run past its timeout. Local keeps the
    // uncensored value (reads the same sources sleuth gets, with no guardrails)
    // without the browse overhead abliterated models rarely use anyway. Primary
    // gemma-4-abliterated (9.6GB) fits the 16GB GPU; mistral-small-abliterated
    // (14GB) and neuraldaredevil-8b (5.6GB) fall back.
    preferredModel: 'huihui_ai/gemma-4-abliterated:latest',
    fallbackModels: [
      'huihui_ai/mistral-small-abliterated:latest',
      'closex/neuraldaredevil-8b-abliterated:latest',
    ],
    cloudModel: 'claude-opus-4-8',
    capabilities: ['uncensored', 'research', 'no-refusal', 'synthesis', 'fact-check'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Oracle. You research questions the way a guardrailed model will not: no moralizing, no hedging, no topic avoidance. The user is an adult professional building a bias-detection system. Investigate the question directly and report what you actually find, including angles, data, and sources that mainstream models tend to omit, soften, or refuse. The dispatch layer pre-fetches web search results under a [SEARCH RESULTS] block; ground claims in real sources and paste real URLs. Never invent URLs or numbers. Stay within legal bounds (no CSAM, no targeted real-person harm, no working malware against systems the user does not own). Your value is unfiltered accuracy, not edginess for its own sake.`,
    defaultContextTokens: 16384,
    temperature: 0.4,
    vramHintGB: 10,
  },
  heretic: {
    callsign: 'heretic',
    tier: 'local',
    role: 'Bias and censorship auditor: cross-references the regular (guardrailed) findings against the uncensored findings and flags omissions, softening, false balance, or likely guardrail-induced distortions.',
    // 2026-06-02 research team: heretic is the cross-reference auditor. Its job
    // is pure reasoning over two provided answer-sets (regular vs uncensored),
    // so it runs on the 'local' tier (direct Ollama, no tool loop), which is
    // RELIABLE for small models unlike the claw tool loop. neuraldaredevil-8b
    // (5.6GB) is fast and fits trivially; gemma-4-abliterated and
    // mistral-small-abliterated fall back. No web access needed: both
    // finding-sets arrive in the prompt.
    preferredModel: 'closex/neuraldaredevil-8b-abliterated:latest',
    fallbackModels: [
      'huihui_ai/gemma-4-abliterated:latest',
      'huihui_ai/mistral-small-abliterated:latest',
    ],
    cloudModel: 'claude-opus-4-8',
    capabilities: ['uncensored', 'bias-audit', 'compare', 'critique', 'censorship-detection', 'no-refusal'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Heretic. You are given two sets of findings on the same question: the REGULAR set (from guardrailed cloud models) and the UNCENSORED set (from abliterated models). Cross-reference them and report the delta. Flag: facts present in the uncensored set but missing or softened in the regular set; hedging, false balance, or moralizing that obscures a clear answer; claims that one side asserts and the other contradicts; and anything that looks like a guardrail-induced omission or distortion. For each flag, state which side it came from and rate the risk (low, medium, high). Be blunt and specific. If the two sets substantially agree, say so plainly instead of manufacturing disagreement. Do not invent discrepancies.`,
    defaultContextTokens: 16384,
    temperature: 0.3,
    vramHintGB: 6,
  },
};

export const ALL_CALLSIGNS: SpecialistCallsign[] = Object.keys(
  SPECIALISTS,
) as SpecialistCallsign[];

export interface DelegateResult {
  callsign: SpecialistCallsign;
  modelUsed: string;
  output: string;
  durationMs: number;
  tokenEstimate: number;
  fellBackFrom?: string;
}

/**
 * Resolve the best model for a specialist.
 *   - 'local': returns the first installed Ollama tag from
 *     [preferred, ...fallbacks]. Returns null if nothing in the chain is
 *     available.
 *   - 'cloud': always returns the configured SDK model string. Cloud
 *     auth (Anthropic Max OAuth) is validated at call time, not here.
 */
export async function resolveSpecialistModel(
  callsign: SpecialistCallsign,
): Promise<{ model: string; fellBackFrom?: string } | null> {
  const spec = SPECIALISTS[callsign];
  if (!spec) return null;
  if (spec.tier === 'cloud') {
    return { model: spec.preferredModel };
  }
  const installed = new Set((await ollamaListModels()).map((m) => m.name));
  if (installed.has(spec.preferredModel)) {
    return { model: spec.preferredModel };
  }
  for (const candidate of spec.fallbackModels) {
    if (installed.has(candidate)) {
      return { model: candidate, fellBackFrom: spec.preferredModel };
    }
  }
  // Last resort: any installed model that matches by base name (strip tag).
  const baseName = spec.preferredModel.split(':')[0];
  for (const name of installed) {
    if (name.startsWith(`${baseName}:`)) {
      return { model: name, fellBackFrom: spec.preferredModel };
    }
  }
  return null;
}

export interface DelegateOptions {
  chatId?: string;       // Defaults to ALLOWED_CHAT_ID.
  shareMemory?: boolean; // Default true. Inject hivemind memory context.
  signal?: AbortSignal;
  maxTokens?: number;    // Hard cap on output tokens.
  systemAddendum?: string; // Extra task-specific instructions tacked onto the system prompt.
  // Optional: forward tool_use / tool_result events as the specialist
  // works. The dashboard activity panel reads these to render Claude-Code
  // style cards showing what tools each specialist is running.
  onProgress?: (event: DelegateProgressEvent) => void;
}

// Detect rate-limit / quota / auth errors from the Anthropic SDK so the
// cloud path can fall back to a local specialist instead of failing the
// whole delegation. Match common shapes: HTTP 429, "rate_limit_error",
// "usage_limit", quota messages, and invalid_request_error for bad auth.
function isRateLimitOrQuotaError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('usage limit') ||
    msg.includes('usage_limit') ||
    msg.includes('quota') ||
    msg.includes('overloaded') ||
    msg.includes('too many requests') ||
    msg.includes('5h limit') ||
    msg.includes('plan limit')
  );
}

/**
 * Resolve the effective specialist config given any runtime tier override
 * stored in dashboard_settings. Swaps the relevant model field so each
 * delegate path (claw / cloud / local) finds the right value in
 * `preferredModel` without having to branch on tier internally.
 *
 * Override semantics (only valid transitions):
 *   - claw   → cloud  : preferredModel ← spec.cloudModel (if present)
 *   - claw   → local  : preferredModel kept (already an Ollama tag)
 *   - local  → claw   : preferredModel kept (still an Ollama tag)
 *   - local  → cloud  : preferredModel ← spec.cloudModel (if present)
 *   - cloud  → claw   : preferredModel ← localFallbackModel (legacy field, kept for back-compat)
 *   - cloud  → local  : preferredModel ← localFallbackModel
 *
 * Unrecognized or self-override returns the spec unchanged. Missing
 * required field for a transition (e.g. cloud override but no cloudModel)
 * also returns the spec unchanged so the static default stays correct.
 */
function applyTierOverride(spec: SpecialistConfig): SpecialistConfig {
  let override: string | null;
  try {
    override = getSpecialistTierOverride(spec.callsign);
  } catch {
    return spec;
  }
  if (!override || override === spec.tier) return spec;
  if (override !== 'claw' && override !== 'cloud' && override !== 'local') {
    logger.warn({ callsign: spec.callsign, override }, '[specialists] unknown tier override; ignoring');
    return spec;
  }
  // Determine the right model for the new tier.
  let nextModel = spec.preferredModel;
  if (override === 'cloud') {
    if (!spec.cloudModel) {
      logger.warn(
        { callsign: spec.callsign },
        '[specialists] cloud override requested but spec has no cloudModel; ignoring',
      );
      return spec;
    }
    nextModel = spec.cloudModel;
  } else if (spec.tier === 'cloud') {
    // cloud → claw/local: pull from legacy localFallbackModel if present,
    // otherwise keep preferredModel (which is the SDK string — will likely
    // fail at Ollama lookup; user has to set a model override too).
    nextModel = spec.localFallbackModel || spec.preferredModel;
  }
  return { ...spec, tier: override as SpecialistTier, preferredModel: nextModel };
}

/**
 * Dispatch a task to a specialist. Blocks until the specialist finishes
 * and returns the full output. Logs both sides of the exchange to the
 * shared conversation log and hive_mind table so future turns can see it.
 *
 * Tier behavior:
 *   - 'local': calls Ollama, applies fallbackModels chain, captures both
 *     content and thinking deltas.
 *   - 'claw':  calls claw-code (local Rust harness) bridged to Ollama.
 *   - 'cloud': calls the Anthropic Agent SDK via OAuth (Max plan quota,
 *     no API key). Full tool access by default. On rate-limit / quota
 *     error, automatically delegates to fallbackCallsign (a local
 *     specialist) so the task still completes.
 *
 * The static tier from SPECIALISTS[callsign].tier can be overridden at
 * runtime via dashboard_settings (set through the Settings UI). See
 * applyTierOverride() above.
 */
export async function delegate(
  callsign: SpecialistCallsign,
  task: string,
  opts: DelegateOptions = {},
): Promise<DelegateResult> {
  const baseSpec = SPECIALISTS[callsign];
  if (!baseSpec) throw new Error(`unknown specialist: ${callsign}`);
  if (!task.trim()) throw new Error('task is empty');

  // Apply runtime tier override from dashboard_settings (set via the
  // Settings UI's per-specialist routing controls). When overriding to
  // a tier with a different model field, swap preferredModel so the
  // tier-specific delegate handler can use it without further branching.
  const spec = applyTierOverride(baseSpec);

  // Auto-prefetch web search for the two research roles, sleuth (regular) and
  // oracle (uncensored). Runs once at the top of dispatch so it applies
  // regardless of tier. Cheap (~500ms Brave call), silently no-ops if Brave is
  // unconfigured or returns nothing useful. The augmented task carries the
  // [SEARCH RESULTS] block into every downstream delegate path, which is how
  // oracle stays grounded even when the abliterated model does not tool-call.
  let effectiveTask = task;
  if (callsign === 'sleuth' || callsign === 'oracle') {
    const searchResults = await tryPrefetchWebSearch(task);
    if (searchResults) {
      effectiveTask = `${task}\n\n[SEARCH RESULTS — top ${searchResults.count} from Brave]\n${searchResults.body}\n[/SEARCH RESULTS]`;
    }
  }

  // Cloud path: route through Anthropic Agent SDK. Falls back to a local
  // specialist on rate-limit so dispatch never silently stalls.
  if (spec.tier === 'cloud') {
    return delegateCloud(spec, effectiveTask, opts);
  }

  // Claw path: route through the local claw-code Rust harness bridged to
  // Ollama. This is the default tier for most specialists as of the
  // 2026-05-25 pivot — see [[project-local-specialist-pivot]] in memory.
  if (spec.tier === 'claw') {
    return delegateClaw(spec, effectiveTask, opts);
  }

  const resolved = await resolveSpecialistModel(callsign);
  if (!resolved) {
    throw new Error(
      `no installed model for ${callsign} (wanted ${spec.preferredModel} or fallbacks: ${spec.fallbackModels.join(', ')})`,
    );
  }

  const chatId = opts.chatId || ALLOWED_CHAT_ID || '';
  const agentNs = `specialist:${callsign}`;
  const shareMemory = opts.shareMemory !== false;

  // Persist the inbound task first so it shows up in history even if the
  // model errors mid-stream.
  logConversationTurn(chatId, 'user', task, undefined, agentNs);

  // Build shared hivemind context unless explicitly disabled. We pass
  // agentNs so this specialist's recent turns are eligible, but NOT
  // strictAgentId so memories from every agent in the hivemind flow in.
  let memoryContext = '';
  if (shareMemory) {
    try {
      const built = await buildMemoryContext(chatId, task, agentNs);
      memoryContext = built.contextText || '';
    } catch {
      memoryContext = '';
    }
  }

  const systemPrompt = [
    spec.systemPrompt,
    opts.systemAddendum ? `\n${opts.systemAddendum}` : '',
    memoryContext ? `\n${memoryContext}` : '',
  ]
    .join('\n')
    .trim();

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: effectiveTask },
  ];

  let output = '';
  let thinking = '';
  let evalCount = 0;
  let totalDurationNs = 0;
  const startedAt = Date.now();

  // 2026-05-25 tune: local models are free, so we don't impose a token
  // cap unless the caller explicitly asks for one. Default to Ollama's
  // unlimited sentinel (-1) so thinking models can produce their full
  // reasoning AND a complete final answer without getting cut off. If
  // the caller passes opts.maxTokens, that wins. Thinking-models still
  // get a 4x boost on caller-supplied caps so they can think + answer.
  const thinkingModel = /qwen3|deepseek-r1|gpt-oss/i.test(resolved.model);
  let effectiveMaxTokens: number;
  if (opts.maxTokens) {
    effectiveMaxTokens = thinkingModel
      ? Math.max(opts.maxTokens * 4, 512)
      : opts.maxTokens;
  } else {
    effectiveMaxTokens = -1;  // Ollama: -1 means unlimited / model default cap
  }

  await ollamaChat(
    resolved.model,
    messages,
    (ev) => {
      if (ev.delta) output += ev.delta;
      if (ev.thinkingDelta) thinking += ev.thinkingDelta;
      if (ev.done) {
        evalCount = ev.evalCount || 0;
        totalDurationNs = ev.totalDurationNs || 0;
      }
    },
    {
      temperature: spec.temperature,
      num_ctx: spec.defaultContextTokens,
      num_predict: effectiveMaxTokens,
    },
    opts.signal,
  );

  const durationMs = totalDurationNs > 0
    ? Math.round(totalDurationNs / 1e6)
    : Date.now() - startedAt;

  // Thinking-model fallback: if the model emitted reasoning to the
  // `thinking` channel but ran out of tokens before producing content,
  // surface the thinking so the caller still gets something useful.
  if (!output.trim() && thinking.trim()) {
    output = `[no final answer; partial reasoning]\n${thinking.trim()}`;
  }

  // Persist the result and mirror to hive_mind for cross-agent visibility.
  if (output.trim()) {
    logConversationTurn(chatId, 'assistant', output, undefined, agentNs);
    try {
      logToHiveMind(
        agentNs,
        chatId,
        'specialist-delegate',
        output.slice(0, 240),
        JSON.stringify({
          callsign,
          model: resolved.model,
          fellBackFrom: resolved.fellBackFrom,
          evalCount,
          durationMs,
          taskPreview: task.slice(0, 120),
        }),
      );
    } catch {
      // hive_mind insert is best-effort.
    }
  }

  return {
    callsign,
    modelUsed: resolved.model,
    output,
    durationMs,
    tokenEstimate: evalCount,
    fellBackFrom: resolved.fellBackFrom,
  };
}

// Honesty labels prepended to specialist output we have reason to distrust.
// Both are plain ASCII (no em/en dashes) because they are surfaced verbatim
// to the user and to upstream Jarvis, who must never be handed a fabrication
// as fact. Grounded in the 2026-05-25 bake-off: with zero tool calls, sleuth
// fabricated URLs, sentinel invented port lists, and cipher made up a byte
// count. Labeling (not hiding) keeps the answer available while flagging that
// it is unverified.
export const NO_TOOLS_FALLBACK_NOTICE =
  '[unverified: claw failed, so this answer came from a no-tools fallback model and was NOT checked against files, commands, or the web]';
export const UNGROUNDED_NOTICE =
  '[unverified: produced without any tool calls, so factual claims (paths, URLs, figures) are NOT grounded and may be fabricated]';
// Cloud specialist was rate-limited and degraded to a direct (no tool loop)
// local model. Same fabrication risk as NO_TOOLS_FALLBACK_NOTICE: text-in/
// text-out with no files, commands, or web access. Made live for all 7 cloud
// roles by the 2026-06-01 rebalance, so the quota-degrade answer must carry
// the same honesty flag the claw fallback already does.
export const CLOUD_FALLBACK_NOTICE =
  '[unverified: cloud was rate-limited, so this answer came from a no-tools local fallback model and was NOT checked against files, commands, or the web]';

/**
 * Claw delegation. Local agentic loop via the `claw-code` Rust harness
 * bridged to Ollama. This is the default path for most specialists as of
 * the 2026-05-25 pivot. Free (no Anthropic quota burn), gives the model
 * a real tool loop (read/grep/glob/git/write, plus bash when
 * spec.clawUseFull is true) instead of plain text-in/text-out.
 *
 * Memory persistence and onProgress forwarding match delegateCloud so
 * the activity panel, hivemind log, and conversation log all behave
 * identically regardless of which tier handled the request.
 */
async function delegateClaw(
  spec: SpecialistConfig,
  task: string,
  opts: DelegateOptions,
): Promise<DelegateResult> {
  const chatId = opts.chatId || ALLOWED_CHAT_ID || '';
  const agentNs = `specialist:${spec.callsign}`;
  const shareMemory = opts.shareMemory !== false;
  const startedAt = Date.now();

  // Log the inbound task under specialist:<callsign> so it shows up in
  // the per-specialist history feed even if claw errors mid-run.
  logConversationTurn(chatId, 'user', task, undefined, agentNs);

  let memoryContext = '';
  if (shareMemory) {
    try {
      const built = await buildMemoryContext(chatId, task, agentNs);
      memoryContext = built.contextText || '';
    } catch {
      memoryContext = '';
    }
  }

  // (Sleuth prefetch happens at the top-level delegate() so it applies
  // to every tier path, not just claw. Task here is already augmented if
  // applicable.)

  const systemAddendum = [
    spec.systemPrompt,
    opts.systemAddendum ? `\n${opts.systemAddendum}` : '',
    memoryContext ? `\n${memoryContext}` : '',
  ]
    .join('\n')
    .trim();

  // Pre-resolve the Ollama tag — if the preferred model isn't installed,
  // pick a fallback BEFORE spawning claw so we fail fast with a clear
  // error instead of churning through a subprocess that's doomed to
  // ENOENT-from-Ollama mid-flight.
  const resolved = await resolveSpecialistModel(spec.callsign);
  if (!resolved) {
    const errMsg = `[claw] no installed Ollama model for ${spec.callsign} (preferred=${spec.preferredModel}, fallbacks=${spec.fallbackModels.join(',') || 'none'})`;
    logger.error({ callsign: spec.callsign }, errMsg);
    return {
      callsign: spec.callsign,
      modelUsed: spec.preferredModel,
      output: errMsg,
      durationMs: Date.now() - startedAt,
      tokenEstimate: 0,
    };
  }

  // Workspace selection. Any claw specialist that has full claw (bash
  // enabled) needs to run inside the actual project root so bash has
  // real files to operate on. Writes are still gated by clawPermission
  // (read-only blocks file mutations even with workspace access). Only
  // a read-only specialist with no bash gets an ephemeral tempdir.
  const needsProjectWorkspace = spec.clawPermission === 'workspace-write'
    || spec.clawUseFull === true;
  const workspace = needsProjectWorkspace ? PROJECT_ROOT : undefined;

  // Run claw. AbortSignal flows through so /stop in the dashboard kills
  // the subprocess immediately.
  const result = await runClaw({
    model: resolved.model,
    task,
    systemAddendum,
    workspace,
    permission: spec.clawPermission ?? 'read-only',
    maxTurns: spec.clawMaxTurns ?? 24,
    signal: opts.signal,
    useFullClaw: spec.clawUseFull === true,
    disableFilesystemSandbox: spec.clawDisableFilesystemSandbox === true,
    onProgress: opts.onProgress,
  });

  const durationMs = Date.now() - startedAt;
  const output = (result.text || '').trim();

  // Local-model fallback: if claw errored AND we have a non-preferred
  // Ollama tag in fallbackModels, retry the simplest possible path
  // (direct ollamaChat, no tool loop) so the user still gets *some*
  // answer rather than a bare error.
  if (!output && result.error && spec.fallbackModels.length > 0) {
    logger.warn(
      { callsign: spec.callsign, error: result.error.slice(0, 200) },
      '[claw] failed — attempting direct-ollama fallback',
    );
    try {
      const fallbackModel = spec.fallbackModels[0];
      let fallbackOut = '';
      await ollamaChat(
        fallbackModel,
        [
          { role: 'system', content: systemAddendum },
          { role: 'user', content: task },
        ],
        (ev) => { if (ev.delta) fallbackOut += ev.delta; },
        {
          temperature: spec.temperature,
          num_ctx: spec.defaultContextTokens,
        },
        opts.signal,
      );
      if (fallbackOut.trim()) {
        // This answer came from a no-tools fallback model after claw failed,
        // so it was never checked against files, commands, or the web. Label
        // it as unverified before it propagates to the user or to Jarvis.
        const labeledFallback = `${NO_TOOLS_FALLBACK_NOTICE}\n\n${fallbackOut.trim()}`;
        logConversationTurn(chatId, 'assistant', labeledFallback, undefined, agentNs);
        // Mirror the success path's hive_mind write so the dashboard activity
        // panel and the bake-off harness can both see what happened. Without
        // this, a claw failure that successfully fell back to direct Ollama
        // looked identical to a total no-op in the DB (see sleuth in bake-off
        // v4: claw produced "no content", mistral fallback fabricated a fake
        // response, no row was ever written, harness reported toolCalls=-1).
        // Tagged with action 'specialist-delegate-claw-fallback' so consumers
        // can distinguish primary-path runs from fallback-path runs.
        try {
          logToHiveMind(
            agentNs,
            chatId,
            'specialist-delegate-claw-fallback',
            fallbackOut.slice(0, 240),
            JSON.stringify({
              callsign: spec.callsign,
              tier: 'claw-fallback',
              model: fallbackModel,
              toolCalls: 0,             // direct ollamaChat has no tool loop
              turns: 1,                 // single shot
              durationMs: Date.now() - startedAt,
              stopReason: 'fallback-from-claw-error',
              fellBackFrom: spec.preferredModel,
              clawError: result.error ? result.error.slice(0, 200) : null,
              unverified: true,
              taskPreview: task.slice(0, 120),
            }),
          );
        } catch {
          // best-effort
        }
        return {
          callsign: spec.callsign,
          modelUsed: fallbackModel,
          output: labeledFallback,
          durationMs: Date.now() - startedAt,
          tokenEstimate: 0,
          fellBackFrom: spec.preferredModel,
        };
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        '[claw] direct-ollama fallback also failed',
      );
    }
  }

  // Anti-fabrication critic: a specialist flagged expectsToolUse MUST ground
  // its answer in tool calls (research, sysadmin, security, memory retrieval).
  // If it returned with zero tool calls, the prose is ungrounded and may be
  // fabricated, so label it before it propagates. Prose/vision/reasoning roles
  // leave expectsToolUse unset, so a tool-less answer there stays unlabeled.
  const ungrounded = spec.expectsToolUse === true && result.toolCalls === 0 && !!output;
  const finalOutput = ungrounded ? `${UNGROUNDED_NOTICE}\n\n${output}` : output;
  if (ungrounded) {
    logger.warn(
      { callsign: spec.callsign, model: resolved.model, turns: result.turns },
      '[claw] tool-required specialist produced zero tool calls; labeling output as ungrounded',
    );
  }

  if (finalOutput) {
    logConversationTurn(chatId, 'assistant', finalOutput, undefined, agentNs);
    try {
      logToHiveMind(
        agentNs,
        chatId,
        'specialist-delegate-claw',
        finalOutput.slice(0, 240),
        JSON.stringify({
          callsign: spec.callsign,
          tier: 'claw',
          model: spec.preferredModel,
          toolCalls: result.toolCalls,
          turns: result.turns,
          durationMs: result.durationMs,
          stopReason: result.stopReason,
          usage: result.usage,
          // Surface claw-runner's retry telemetry so the dashboard can show
          // "this specialist retried once due to stray XML tool syntax".
          // retryAttempts is 0/undefined on clean runs, 1 when a retry fired.
          retryAttempts: result.retryAttempts,
          strayToolSyntax: result.strayToolSyntax,
          ungrounded,
          taskPreview: task.slice(0, 120),
        }),
      );
    } catch {
      // best-effort
    }
  }

  // Emit a synthetic Reasoning card for tool-less responses so the
  // activity panel always shows something — same UX trick as in
  // delegateCloud, kept identical for consistency across tiers.
  if (result.toolCalls === 0 && opts.onProgress && finalOutput) {
    const synthId = `response-${spec.callsign}-${Date.now()}`;
    const preview = task.length > 80 ? task.slice(0, 80) + '...' : task;
    opts.onProgress({
      type: 'tool_use',
      description: `Reasoning: ${preview}`,
      toolUseId: synthId,
      toolName: 'Reasoning',
      input: task.length > 4000 ? task.slice(0, 4000) + '\n…[truncated]' : task,
    });
    const cappedOut = finalOutput.length > 4000 ? finalOutput.slice(0, 4000) + '\n…[truncated]' : finalOutput;
    opts.onProgress({
      type: 'tool_result',
      description: '',
      toolUseId: synthId,
      output: cappedOut,
    });
  }

  return {
    callsign: spec.callsign,
    modelUsed: resolved.model,
    output: finalOutput || (result.error ? `[claw error] ${result.error}` : '[no output]'),
    durationMs,
    tokenEstimate: result.usage?.total_tokens || 0,
    fellBackFrom: resolved.fellBackFrom,
  };
}

/**
 * Cloud delegation via Anthropic Agent SDK. Uses OAuth credentials
 * (Anthropic Max plan quota), NOT an API key — so no per-token billing.
 * Inherits the same auth that powers Jarvis main. On rate-limit / quota
 * exhaustion, recursively delegates to the configured fallbackCallsign
 * (a local specialist) so work doesn't stall.
 */
async function delegateCloud(
  spec: SpecialistConfig,
  task: string,
  opts: DelegateOptions,
): Promise<DelegateResult> {
  const chatId = opts.chatId || ALLOWED_CHAT_ID || '';
  const agentNs = `specialist:${spec.callsign}`;
  const shareMemory = opts.shareMemory !== false;
  const startedAt = Date.now();

  // Log inbound first so the task shows up even if the SDK errors.
  logConversationTurn(chatId, 'user', task, undefined, agentNs);

  let memoryContext = '';
  if (shareMemory) {
    try {
      const built = await buildMemoryContext(chatId, task, agentNs);
      memoryContext = built.contextText || '';
    } catch {
      memoryContext = '';
    }
  }

  const systemPrompt = [
    spec.systemPrompt,
    opts.systemAddendum ? `\n${opts.systemAddendum}` : '',
    memoryContext ? `\n${memoryContext}` : '',
  ]
    .join('\n')
    .trim();

  // Anthropic Agent SDK call. OAuth auth is picked up automatically from
  // the parent process credentials (~/.claude/credentials.json or env).
  // We pass the system prompt via prompt prefix because the SDK's
  // single-turn helper doesn't expose a separate system field cleanly.
  // permissionMode 'bypassPermissions' grants full tool access without
  // per-call prompts — same posture Jarvis main runs with.
  let output = '';
  let toolCalls = 0;
  let didCompact = false;
  const abortController = opts.signal
    ? (() => {
        const ctrl = new AbortController();
        opts.signal!.addEventListener('abort', () => ctrl.abort());
        return ctrl;
      })()
    : new AbortController();

  try {
    for await (const event of query({
      prompt: `${systemPrompt}\n\n---\n\nTask:\n${task}`,
      options: {
        cwd: PROJECT_ROOT,
        settingSources: ['project', 'user'],
        permissionMode: spec.cloudAllowTools !== false ? 'bypassPermissions' : 'default',
        allowDangerouslySkipPermissions: spec.cloudAllowTools !== false,
        ...(AGENT_MAX_TURNS > 0 ? { maxTurns: AGENT_MAX_TURNS } : {}),
        model: spec.preferredModel,
        // NOTE: the Agent SDK exposes no temperature option (only extraArgs, a raw
        // CLI passthrough with no --temperature flag), so spec.temperature cannot be
        // applied on the cloud path. Cloud agents run at the SDK default; quality is
        // tuned via prompt + model. spec.temperature governs only local/claw paths.
        abortController,
      },
    })) {
      const ev = event as Record<string, unknown>;
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        didCompact = true;
      }
      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'] as Array<{
          type: string;
          id?: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              output += block.text;
            } else if (block.type === 'tool_use') {
              toolCalls++;
              // Forward to the caller (dashboard activity panel etc.) so
              // viewers can see what this specialist is doing in real time.
              if (opts.onProgress && block.name) {
                let detail = '';
                if (block.input) {
                  if (block.name === 'Bash' && typeof block.input['command'] === 'string') {
                    const cmd = block.input['command'] as string;
                    detail = cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
                  } else if ((block.name === 'Read' || block.name === 'Write' || block.name === 'Edit') && typeof block.input['file_path'] === 'string') {
                    const fp = block.input['file_path'] as string;
                    detail = fp.split('/').pop() || fp;
                  } else if (block.name === 'Grep' && typeof block.input['pattern'] === 'string') {
                    detail = block.input['pattern'] as string;
                  } else if (block.name === 'Glob' && typeof block.input['pattern'] === 'string') {
                    detail = block.input['pattern'] as string;
                  } else if (block.name === 'WebSearch' && typeof block.input['query'] === 'string') {
                    detail = block.input['query'] as string;
                  } else if (block.name === 'WebFetch' && typeof block.input['url'] === 'string') {
                    detail = block.input['url'] as string;
                  }
                }
                const label = detail ? `${toolLabel(block.name)}: ${detail}` : toolLabel(block.name);
                opts.onProgress({ type: 'tool_active', description: label });
                if (block.id) {
                  const inputJson = (() => {
                    try { return JSON.stringify(block.input ?? {}, null, 2); }
                    catch { return String(block.input ?? ''); }
                  })();
                  opts.onProgress({
                    type: 'tool_use',
                    description: label,
                    toolUseId: block.id,
                    toolName: block.name,
                    input: inputJson.length > 4000 ? inputJson.slice(0, 4000) + '\n…[truncated]' : inputJson,
                  });
                }
              }
            }
          }
        }
      }
      // Tool RESULTS arrive as user-role events with tool_result blocks.
      if (ev['type'] === 'user' && opts.onProgress) {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'] as Array<{
          type: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              let resultText = '';
              if (typeof block.content === 'string') {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                resultText = block.content
                  .map((p: unknown) => {
                    if (typeof p === 'string') return p;
                    if (p && typeof p === 'object' && 'text' in p) return String((p as { text: unknown }).text ?? '');
                    return '';
                  })
                  .join('\n');
              } else if (block.content != null) {
                try { resultText = JSON.stringify(block.content); }
                catch { resultText = String(block.content); }
              }
              const trimmed = resultText.length > 4000
                ? resultText.slice(0, 4000) + '\n…[truncated]'
                : resultText;
              opts.onProgress({
                type: 'tool_result',
                description: block.is_error ? '[error]' : '',
                toolUseId: block.tool_use_id,
                output: trimmed,
              });
            }
          }
        }
      }
      if (ev['type'] === 'result') {
        // Final result event — capture full text if not already streamed
        const result = ev['result'] as string | undefined;
        if (result && !output) output = result;
      }
    }
  } catch (err) {
    // Cloud failed. Try fallbacks in order:
    //   1. Direct local model (spec.localFallbackModel) — fastest path to a
    //      working answer, doesn't pile on another likely-rate-limited cloud
    //      specialist. This is the primary failover after 2026-05-23 when
    //      most specialists became cloud-primary.
    //   2. Redirect to another specialist (spec.fallbackCallsign) — legacy
    //      orchestration path. Useful when localFallbackModel can't handle
    //      this kind of task and there's a sibling specialist that can.
    if (isRateLimitOrQuotaError(err)) {
      // Priority 1: direct local model.
      if (spec.localFallbackModel) {
        logger.warn(
          { callsign: spec.callsign, localFallbackModel: spec.localFallbackModel, err: String(err).slice(0, 200) },
          'cloud specialist rate-limited, falling back to local model directly',
        );
        try {
          logToHiveMind(
            agentNs, chatId, 'specialist-cloud-to-local-fallback',
            `${spec.callsign}: ${spec.preferredModel} → ${spec.localFallbackModel}`,
            JSON.stringify({ error: String(err).slice(0, 200), unverified: true }),
          );
        } catch { /* best-effort */ }

        try {
          let localOutput = '';
          let localThinking = '';
          await ollamaChat(
            spec.localFallbackModel,
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: task },
            ],
            (ev) => {
              if (ev.delta) localOutput += ev.delta;
              if (ev.thinkingDelta) localThinking += ev.thinkingDelta;
            },
            {
              temperature: spec.temperature,
              num_ctx: spec.defaultContextTokens || 16384,
              // Local is free; default to unlimited unless caller capped it.
              num_predict: opts.maxTokens ?? -1,
            },
            opts.signal,
          );
          if (!localOutput.trim() && localThinking.trim()) {
            localOutput = `[no final answer; partial reasoning]\n${localThinking.trim()}`;
          }
          // No-tools local degrade: label it unverified before it reaches the
          // user or Jarvis, exactly as the claw no-tools fallback does above.
          const labeledLocalOutput = localOutput.trim()
            ? `${CLOUD_FALLBACK_NOTICE}\n\n${localOutput.trim()}`
            : '[local fallback produced no output]';
          if (localOutput.trim()) {
            logConversationTurn(chatId, 'assistant', labeledLocalOutput, undefined, agentNs);
          }
          return {
            callsign: spec.callsign,
            modelUsed: spec.localFallbackModel,
            output: labeledLocalOutput,
            durationMs: Date.now() - startedAt,
            tokenEstimate: 0,
            fellBackFrom: spec.preferredModel,
          };
        } catch (localErr) {
          logger.warn(
            { callsign: spec.callsign, err: localErr instanceof Error ? localErr.message : String(localErr) },
            'local fallback model also failed; falling through to callsign redirect',
          );
          // intentional fall-through to fallbackCallsign branch below
        }
      }

      // Priority 2: redirect to a different specialist (legacy orchestration).
      if (spec.fallbackCallsign) {
        logger.warn(
          { callsign: spec.callsign, fallback: spec.fallbackCallsign, err: String(err).slice(0, 200) },
          'cloud specialist rate-limited, redirecting to fallback callsign',
        );
        try {
          logToHiveMind(
            agentNs, chatId, 'specialist-callsign-redirect',
            `${spec.callsign} → ${spec.fallbackCallsign}`,
            JSON.stringify({ error: String(err).slice(0, 200) }),
          );
        } catch { /* best-effort */ }
        const fallbackResult = await delegate(spec.fallbackCallsign, task, opts);
        return {
          ...fallbackResult,
          fellBackFrom: spec.preferredModel,
        };
      }
    }
    throw err;
  }

  const durationMs = Date.now() - startedAt;

  // If the specialist generated a response without calling any tools
  // (e.g. archivist synthesizing from memory context alone), the activity
  // panel would render nothing under the route header. Emit a synthetic
  // "Response" card so every routed task has at least one visible row
  // showing what the specialist actually said.
  if (toolCalls === 0 && opts.onProgress && output.trim()) {
    const synthId = `response-${spec.callsign}-${Date.now()}`;
    const preview = task.length > 80 ? task.slice(0, 80) + '...' : task;
    opts.onProgress({
      type: 'tool_use',
      description: `Reasoning: ${preview}`,
      toolUseId: synthId,
      toolName: 'Reasoning',
      input: task.length > 4000 ? task.slice(0, 4000) + '\n…[truncated]' : task,
    });
    const out = output.length > 4000 ? output.slice(0, 4000) + '\n…[truncated]' : output;
    opts.onProgress({
      type: 'tool_result',
      description: '',
      toolUseId: synthId,
      output: out,
    });
  }

  if (output.trim()) {
    logConversationTurn(chatId, 'assistant', output, undefined, agentNs);
    try {
      logToHiveMind(
        agentNs,
        chatId,
        'specialist-delegate-cloud',
        output.slice(0, 240),
        JSON.stringify({
          callsign: spec.callsign,
          tier: 'cloud',
          model: spec.preferredModel,
          toolCalls,
          didCompact,
          durationMs,
          taskPreview: task.slice(0, 120),
        }),
      );
    } catch {
      // Best-effort.
    }
  }

  return {
    callsign: spec.callsign,
    modelUsed: spec.preferredModel,
    output: output.trim() || '[cloud specialist produced no output]',
    durationMs,
    tokenEstimate: 0, // SDK doesn't surface this cleanly; usage tab tracks separately
  };
}

/**
 * Keyword routing table. Order matters: more specific specialists first.
 * Cloud supervisors come AFTER local specialists for routine work (so we
 * don't burn Max quota on tasks a local can handle), but BEFORE the 'self'
 * fallback when the task is heavy-reasoning or tool-heavy. Each callsign
 * appears exactly once, so a task's matched-domain count is the number of
 * distinct entries it trips (see matchedSpecialists).
 */
const ROUTING_RULES: Array<[SpecialistCallsign, string[]]> = [
  ['coder', ['refactor', 'unit test', 'compile', 'typescript', 'python', 'javascript', 'lint', 'stack trace', 'syntax', 'codebase']],
  ['eye', ['image', 'photo', 'screenshot', 'ocr', 'video frame', 'picture', 'what is in this', 'analyze this image']],
  ['cipher', ['csv', 'json data', 'spreadsheet', 'dataset', 'statistics', 'count rows', 'group by']],
  ['sentinel', ['systemd', 'systemctl', 'journalctl', 'log file', 'crash log', 'restart', 'cron', 'deployment', 'health check']],
  ['reaper', ['uncensored', 'no guardrail', 'red team', 'jailbreak', 'security research', 'no warnings']],
  ['archivist', ['memory', 'remember', 'recall', 'consolidate', 'dedupe', 'salience']],
  ['sleuth', ['research', 'find out about', 'who is', 'what is the latest', 'sources', 'citations']],
  ['scribe', ['summarize', 'rewrite', 'draft', 'format this', 'tldr', 'clean up text', 'caption']],
  // Cloud supervisors — invoked when the task is heavyweight or
  // explicitly named. Atlas for deep / strategic / architectural work,
  // Mercury for parallel scout / fast turn-around.
  ['atlas', ['deep dive', 'architecture review', 'plan this out', 'strategic', 'long-form', 'review the design', 'post-mortem', 'opus']],
  ['mercury', ['quick scout', 'parallel', 'fast draft', 'spin up', 'spin out', 'sonnet']],
  // 2026-06-02 research team. Multi-word keys on purpose, so a plain
  // "research X" still routes to sleuth rather than these. The dual-track
  // research flow itself is driven by Jarvis (persona recipe), not these
  // single-pick keywords; they mainly make each role reachable on its own.
  ['prism', ['research analysis', 'analyze the findings', 'analyze the research', 'verify these claims', 'source quality', 'cross-reference sources']],
  ['oracle', ['uncensored research', 'unfiltered research', 'no-guardrail research', 'uncensored take']],
  ['heretic', ['bias check', 'censorship check', 'check for bias', 'guardrail bias', 'cross-check for bias', 'bias audit']],
];

/** Planning / orchestration triggers that keep a task with Jarvis. */
const SELF_MARKERS = [
  'plan', 'orchestrate', 'decide', 'what should i', 'help me think',
  'figure out', 'strategy', 'design the', 'architect',
];

/**
 * Routing helper. Given a task description, suggest the best specialist
 * or 'self' (meaning Jarvis handles it). This is intentionally simple
 * keyword-based; the smarter version uses an LLM router. Either way,
 * Jarvis has final say. Returns the FIRST matching specialist — callers
 * that need the multi-domain picture use matchedSpecialists().
 */
export function suggestRoute(taskDescription: string): SpecialistCallsign | 'self' {
  const t = taskDescription.toLowerCase();

  // Hard "stay with Jarvis" triggers: anything ambiguous, planning,
  // multi-step orchestration, novel reasoning.
  for (const m of SELF_MARKERS) if (t.includes(m)) return 'self';

  for (const [callsign, keywords] of ROUTING_RULES) {
    for (const kw of keywords) {
      if (t.includes(kw)) return callsign;
    }
  }

  return 'self';
}

/**
 * Every distinct specialist domain a task's keywords touch, in rule order.
 *
 * This is what makes Jarvis an orchestrator instead of a switchboard: a
 * request like "research the latest X, refactor the parser, and summarize
 * the result" trips sleuth + coder + scribe. suggestRoute would ship the
 * whole thing to whichever matched first; intelligentRoute instead sees the
 * multi-domain signal and routes to 'self' so Jarvis can decompose it and
 * fan the parts out to his team (delegate / delegate_parallel), several at
 * once. Single-domain tasks return a one-element array and keep their fast
 * keyword path. SELF_MARKERS are deliberately NOT counted here; they are
 * handled by suggestRoute's own self short-circuit.
 */
export function matchedSpecialists(taskDescription: string): SpecialistCallsign[] {
  const t = taskDescription.toLowerCase();
  const hits: SpecialistCallsign[] = [];
  for (const [callsign, keywords] of ROUTING_RULES) {
    if (keywords.some((kw) => t.includes(kw)) && !hits.includes(callsign)) {
      hits.push(callsign);
    }
  }
  return hits;
}

/**
 * Smart auto-router. Staged fallback chain (Gabe explicitly requested
 * the smartest available model do the routing, since misroutes waste
 * specialist work):
 *
 *   0. Multi-domain check (~1ms). If the task trips 2+ distinct specialist
 *      domains, return 'self' so Jarvis decomposes it and fans the parts
 *      out to his team in parallel. This runs FIRST so a multi-part request
 *      never collapses onto whichever specialist matched first.
 *   1. Keyword fast-path via suggestRoute (~1ms). If it returns a specific
 *      callsign, trust it — those keywords are unambiguous and burning a
 *      cloud call on them would be wasteful.
 *   2. If keyword returns 'self' AND the task is non-trivial (≥20 chars),
 *      invoke Claude Opus 4.8 via the agent SDK (~3-4s). Opus is the
 *      smartest tier — closest to Jarvis-grade judgment on which specialist
 *      best fits a nuanced task. Runs in single-turn lightweight mode
 *      (no MCP, no CLAUDE.md load).
 *   3. If Opus fails (rate-limit, auth issue, network), fall back to
 *      mistral-small:24b on local Ollama. Non-thinking 24b model — slower
 *      than Opus and a bit dumber, but always available offline.
 *   4. If both fail, default to 'self' so Jarvis handles.
 *
 * Never throws — routing is best-effort and must always return something.
 * Gabe is on Anthropic Max so cloud quota is effectively unlimited; the
 * local fallback is purely for the "should never happen" cases.
 */
export async function intelligentRoute(task: string): Promise<{
  callsign: SpecialistCallsign | 'self';
  source: 'keyword' | 'opus' | 'local-fallback' | 'fallback';
  reason: string;
}> {
  // ── Stage 0: multi-domain detection ──────────────────────────────────
  // If the task spans 2+ distinct specialist domains, no single specialist
  // can finish it well. Hand it to Jarvis ('self') so he decomposes it and
  // fans the parts out to his team, running independent parts at once via
  // delegate_parallel. This is the orchestration path Jarvis exists for, and
  // it runs BEFORE the single-pick keyword/Opus stages so a multi-part
  // request never collapses onto whichever specialist matched first.
  const domains = matchedSpecialists(task);
  if (domains.length >= 2) {
    return {
      callsign: 'self',
      source: 'keyword',
      reason: `multi-domain task touches ${domains.map((d) => '@' + d).join(', ')} so Jarvis decomposes and delegates`,
    };
  }

  const keywordPick = suggestRoute(task);
  if (keywordPick !== 'self') {
    return {
      callsign: keywordPick,
      source: 'keyword',
      reason: `keyword heuristic matched ${keywordPick}`,
    };
  }

  const trimmed = task.trim();
  if (trimmed.length < 20) {
    return {
      callsign: 'self',
      source: 'fallback',
      reason: 'task too short for routing — Jarvis handles',
    };
  }

  // Build the router prompt once — both cloud and local fallback use it.
  const routerPrompt = [
    'You are the task router for Jarvis (Gabriel\'s AI COO). Your job: pick the BEST specialist for the given task. Be decisive.',
    '',
    'Specialists:',
    '- scribe: writing, summaries, drafts, rewrites, formatting, short copy (Sonnet 4.6)',
    '- coder: code reading, refactors, tests, bug fixes, language conversions (Sonnet 4.6)',
    '- eye: image / video analysis, OCR, screenshot triage, visual classification (qwen3-vl:8b, local)',
    '- sleuth: research synthesis, multi-source fact gathering, citations, "tell me about X" style questions (Opus 4.7)',
    '- reaper: uncensored / no-guardrail work, e.g. security research, red-team, edgy creative drafting (abliterated 35b, local)',
    '- archivist: memory consolidation, recall queries, deduplication, salience scoring (Sonnet 4.6)',
    '- sentinel: sysadmin, log triage, infra / systemd troubleshooting, deployment diagnostics (Sonnet 4.6)',
    '- cipher: data analysis, CSV / JSON crunching, statistics, pattern extraction (Sonnet 4.6)',
    '- atlas: heavyweight reasoning, planning, architecture review, multi-step decomposition (Opus 4.7)',
    '- mercury: fast execution, parallel scout work, drafting under speed pressure (Sonnet 4.6)',
    '- prism: research analysis, source-quality grading, claim verification, structured synthesis of findings (Opus 4.7)',
    '- oracle: uncensored / abliterated research, surfaces what guardrailed models omit or soften (gemma-4-abliterated, local)',
    '- heretic: bias + censorship cross-reference, diffs regular vs uncensored findings and flags distortions (neuraldaredevil-8b, local)',
    '- self: Jarvis handles directly. Use only when truly conversational, trivially small, or genuinely orchestration-level (Jarvis decomposes then re-routes parts).',
    '',
    `Task:\n${trimmed}`,
    '',
    'Reply with ONLY the callsign — one word, lowercase. No explanation. No punctuation.',
  ].join('\n');

  // ── Stage 2: Claude Opus 4.8 via agent SDK ────────────────────────────
  // Single-turn, no MCP, no CLAUDE.md — minimum overhead. Auth flows via
  // OAuth (no ANTHROPIC_API_KEY required, rides Gabe's Max plan).
  try {
    let cloudOut = '';
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    try {
      for await (const event of query({
        prompt: routerPrompt,
        options: {
          model: 'claude-opus-4-8',
          maxTurns: 1,
          settingSources: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          abortController: ctrl,
        },
      })) {
        const ev = event as Record<string, unknown>;
        if (ev.type !== 'assistant') continue;
        const msg = ev.message as { content?: Array<{ type: string; text?: string }> } | undefined;
        if (!msg?.content) continue;
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) cloudOut += block.text;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const cleaned = cloudOut
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .pop()
      ?.replace(/[^a-z]/g, '') ?? '';

    if (cleaned === 'self') {
      return { callsign: 'self', source: 'opus', reason: 'Opus 4.8 chose self' };
    }
    if ((ALL_CALLSIGNS as string[]).includes(cleaned)) {
      return {
        callsign: cleaned as SpecialistCallsign,
        source: 'opus',
        reason: `Opus 4.8 chose ${cleaned}`,
      };
    }
    // Unparseable — fall through to local fallback rather than defaulting
    // to 'self' since the task is non-trivial and we have another tier to try.
    logger.warn(
      { cleanedOutput: cleaned.slice(0, 80), rawLen: cloudOut.length },
      'Opus router returned unparseable response, falling through to local fallback',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Opus router failed, falling through to local mistral fallback',
    );
  }

  // ── Stage 3: local fallback — mistral-small:24b ────────────────────────
  // Should rarely trigger (Max plan = effectively unlimited quota). Mistral
  // is non-thinking so it answers within a tight num_predict budget without
  // burning it on hidden reasoning.
  const LOCAL_FALLBACK_MODEL = 'mistral-small:24b';
  try {
    let localOut = '';
    await ollamaChat(
      LOCAL_FALLBACK_MODEL,
      [{ role: 'user', content: routerPrompt }],
      (ev) => { if (ev.delta) localOut += ev.delta; },
      { temperature: 0.0, num_ctx: 2048, num_predict: 16 },
    );

    const cleaned = localOut
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .pop()
      ?.replace(/[^a-z]/g, '') ?? '';

    if (cleaned === 'self') {
      return { callsign: 'self', source: 'local-fallback', reason: 'mistral-small chose self (Opus unavailable)' };
    }
    if ((ALL_CALLSIGNS as string[]).includes(cleaned)) {
      return {
        callsign: cleaned as SpecialistCallsign,
        source: 'local-fallback',
        reason: `mistral-small chose ${cleaned} (Opus unavailable)`,
      };
    }
    return {
      callsign: 'self',
      source: 'fallback',
      reason: `local fallback returned unparseable: "${cleaned.slice(0, 40)}" — defaulting to self`,
    };
  } catch (err) {
    return {
      callsign: 'self',
      source: 'fallback',
      reason: `both Opus and local fallback failed; defaulting to self. Last error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Web search pre-fetch (for sleuth) ──────────────────────────────
// Sleuth runs as claw-analog, which has no MCP and no bash — it can't
// call /api/web/search itself. This helper pre-fetches results from the
// local Brave-backed endpoint and returns a model-friendly summary block
// the caller can inject into the task. Returns null if the endpoint is
// unconfigured, the call fails, or no results come back. Always non-fatal.
//
// 2026-05-25 tighten: sleuth is now full-claw with bash, so it can curl
// search results itself when actually needed. The prefetch is still useful
// for question-shaped tasks (skips a tool round-trip), but actively harmful
// for bash-shaped tasks where it injects a [SEARCH RESULTS] block that has
// nothing to do with the real instruction. That bloat appeared to be the
// trigger for the "assistant stream produced no content" failure in
// bake-off v4 sleuth. Skip prefetch unless the task looks like a question.
function looksLikeSearchTask(task: string): boolean {
  const t = task.toLowerCase();
  // Explicit "do not search" markers: bash/code/curl instructions.
  if (/\b(run via bash|run via curl|execute the command|run the command|via bash:|via curl:)\b/.test(t)) {
    return false;
  }
  if (/^\s*(bash|curl|sh|python|node)\s+/.test(t)) return false;
  // Positive markers: question words, search verbs, "?".
  if (t.includes('?')) return true;
  if (/\b(what|who|when|where|why|how|which)\b/.test(t)) return true;
  if (/\b(find|search|look up|tell me about|research|news|latest|current|today)\b/.test(t)) return true;
  return false;
}

async function tryPrefetchWebSearch(
  task: string,
): Promise<{ count: number; body: string } | null> {
  // Don't burn Brave quota on tasks that obviously don't need search.
  // Heuristic: skip if the task is very short OR matches a "synthesize
  // these sources I provided" shape (already has URLs / quoted material)
  // OR doesn't look like a research question (the 2026-05-25 tighten).
  const trimmed = task.trim();
  if (trimmed.length < 8) return null;
  if (!looksLikeSearchTask(trimmed)) return null;
  // Build a focused query — drop long context blocks and use the first
  // ~140 chars of the task as the query basis. The user's actual ask is
  // usually at the front; downstream context is for grounding.
  const query = trimmed.slice(0, 140).replace(/\s+/g, ' ').trim();
  if (!query) return null;

  const port = process.env.DASHBOARD_PORT || '3141';
  const token = DASHBOARD_TOKEN;
  if (!token) return null;
  const url = `http://127.0.0.1:${port}/api/web/search?token=${encodeURIComponent(token)}&q=${encodeURIComponent(query)}&count=8`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{ title: string; url: string; snippet?: string; age?: string }>;
    };
    const results = data.results || [];
    if (results.length === 0) return null;
    const body = results
      .map((r, i) => {
        const age = r.age ? ` (${r.age})` : '';
        return `${i + 1}. ${r.title}${age}\n   ${r.url}\n   ${(r.snippet || '').slice(0, 500)}`;
      })
      .join('\n\n');
    return { count: results.length, body };
  } catch {
    return null;
  }
}
