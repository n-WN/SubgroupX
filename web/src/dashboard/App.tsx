/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LazyMotion, domAnimation, m, AnimatePresence } from 'motion/react';
import { api, setToken } from '../platform/api.ts';
import { lowerCurtain } from '../platform/boot-splash';
import { modelExecutorAvailability } from '../platform/executors';
import { mobileDrawer, SafeAreaProbe } from './app-helpers';
import { useSessionActions } from './session/use-session-actions';
import { startColumnResize } from './shell/startColumnResize';
import { safeGet, safeSet } from '../platform/storage';
import type { ToolFoldMode } from './session/timeline/timeline-helpers';
import { useEdgeSwipe } from './shell/use-edge-swipe';
import { WsClient, type WsState, type UpdateAvailable } from '../platform/ws.ts';
import { NewSession } from '../sessions/NewSession.tsx';
import { ShareDialog } from '../share/ShareDialog';
import { LeftSidebar } from './shell/LeftSidebar';
import { MainContent } from './session/MainContent';
import { NoSessionState, SessionHydrationState } from './session/NoSessionState';
import { RightSidebar } from './shell/RightSidebar';
import { TopHeader } from './shell/TopHeader';
import { ChannelView } from './features/channels/ChannelView';
import { SettingsView } from './features/settings/SettingsView';
import { SearchView } from './features/search/SearchView';
import { ShellView } from './session/terminal/ShellView';
import { SkillsView } from './features/skills/SkillsView';
import { ConnectorsView } from './features/connectors/ConnectorsView';
import { useT, useI18n } from '../i18n';
import { CommandPalette, type Command } from './shell/CommandPalette';
import { MessageCircle, Search as SearchIcon, SquareTerminal, Box as BoxIcon, LayoutGrid, Settings as SettingsIcon, Plus as PlusIcon, PanelLeft, PanelRight, Maximize2, Link2, Hash, Languages, LogOut as LogOutIcon, Grid2x2, Waypoints } from 'lucide-react';
import { useBackgroundTasks } from '../platform/background-tasks.ts';
import { TOAST_EVENT, showToast } from '../platform/toast';
import type { ExecutorAvailability, SandboxKind, SessionInfo, SessionMode, SessionStatus, SkillSummary, TimelineItem, UserInfo, ModelInfo } from '@shared/protocol';
import type { ViewType } from './types';
import { navigate, usePathname } from '../platform/router';
import { VIEW_PATH, parseAppPath, isKnownAppPath } from './nav';
import { SessionTimelineCache, type SessionTimelineSnapshot } from './session/session-timeline-cache';
import { useResponsivePanels } from './shell/use-responsive-panels';
import { needsSidebarFallback, shellBranchFor } from './shell/sidebar-recovery';
import { PlaceholderPane, SidebarRecoveryControl } from './shell/SidebarRecoveryControl';
import {
  publishOrchestrationInvalidation,
  publishOrchestrationInvalidationSnapshot,
} from '../orchestration/invalidation-store';

const AgentsView = lazy(() => import('./features/agents/AgentsView').then(({ AgentsView }) => ({ default: AgentsView })));
const AutomationsView = lazy(() => import('./features/automations/AutomationsView').then(({ AutomationsView }) => ({ default: AutomationsView })));

export default function App({ user, onSuspended }: { user?: UserInfo | null; onSuspended?: () => void }) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const [showCmdK, setShowCmdK] = useState(false);
  const {
    isMobile,
    isNarrow,
    isLeftSidebarOpen,
    isRightSidebarOpen,
    setIsLeftSidebarOpen,
    setIsRightSidebarOpen,
  } = useResponsivePanels();
  useEdgeSwipe({
    enabled: isMobile,
    leftOpen: isLeftSidebarOpen,
    rightOpen: isRightSidebarOpen,
    setLeftOpen: setIsLeftSidebarOpen,
    setRightOpen: setIsRightSidebarOpen,
  });
  const [leftWidth, setLeftWidth] = useState(260);
  const pathname = usePathname();
  const {
    view: currentView,
    sessionId: routeSessionId,
    agentsSection,
    agentsEntityId,
    agentsSubEntityId,
    redirectTo,
  } = parseAppPath(pathname);
  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true });
    else if (!isKnownAppPath(pathname)) navigate('/', { replace: true });
  }, [pathname, redirectTo]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<SessionInfo | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const sessionHydrating = !sessionsLoaded || Boolean(routeSessionId && activeSession?.id !== routeSessionId);
  const [sessionHydrationVisible, setSessionHydrationVisible] = useState(false);
  useEffect(() => {
    if (!sessionHydrating) {
      setSessionHydrationVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setSessionHydrationVisible(true), 160);
    return () => window.clearTimeout(timer);
  }, [sessionHydrating]);
  const presentedSession = sessionHydrating ? null : activeSession;
  const activeSessionRef = useRef<SessionInfo | null>(null);
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  const openView = useCallback((v: ViewType) => navigate(VIEW_PATH[v]), []);
  const openSession = useCallback((session: SessionInfo, opts?: { replace?: boolean }) => {
    setActiveSession(session);
    navigate(`/s/${session.id}`, opts);
  }, []);
  useEffect(() => {
    if (!routeSessionId) return;
    const found = sessions.find((sess) => sess.id === routeSessionId);
    if (found) {
      if (found !== activeSession) setActiveSession(found);
    } else if (sessionsLoaded) {
      navigate('/', { replace: true });
    }
  }, [routeSessionId, sessions, activeSession, sessionsLoaded]);
  const [wsState, setWsState] = useState<WsState>('connecting');
  const [update, setUpdate] = useState<UpdateAvailable | null>(null);
  const [protocolVersion, setProtocolVersion] = useState(0);
  const [sandboxLoad, setSandboxLoad] = useState<{ cpuPct: number; memUsed: number; memTotal: number } | null>(null);
  const [chatScale, setChatScale] = useState<number>(() => {
    const v = parseFloat(safeGet('oiia.chatScale') ?? '');
    return Number.isFinite(v) && v >= 0.8 && v <= 1.1 ? v : 0.94;
  });
  const changeChatScale = useCallback((v: number) => {
    setChatScale(v);
    safeSet('oiia.chatScale', String(v));
  }, []);
  const [toolFold, setToolFold] = useState<ToolFoldMode>(() => {
    const v = safeGet('oiia.toolFold');
    if (v === 'off' || v === 'quiet' || v === 'all') return v;
    const legacy = safeGet('oiia.compactTools');
    return legacy === '1' ? 'all' : legacy === '0' ? 'off' : 'quiet';
  });
  const changeToolFold = useCallback((v: ToolFoldMode) => {
    setToolFold(v);
    safeSet('oiia.toolFold', v);
  }, []);
  const [wideMode, setWideMode] = useState<boolean>(() => safeGet('oiia.wideMode') === '1');
  const toggleWideMode = useCallback(() => {
    setWideMode((w) => { const n = !w; safeSet('oiia.wideMode', n ? '1' : '0'); return n; });
  }, []);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [openTool, setOpenTool] = useState<{ id: string; n: number } | null>(null);
  const [openFile, setOpenFile] = useState<{ sessionId: string; path: string; frag?: string; n: number } | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSession?.id ?? null);
  activeSessionIdRef.current = activeSession?.id ?? null;
  const [openCompaction, setOpenCompaction] = useState<{ id: string; n: number } | null>(null);
  const sessionTimelineCacheRef = useRef(new SessionTimelineCache());
  const readSessionTimelineSnapshot = useCallback(
    (sessionId: string) => sessionTimelineCacheRef.current.read(sessionId),
    [],
  );
  const [timelineState, setTimelineState] = useState<{ sessionId: string | null; items: TimelineItem[] }>({ sessionId: null, items: [] });
  const timelineItems = timelineState.sessionId === activeSession?.id ? timelineState.items : [];
  const handleTimelineChange = useCallback((snapshot: SessionTimelineSnapshot) => {
    sessionTimelineCacheRef.current.write(snapshot);
    setTimelineState({ sessionId: snapshot.sessionId, items: snapshot.items });
  }, []);
  const [showNewSession, setShowNewSession] = useState(false);
  const [shareSessionId, setShareSessionId] = useState<string | null>(null);
  const openActiveShare = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (sessionId) setShareSessionId(sessionId);
  }, []);
  const [newSessionMode, setNewSessionMode] = useState<SessionMode | null>(null);
  const [newSessionSkill, setNewSessionSkill] = useState<SkillSummary | null>(null);
  const [toast, setToast] = useState<{ msg: string; n: number } | null>(null);
  const wsRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const onToast = (e: Event) => setToast({ msg: String((e as CustomEvent).detail ?? ''), n: Date.now() });
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    const ws = new WsClient();
    wsRef.current = ws;
    ws.onState = setWsState;
    ws.onUpdateAvailable = setUpdate;
    ws.onHello = setProtocolVersion;
    ws.onSuspended = () => onSuspended?.();
    const removeOrchestrationHandler = ws.addHandler((event) => {
      if (event.type === 'orchestration_invalidated') {
        publishOrchestrationInvalidation(event);
      } else if (event.type === 'orchestration_invalidation_snapshot') {
        publishOrchestrationInvalidationSnapshot(event.snapshot);
      }
    });
    ws.connect();
    setWsState(ws.state);

    return () => {
      ws.onState = null;
      ws.onUpdateAvailable = null;
      ws.onHello = null;
      ws.onSuspended = null;
      removeOrchestrationHandler();
      ws.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    setSandboxLoad(null);
    setOpenTool(null);
    setOpenFile(null);
    setOpenCompaction(null);
  }, [activeSession?.id]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true;
    const closedGap = standalone ? 'calc(env(safe-area-inset-bottom, 0px) + 2.25rem)' : '0.75rem';
    const update = () => {
      const zoomed = (vv.scale || 1) > 1.05;
      const kb = zoomed ? 0 : Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const kbOpen = kb > 120;
      root.style.setProperty('--app-vvh', kbOpen ? `${Math.round(vv.height)}px` : '100dvh');
      root.style.setProperty('--composer-pb', kbOpen ? '0.5rem' : closedGap);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);

  const closeDrawersOnMobile = useCallback(() => {
    if (isMobile) {
      setIsLeftSidebarOpen(false);
      setIsRightSidebarOpen(false);
    }
  }, [isMobile, setIsLeftSidebarOpen, setIsRightSidebarOpen]);

  const handleViewSelect = useCallback((v: ViewType) => {
    openView(v);
    closeDrawersOnMobile();
  }, [openView, closeDrawersOnMobile]);
  const handleSessionSelect = useCallback((session: SessionInfo) => {
    openSession(session);
    closeDrawersOnMobile();
  }, [openSession, closeDrawersOnMobile]);
  const handleNewSessionOpen = useCallback(() => {
    setShowNewSession(true);
    closeDrawersOnMobile();
  }, [closeDrawersOnMobile]);

  const handleActivity = useCallback(() => setFileRefresh((key) => key + 1), []);

  const onRequestReview = useCallback((prompt: string) => {
    const ws = wsRef.current;
    const s = activeSessionRef.current;
    if (!ws || !s) return;
    ws.send({ type: 'send_message', sessionId: s.id, text: prompt, reqId: crypto.randomUUID() });
    showToast(t('changes.reviewSent'));
  }, [t]);
  const handleStatusChange = useCallback((id: string, status: SessionStatus) => {
    setSessions((cur) => cur.map((s) => (s.id === id && s.status !== status ? { ...s, status } : s)));
    setActiveSession((cur) => (cur && cur.id === id && cur.status !== status ? { ...cur, status } : cur));
  }, []);
  const handleOpenTool = useCallback((id: string) => {
    setOpenTool({ id, n: Date.now() });
    setIsRightSidebarOpen(true);
  }, []);
  const handleOpenFile = useCallback((path: string, frag?: string) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    setOpenFile({ sessionId, path, frag, n: Date.now() });
    setIsRightSidebarOpen(true);
  }, []);
  const handleOpenCompaction = useCallback((id: string) => {
    setOpenCompaction({ id, n: Date.now() });
    setIsRightSidebarOpen(true);
  }, []);

  const { renameSession, forkSession, setThinkingLevel, setApprovalPolicy, setModel, handleAutoTitle } =
    useSessionActions({
      activeSession,
      setSessions,
      setActiveSession,
      openSession,
      setSessionsLoaded,
      activeSessionRef,
    });

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [executorAvailability, setExecutorAvailability] = useState<ExecutorAvailability | null>(null);
  const refreshModels = useCallback(() => {
    api.models().then((r) => {
      setModels(r.models);
      setExecutorAvailability(modelExecutorAvailability(r));
    }).catch(() => {});
  }, []);
  useEffect(() => { refreshModels(); }, [refreshModels]);

  const deleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t('app.deleteConfirm'))) return;
    await api.deleteSession(id);
    sessionTimelineCacheRef.current.delete(id);
    setSessions((cur) => cur.filter((s) => s.id !== id));
    setActiveSession((cur) => (cur?.id === id ? null : cur));
  }, [t]);

  async function logout() {
    wsRef.current?.close();
    await api.logout().catch(() => {});
    setToken(null);
    window.location.reload();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setShowCmdK((v) => !v);
        return;
      }
      if (e.key === 'b' || e.key === 'B') {
        const el = document.activeElement as HTMLElement | null;
        const typing = Boolean(el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'));
        if (typing) return;
        e.preventDefault();
        setIsLeftSidebarOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setIsLeftSidebarOpen]);

  const commands: Command[] = useMemo(() => {
    const ico = "size-[15px]";
    const list: Command[] = [
      { id: 'new-session', label: t('cmdk.newSession'), hint: '⌘N', keywords: 'create new chat', icon: <PlusIcon className={ico} />, run: () => setShowNewSession(true) },
      { id: 'go-chat', label: t('cmdk.goChat'), keywords: 'chat quick home 对话', icon: <MessageCircle className={ico} />, run: () => openView('chat') },
      { id: 'go-channel', label: t('cmdk.goChannel'), keywords: 'sessions overview all grid gallery channel 会话 总览 频道 全屏', icon: <Grid2x2 className={ico} />, run: () => openView('channel') },
      { id: 'go-search', label: t('cmdk.goSearch'), keywords: 'search find 搜索', icon: <SearchIcon className={ico} />, run: () => openView('search') },
      { id: 'go-terminal', label: t('cmdk.goTerminal'), keywords: 'terminal shell console 终端', icon: <SquareTerminal className={ico} />, run: () => openView('shell') },
      { id: 'go-skills', label: t('cmdk.goSkills'), keywords: 'skills agents personas 技能', icon: <BoxIcon className={ico} />, run: () => openView('skills') },
      { id: 'go-plugins', label: t('cmdk.goPlugins'), keywords: 'plugins ssh connector machines 插件', icon: <LayoutGrid className={ico} />, run: () => openView('plugins') },
      { id: 'go-agents', label: t('cmdk.goAgents'), keywords: 'agents tasks workflows teams subagents', icon: <Waypoints className={ico} />, run: () => openView('agents') },
      { id: 'go-settings', label: t('cmdk.goSettings'), keywords: 'settings preferences config 设置', icon: <SettingsIcon className={ico} />, run: () => openView('settings') },
      { id: 'toggle-left', label: t('cmdk.toggleLeftPanel'), hint: '⌘B', keywords: 'sidebar navigation sessions 侧边栏 导航', icon: <PanelLeft className={ico} />, run: () => setIsLeftSidebarOpen((o) => !o) },
      { id: 'toggle-right', label: t('cmdk.toggleRightPanel'), keywords: 'details pane changes terminal', icon: <PanelRight className={ico} />, run: () => setIsRightSidebarOpen((o) => !o) },
      { id: 'toggle-wide', label: t('cmdk.toggleWide'), keywords: 'reading width', icon: <Maximize2 className={ico} />, run: () => toggleWideMode() },
      { id: 'switch-lang', label: t('cmdk.switchLang'), hint: locale === 'zh' ? 'EN' : '中文', keywords: 'language 语言 english chinese', icon: <Languages className={ico} />, run: () => setLocale(locale === 'zh' ? 'en' : 'zh') },
    ];
    if (activeSession) {
      list.push(
        { id: 'copy-url', label: t('cmdk.copyUrl'), keywords: 'share link session', icon: <Link2 className={ico} />, run: () => { void navigator.clipboard?.writeText(`${window.location.origin}/s/${activeSession.id}`).then(() => showToast(t('cmdk.copied'))); } },
        { id: 'copy-id', label: t('cmdk.copyId'), keywords: 'session identifier', icon: <Hash className={ico} />, run: () => { void navigator.clipboard?.writeText(activeSession.id).then(() => showToast(t('cmdk.copied'))); } },
      );
    }
    list.push({ id: 'logout', label: t('cmdk.logout'), keywords: 'sign out exit', icon: <LogOutIcon className={ico} />, run: () => logout() });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, activeSession, openView, toggleWideMode, setLocale]);

  const ws = wsRef.current;
  const activeTitle = presentedSession?.title ?? 'oiia';
  const shellBranch = shellBranchFor(currentView, { hasShellTarget: sessions.length > 0 && Boolean(ws) });
  const timelineForSidebar = useMemo(() => timelineItems, [timelineItems]);
  const backgroundTasks = useBackgroundTasks(
    ws,
    activeSession?.id ?? null,
    (id) => sessions.find((s) => s.id === id)?.title ?? 'Session',
    handleStatusChange,
    useCallback((ev: { type: "created"; session: SessionInfo } | { type: "renamed"; sessionId: string; title: string } | { type: "deleted"; sessionId: string } | { type: "sandbox"; sessionId: string; kind: SandboxKind; targetId: string | null } | { type: "invalidate"; sessionId: string }) => {
      if (ev.type === "created") {
        setSessions((cur) => (cur.some((s) => s.id === ev.session.id) ? cur : [ev.session, ...cur]));
      } else if (ev.type === "renamed") {
        setSessions((cur) => cur.map((s) => (s.id === ev.sessionId ? { ...s, title: ev.title } : s)));
      } else if (ev.type === "sandbox") {
        sessionTimelineCacheRef.current.delete(ev.sessionId);
        setSessions((cur) => cur.map((s) => (s.id === ev.sessionId ? { ...s, sandboxKind: ev.kind, sandboxTargetId: ev.targetId } : s)));
        setActiveSession((cur) => (cur?.id === ev.sessionId ? { ...cur, sandboxKind: ev.kind, sandboxTargetId: ev.targetId } : cur));
      } else if (ev.type === "invalidate") {
        sessionTimelineCacheRef.current.delete(ev.sessionId);
      } else {
        sessionTimelineCacheRef.current.delete(ev.sessionId);
        setSessions((cur) => cur.filter((s) => s.id !== ev.sessionId));
        setActiveSession((cur) => (cur?.id === ev.sessionId ? null : cur));
      }
    }, []),
  );
  const selectBackgroundTask = useCallback(
    async (id: string) => {
      const target = sessions.find((s) => s.id === id);
      if (target) {
        openSession(target);
        return;
      }
      const res = await api.sessions().catch(() => null);
      const fetched = res?.sessions.find((s) => s.id === id);
      if (fetched) {
        setSessions(res!.sessions);
        openSession(fetched);
      }
    },
    [sessions],
  );

  const openAutomationSession = useCallback(
    async (id: string) => {
      const target = sessions.find((s) => s.id === id);
      if (target) {
        openSession(target);
        return;
      }
      const res = await api.sessions().catch(() => null);
      const fetched = res?.sessions.find((s) => s.id === id);
      if (fetched) {
        setSessions(res!.sessions);
        openSession(fetched);
      }
    },
    [sessions],
  );

  const handleLeftDrag = (e: React.MouseEvent) =>
    startColumnResize(e, { startWidth: leftWidth, min: 200, max: 600, sign: 1, onWidth: setLeftWidth });

  const handleLeftResizeKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    setLeftWidth((w) => Math.max(200, Math.min(600, w + step)));
  };

  const leftSidebar = (
    <LeftSidebar
      userEmail={user?.email ?? 'local.user'}
      sessions={sessions}
      sessionsLoaded={sessionsLoaded}
      sessionHydrationVisible={sessionHydrationVisible}
      activeSessionId={presentedSession?.id ?? null}
      wsState={wsState}
      currentView={currentView}
      onCurrentViewChange={handleViewSelect}
      onSelectSession={handleSessionSelect}
      onDeleteSession={deleteSession}
      onRenameSession={renameSession}
      onShareSession={setShareSessionId}
      onNewSession={handleNewSessionOpen}
      onLogout={logout}
      onOpenShortcuts={() => setShowCmdK(true)}
      update={update}
      onReload={() => {
        void lowerCurtain().then(() => window.location.reload());
      }}
      onClose={() => setIsLeftSidebarOpen(false)}
    />
  );

  return (
    <LazyMotion features={domAnimation}>
    <div
      className="flex flex-col h-[var(--app-vvh,100dvh)] w-full overflow-hidden bg-[var(--app-frame)] dark:bg-[#1E1E1E] text-[#333] dark:text-[#E0E0E0] font-sans selection:bg-blue-100 dark:selection:bg-blue-900/40 selection:text-blue-900 dark:selection:text-blue-100">
      <SafeAreaProbe />
      <div className="flex flex-1 overflow-hidden min-h-0">

        {!isMobile && (
          <AnimatePresence initial={false}>
            {isLeftSidebarOpen && (
              <m.div
                key="left-col"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: leftWidth, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 450, damping: 40 }}
                className="flex-shrink-0 h-full overflow-hidden flex flex-col relative"
              >
                <div style={{ width: leftWidth }} className="h-full overflow-hidden shrink-0">
                  {leftSidebar}
                </div>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('app.resizeSidebar')}
                  tabIndex={0}
                  onMouseDown={handleLeftDrag}
                  onKeyDown={handleLeftResizeKey}
                  className="absolute right-[-3px] top-0 bottom-0 w-2 cursor-col-resize z-20 bg-transparent"
                />
              </m.div>
            )}
          </AnimatePresence>
        )}

        {isMobile && (
          <AnimatePresence>
            {isLeftSidebarOpen &&
              mobileDrawer({
                keyPrefix: 'left',
                side: 'left',
                widthClass: 'w-[86vw] max-w-[320px]',
                onClose: () => setIsLeftSidebarOpen(false),
                children: leftSidebar,
              })}
          </AnimatePresence>
        )}

        <div className="flex flex-1 flex-col bg-[var(--app-surface)] dark:bg-[#1A1A1A] overflow-hidden relative">

          {currentView === 'chat' && (
            <TopHeader
              title={activeTitle}
              wsState={wsState}
              sandboxLoad={sandboxLoad}
              sandboxKind={presentedSession?.sandboxKind}
              sandboxHost={presentedSession?.sandboxTargetId}
              sessionRunning={presentedSession?.status === 'running'}
              onSetSandbox={(kind, targetId) => {
                if (!presentedSession) return;
                wsRef.current?.send({ type: 'set_sandbox', sessionId: presentedSession.id, kind, targetId, reqId: crypto.randomUUID() });
                setSessions((cur) => cur.map((s) => (s.id === presentedSession.id ? { ...s, sandboxKind: kind, sandboxTargetId: targetId } : s)));
                setActiveSession((cur) => (cur ? { ...cur, sandboxKind: kind, sandboxTargetId: targetId } : cur));
              }}
              egress={presentedSession?.egress}
              backgroundTasks={backgroundTasks}
              onSelectBackground={selectBackgroundTask}
              onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
              isLeftSidebarOpen={isLeftSidebarOpen}
              isRightSidebarOpen={isRightSidebarOpen}
              onToggleRightSidebar={() => setIsRightSidebarOpen((open) => !open)}
              wideMode={wideMode}
              onToggleWideMode={toggleWideMode}
              isAdmin={user?.isAdmin}
              activeSessionId={presentedSession?.id ?? null}
            />
          )}
          <div className="relative flex min-h-0 flex-1 overflow-hidden">

            {needsSidebarFallback(shellBranch, isLeftSidebarOpen) && (
              <SidebarRecoveryControl onOpen={() => setIsLeftSidebarOpen(true)} />
            )}
            <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {currentView === 'chat' && !sessionHydrating && activeSession && ws && (
              <MainContent
                key={activeSession.id}
                ws={ws}
                session={activeSession}
                onActivity={handleActivity}
                onOpenTool={handleOpenTool}
                onOpenFile={handleOpenFile}
                onOpenCompaction={handleOpenCompaction}
                activeToolId={isRightSidebarOpen ? (openTool?.id ?? null) : null}
                activeCompactionId={isRightSidebarOpen ? (openCompaction?.id ?? null) : null}
                onTimelineChange={handleTimelineChange}
                readTimelineSnapshot={readSessionTimelineSnapshot}
                onSandboxLoad={setSandboxLoad}
                chatScale={chatScale}
                toolFold={toolFold}
                wideMode={wideMode}
                onAutoTitle={handleAutoTitle}
                onSetThinkingLevel={setThinkingLevel}
                onSetApprovalPolicy={setApprovalPolicy}
                models={models}
                onSetModel={setModel}
                onStatusChange={handleStatusChange}
                onShare={openActiveShare}
                onFork={forkSession}
                protocolVersion={protocolVersion}
              />
            )}

            {currentView === 'chat' && sessionHydrating && (
              <SessionHydrationState visible={sessionHydrationVisible} />
            )}

            {currentView === 'chat' && !sessionHydrating && !activeSession && (
              <NoSessionState
                executorReason={
                  sessions.length === 0 &&
                  executorAvailability &&
                  !executorAvailability.local.available &&
                  !executorAvailability.e2b.available
                    ? executorAvailability.e2b.reason ?? 'policy_disabled'
                    : undefined
                }
                onConnectComputer={() => { openView('plugins'); closeDrawersOnMobile(); }}
              />
            )}

            {currentView === 'chat' && !sessionHydrating && activeSession && !ws && (
              <div className="flex-1 flex items-center justify-center text-[#777] dark:text-[#999] text-[14px]">
                {t('chat.noSession')}
              </div>
            )}

            {currentView === 'channel' && (
              <ChannelView
                isLeftSidebarOpen={isLeftSidebarOpen}
                onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
                sessions={sessions}
                activeSessionId={activeSession?.id ?? null}
                onSelectSession={(session) => openSession(session)}
                onNewSession={() => setShowNewSession(true)}
              />
            )}

            {currentView === 'search' && (
              <SearchView
                isLeftSidebarOpen={isLeftSidebarOpen}
                onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
                sessions={sessions}
                onSelectSession={(session) => openSession(session)}
              />
            )}

            {currentView === 'shell' && sessions.length > 0 && ws && (
              <ShellView
                sessions={sessions}
                initialSessionId={activeSession?.id}
                isLeftSidebarOpen={isLeftSidebarOpen}
                onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
              />
            )}

            {currentView === 'shell' && (sessions.length === 0 || !ws) && (
              <div className="flex-1 flex items-center justify-center text-[#777] dark:text-[#999] text-[14px]">
                {t('shell.noSession')}
              </div>
            )}

            {currentView === 'skills' && (
              <SkillsView
                isLeftSidebarOpen={isLeftSidebarOpen}
                onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
                onLaunch={(mode, skill) => { setNewSessionMode(mode); setNewSessionSkill(skill ?? null); setShowNewSession(true); }}
              />
            )}

            {currentView === 'plugins' && (
              <ConnectorsView
                isLeftSidebarOpen={isLeftSidebarOpen}
                onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
                onOpenSession={(session) => openSession(session)}
              />
            )}

            {currentView === 'agents' && (
              <Suspense fallback={<PlaceholderPane isLeftSidebarOpen={isLeftSidebarOpen} onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)} />}>
                <AgentsView
                  section={agentsSection ?? 'activity'}
                  selectedId={agentsEntityId}
                  selectedSubId={agentsSubEntityId}
                  isLeftSidebarOpen={isLeftSidebarOpen}
                  onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
                />
              </Suspense>
            )}

            {currentView === 'automations' && (
              <Suspense fallback={<PlaceholderPane isLeftSidebarOpen={isLeftSidebarOpen} onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)} />}>
                <AutomationsView
                  isLeftSidebarOpen={isLeftSidebarOpen}
                  onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
                  onOpenSession={(sessionId) => void openAutomationSession(sessionId)}
                />
              </Suspense>
            )}

            {currentView === 'settings' && (
              <SettingsView
                isLeftSidebarOpen={isLeftSidebarOpen}
                onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
                userEmail={user?.email ?? ''}
                hasPassword={user?.hasPassword ?? true}
                connected={wsState === 'open'}
                chatScale={chatScale}
                onChatScaleChange={changeChatScale}
                toolFold={toolFold}
                onToolFoldChange={changeToolFold}
                onProvidersChanged={refreshModels}
                onLogout={logout}
                onDone={() => openView('chat')}
              />
            )}

            {(isMobile || isNarrow) && (
              <AnimatePresence>
                {isRightSidebarOpen &&
                  currentView === 'chat' &&
                  activeSession &&
                  mobileDrawer({
                    keyPrefix: 'rs',
                    side: 'right',
                    widthClass: isNarrow ? 'w-[80vw] max-w-[480px]' : 'w-[92vw] max-w-[400px]',
                    onClose: () => setIsRightSidebarOpen(false),
                    children: (
                      <RightSidebar
                        mobile
                        sessionId={activeSession.id}
                        session={activeSession}
                        refreshKey={fileRefresh}
                        openTool={openTool}
                        openFile={openFile?.sessionId === activeSession.id ? openFile : null}
                        openCompaction={openCompaction}
                        onRequestReview={onRequestReview}
                        timelineItems={timelineForSidebar}
                      />
                    ),
                  })}
              </AnimatePresence>
            )}
            </div>

          {!isMobile && !isNarrow && (
            <AnimatePresence initial={false}>
              {isRightSidebarOpen && currentView === 'chat' && activeSession && (
                <RightSidebar
                  key="rs-col"
                  sessionId={activeSession.id}
                  session={activeSession}
                  refreshKey={fileRefresh}
                  openTool={openTool}
                  openFile={openFile?.sessionId === activeSession.id ? openFile : null}
                  openCompaction={openCompaction}
                  onRequestReview={onRequestReview}
                  timelineItems={timelineForSidebar}
                />
              )}
            </AnimatePresence>
          )}
          </div>
        </div>
      </div>

      {showNewSession && (
        <NewSession
          initialMode={newSessionMode ?? undefined}
          initialSkill={newSessionSkill ?? undefined}
          isAdmin={user?.isAdmin}
          onNavigateToConnectors={() => { openView('plugins'); closeDrawersOnMobile(); }}
          onClose={() => { setShowNewSession(false); setNewSessionMode(null); setNewSessionSkill(null); }}
          onCreated={(session) => {
            setNewSessionMode(null);
            setNewSessionSkill(null);
            setSessions((cur) => (cur.some((s) => s.id === session.id) ? cur : [session, ...cur]));
            openSession(session);
          }}
        />
      )}

      {shareSessionId && (
        <ShareDialog sessionId={shareSessionId} timeline={timelineItems} onClose={() => setShareSessionId(null)} />
      )}

      <CommandPalette open={showCmdK} onClose={() => setShowCmdK(false)} commands={commands} />

      <AnimatePresence>
        {toast && (
          <m.div
            key={toast.n}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 500, damping: 38 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[95] rounded-full bg-[#222] dark:bg-[#E8E8E8] text-white dark:text-[#1A1A1A] px-4 py-2 text-[13px] font-medium shadow-[0_4px_20px_rgba(0,0,0,0.18)] pointer-events-none"
            role="status"
          >
            {toast.msg}
          </m.div>
        )}
      </AnimatePresence>

      <div
        data-testid="commit-hash"
        aria-hidden="true"
        title={`build ${__APP_VERSION__}`}
        className="fixed z-30 pointer-events-none select-none font-mono text-[9px] leading-none tracking-[0.15em] text-[#CFCFCF] dark:text-[#3A3A3A] [writing-mode:horizontal-tb] bottom-1 left-1/2 -translate-x-1/2 sm:[writing-mode:vertical-rl] sm:bottom-1.5 sm:left-auto sm:right-1 sm:translate-x-0"
      >
        {__APP_VERSION__.split('.')[0]}
      </div>
    </div>
    </LazyMotion>
  );
}
