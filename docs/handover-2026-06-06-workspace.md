# Handover - 2026-06-06 (Workspace: projects + research hub)

Branch `main`. Build + deploy authorized via the busy-guarded restart endpoint.
Gabe's ask: "create a tab where I can work and do research with jarvis and my team
... create projects, goals, tasks, and organize everything ... a place where
research papers, sources, video ideas, key points, transcripts, research videos,
video links, research analysis all can live ... sections ... like Claude Projects.
Also cleanup my mission control."

Confirmed choices (AskUserQuestion): new dedicated **Workspace** sidebar section;
Mission Control cleanup = **visual declutter + polish**; **full v1** scope.

## What shipped

A Claude-Projects-style Workspace tab. Each project has Instructions (context fed
to Jarvis on every research run), Goals, Tasks (checkable), and a Research library
covering papers, sources, notes, video ideas, key points, transcripts, research
videos, video links, and analysis. A "Research with Jarvis and the team" composer
runs the dual-track research recipe and files the synthesized report (with a
Censorship / Bias Delta section) straight back into the project's research library.

## 1. Data model (`src/db.ts`)

Two new tables in `createSchema()` (auto-created on boot, verified live):
- **projects**: id, name, description, instructions, status (active/archived),
  color, created_by, created_at, updated_at, last_worked_at.
- **project_items**: a single flexible store discriminated by `kind`
  (goal | task | research). Columns: project_id, kind, category (research category
  or null), title, content, url, source, status (goal/task: open|doing|done;
  research: null|running|done|failed), assigned_agent, metadata, pinned,
  sort_order, created_by, timestamps.
- `runMigrations()` adds `project_id` + `project_item_id` to `mission_tasks` (the
  link from a research run back to the item it fills).
- CRUD helpers: createProject/getProject/listProjects (with goal/task/research
  counts via a LEFT JOIN aggregate, active-first ordering, archived filter)/
  updateProject/touchProject/deleteProject (cascades items in a txn);
  createProjectItem/getProjectItems(kind?)/getProjectItem/updateProjectItem/
  deleteProjectItem.

## 2. API (`src/dashboard.ts`)

`/api/projects` GET (list, `?archived=1`), POST, `/:id` GET (project + items),
PATCH, DELETE; `/:id/items` GET (`?kind=`), POST; `/:id/items/:itemId` PATCH,
DELETE; and `POST /:id/research`. All auto-gated by the existing token middleware
and the `DASHBOARD_MUTATIONS_ENABLED` kill switch. Input validated (kinds,
research categories, status enums, length caps) following the mission-task pattern.

The research endpoint creates a placeholder research item (status=running) plus a
forced-main mission task linked to it (project_id + project_item_id), with a prompt
that explicitly invokes the dual-track recipe.

## 3. Agent + scheduler wiring (`src/agent.ts`, `src/scheduler.ts`)

- **agent.ts**: the team-MCP-server gate dropped its `!routingOptions.skip`
  condition. It now attaches whenever `AGENT_ID === 'main' && routingOptions.chatId`.
  Rationale: a forced-main caller (skip:true, used by research runs) still needs
  the team to orchestrate. `skip` only governs the single-specialist pre-pass
  router, not team availability. Recursion is still bounded to depth one
  (delegated specialists never wire the team server in). No existing path changes:
  the normal Telegram turn passes a chatId and already got the team.
- **scheduler.ts**: a project research mission (mission.project_id set) runs as a
  forced-main turn: `runAgent(..., { chatId, skip: true })`, so Jarvis gets the
  team + runs the dual-track recipe instead of the pre-pass routing it to one
  specialist. On completion/timeout/failure/cancel, `writeBackResearch()` mirrors
  the outcome into the linked project_item (status done/failed + content). Regular
  missions are completely unchanged (no routingOptions).

## 4. Frontend

- **New sidebar section.** `routes.ts`: added a `hub` RouteSection labeled
  "Workspace" with one route `/workspace` (label "Projects", icon FolderKanban,
  shortcut `g k`), placed first. The existing `workspace` section was relabeled
  **"Operations"** to free the name (its routes were unchanged). `Sidebar.tsx`
  SECTIONS array now leads with `hub`. `App.tsx` registers the route.
- **`web/src/pages/Workspace.tsx`** (new): two-pane layout. Left = project list
  with live counts. Right = project detail with sub-tabs Research / Goals / Tasks /
  Instructions. Research tab has the "Research with Jarvis and the team" composer
  plus the library grouped by category, manual add, and per-item expand/delete
  (running items show a spinner and fill in when Jarvis finishes). Goals/Tasks are
  inline-add + status-cycle + delete. Instructions is a save-on-edit textarea.
  Create/Edit project modals (edit includes archive + confirm-delete). All built
  from the existing design system (PageHeader/Tab, Modal, PageState, glass tokens,
  lucide icons), no new components.
- **Mission Control polish** (`MissionControl.tsx`): the current page was already
  clean (toasts throughout, no dead code), so the page-level change is light: a
  `breadcrumb="Operations"` ties it to the new section (consistent with WarRoom /
  AgentFiles which already use breadcrumbs). The real declutter is the sidebar IA
  reorg above.

## 5. Tests

`src/projects-db.test.ts` (8 tests, uses `_initTestDatabase`): project create/read
defaults, the summary counts, archived filter, update + monotonic updated_at, the
research running->done write-back, kind filtering, project delete cascade, single
item delete. `routes.test.ts` stays green (the `hub` section has a label, paths +
shortcuts unique).

## Build + deploy + live verification

`npm run build` (vite + tsc) GREEN; `typecheck:web` clean; full suite GREEN:
73 files, 1022 passed / 4 skipped (+8). Deployed via busy-guarded restart, clean
boot (Database ready, new tables auto-created). Live round-trip verified end to
end against `/api/projects`: create project -> add goal + research item -> list
counts (goals=1, research=1) -> cascade delete -> clean slate (the temp verify
project was deleted, no test data left). Health: model claude-opus-4-8, telegram
connected.

A real research run was NOT triggered during verification (it would post into
Gabe's Telegram and spend several minutes of team time). That path is locked by
the write-back unit test and will exercise on Gabe's first real research click.

## Status / open items

Complete, deployed, verified. Open, low-stakes:
- The existing "Workspace" sidebar section is now "Operations". If Gabe prefers a
  different name, it is a one-line change in `routes.ts` SECTION_LABEL.
- The new tab label is "Projects" (under the "Workspace" section header). Trivial
  to rename to "Workspace" if he wants the item itself called that.
- No drag-to-reorder, rich text, or file attachments yet (sort_order + metadata
  columns exist to grow into). Manual research entries and Jarvis-generated ones
  share the same library.
