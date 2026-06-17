import {
  LayoutGrid, ListTodo, Users, MessageSquare,
  Brain, Network, Activity, ShieldCheck,
  Swords,
  Cpu,
  Crosshair,
  Settings,
  Sparkles,
  FolderKanban,
  Bookmark,
  Rss,
  Clapperboard,
  Radar,
  Film,
  Briefcase,
  Gauge,
} from 'lucide-preact';
import type { ComponentChildren } from 'preact';

export type RouteSection = 'hub' | 'business' | 'workspace' | 'intelligence' | 'collaborate' | 'configure';

export interface RouteDef {
  path: string;
  label: string;
  section: RouteSection;
  icon: typeof LayoutGrid;
  shortcut?: string;
}

// Single source of truth for the sidebar, command palette, and router.
// Voices used to be a top-level item; it now lives under War Room as the
// "Voice config" sub-tab and is reachable via /warroom?mode=voices.
export const ROUTES: RouteDef[] = [
  { path: '/workspace',  label: 'Projects',        section: 'hub',          icon: FolderKanban,  shortcut: 'g k' },
  { path: '/library',    label: 'Content Library', section: 'hub',          icon: Bookmark,      shortcut: 'g b' },
  { path: '/studio',     label: 'Content Studio',  section: 'hub',          icon: Clapperboard,  shortcut: 'g t' },
  { path: '/editbay',    label: 'Edit Bay',        section: 'hub',          icon: Film,          shortcut: 'g v' },
  { path: '/feeds',      label: 'Feeds',           section: 'hub',          icon: Rss,           shortcut: 'g f' },
  { path: '/edge',       label: 'Edge Scanner',    section: 'hub',          icon: Radar,         shortcut: 'g d' },
  { path: '/psyop',      label: 'Psyop Score',     section: 'hub',          icon: Gauge,         shortcut: 'g x' },

  // Oswalt's AI Solutions: the agency is its own sector, deliberately separate
  // from Gabe's personal content + trading tooling (his explicit direction).
  { path: '/clients',    label: 'Clients',         section: 'business',     icon: Briefcase,     shortcut: 'g n' },

  { path: '/',           label: 'J.A.R.V.I.S.',    section: 'workspace',    icon: Sparkles,      shortcut: 'g j' },
  { path: '/mission',    label: 'Mission Control', section: 'workspace',    icon: LayoutGrid,    shortcut: 'g m' },
  { path: '/scheduled',  label: 'Scheduled',       section: 'workspace',    icon: ListTodo,      shortcut: 'g s' },
  { path: '/agents',     label: 'Agents',          section: 'workspace',    icon: Users,         shortcut: 'g a' },
  { path: '/chat',       label: 'Chat',            section: 'workspace',    icon: MessageSquare, shortcut: 'g c' },
  { path: '/local-models', label: 'Local Models',  section: 'workspace',    icon: Cpu,           shortcut: 'g l' },
  { path: '/specialists', label: 'Specialists',    section: 'workspace',    icon: Crosshair,     shortcut: 'g p' },

  { path: '/memories',   label: 'Memories',        section: 'intelligence', icon: Brain,         shortcut: 'g e' },
  { path: '/hive',       label: 'Hive Mind',       section: 'intelligence', icon: Network,       shortcut: 'g h' },
  { path: '/usage',      label: 'Usage',           section: 'intelligence', icon: Activity,      shortcut: 'g u' },
  { path: '/audit',      label: 'Audit',           section: 'intelligence', icon: ShieldCheck                   },

  { path: '/warroom',    label: 'War Room',        section: 'collaborate',  icon: Swords,        shortcut: 'g w' },

  { path: '/settings',   label: 'Settings',        section: 'configure',    icon: Settings                  },
];

export const SECTION_LABEL: Record<RouteSection, string> = {
  hub:          'Workspace',
  business:     "Oswalt's AI",
  workspace:    'Operations',
  intelligence: 'Intelligence',
  collaborate:  'Collaborate',
  configure:    'Configure',
};

export const DEFAULT_ROUTE = '/';

// Lightly typed children helper for placeholder pages.
export type PageProps = { children?: ComponentChildren };
