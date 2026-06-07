import { Route, Switch, Redirect } from 'wouter-preact';
import { Sidebar } from '@/components/Sidebar';
import { BottomTabBar } from '@/components/BottomTabBar';
import { MoreSheet } from '@/components/MoreSheet';
import { CommandPalette } from '@/components/CommandPalette';
import { ToastStack } from '@/components/ToastStack';
import { TokenGate } from '@/components/TokenGate';
import { sidebarOpen, closeSidebar } from '@/lib/sidebar';
import { dashboardToken } from '@/lib/api';
import { Placeholder } from '@/pages/Placeholder';
import { MissionControl } from '@/pages/MissionControl';
import { Memories } from '@/pages/Memories';
import { HiveMind } from '@/pages/HiveMind';
import { Agents } from '@/pages/Agents';
import { Scheduled } from '@/pages/Scheduled';
import { Audit } from '@/pages/Audit';
import { Usage } from '@/pages/Usage';
import { Settings } from '@/pages/Settings';
import { Voices } from '@/pages/Voices';
import { Chat } from '@/pages/Chat';
import { WarRoom } from '@/pages/WarRoom';
import { AgentFiles } from '@/pages/AgentFiles';
import { LocalModels } from '@/pages/LocalModels';
import { Specialists } from '@/pages/Specialists';
import { JarvisHome } from '@/pages/JarvisHome';
import { Workspace } from '@/pages/Workspace';

export function App() {
  // Token gate: if the SPA loaded without a token in either URL or
  // sessionStorage, every /api/* call will 401 and each page will render
  // its own cryptic "Failed to load" error (Mission Control was hit hard
  // by this on 2026-05-26). Surface a single, recoverable prompt instead
  // of letting the failures cascade. api.ts already initialized the
  // module-level `dashboardToken` at load time from URL + sessionStorage,
  // so a non-empty value here means auth is available.
  if (!dashboardToken) {
    return <TokenGate />;
  }
  const open = sidebarOpen.value;
  return (
    <div class="flex h-screen h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Backdrop when the mobile drawer is open. Tapping it closes. */}
      {open && (
        <div
          class="md:hidden fixed inset-0 bg-black/60 z-40"
          onClick={closeSidebar}
        />
      )}

      <Sidebar />
      <main class="flex-1 min-w-0 overflow-hidden pl-0 md:pl-0 pb-[52px] md:pb-0">
        <Switch>
          <Route path="/"><JarvisHome /></Route>
          <Route path="/workspace"><Workspace /></Route>
          <Route path="/mission"><MissionControl /></Route>
          <Route path="/scheduled"><Scheduled /></Route>
          <Route path="/agents"><Agents /></Route>
          <Route path="/agents/:id/files"><AgentFiles /></Route>
          <Route path="/local-models"><LocalModels /></Route>
          <Route path="/specialists"><Specialists /></Route>
          <Route path="/chat"><Chat /></Route>
          <Route path="/memories"><Memories /></Route>
          <Route path="/hive"><HiveMind /></Route>
          <Route path="/usage"><Usage /></Route>
          <Route path="/audit"><Audit /></Route>
          <Route path="/warroom"><WarRoom /></Route>
          <Route path="/voices"><Voices /></Route>
          <Route path="/settings"><Settings /></Route>

          {/* Common alt slugs that used to point at placeholder pages */}
          <Route path="/hive-mind"><Redirect to="/hive" /></Route>
          <Route path="/hivemind"><Redirect to="/hive" /></Route>
          <Route path="/memory"><Redirect to="/memories" /></Route>

          <Route>
            <Placeholder
              title="Not found"
              description="This page does not exist. Use ⌘K to jump somewhere."
              hideRoadmapNote
            />
          </Route>
        </Switch>
      </main>
      <BottomTabBar />
      <MoreSheet />
      <CommandPalette />
      <ToastStack />
    </div>
  );
}
