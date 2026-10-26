import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MarkdownFileLinkContext } from '../../conversation/markdown/MarkdownRenderer';
import { parseMessageAttachments } from '../../files/MessageAttachments-helpers';
import { acquireFilePreviewSource, mediaPreviewKind } from '../../files/media-preview-source';
import { SessionLoaderOverlay } from '../ui/CatSpinner';
import { JumpToLatest, ReaderActionDock } from './reader/ReaderActions';
import { useReaderOutline } from './reader/useReaderOutline';
import {
  createStreamScrollFollower,
  shouldAnimateStreamFollow,
  type StreamScrollFollower,
} from './reader/stream-follow-motion';
import { resolveStreamHeight, type StreamHeightState } from './reader/stream-height-stability';
import { Composer, type Attachment } from './composer/Composer';
import { closeComposerPopoverGroup } from './composer/useHoverPopover';
import { observeTimelineToolTiming, observeToolTimingEvent } from './tools/tool-running-clock';
import { pastedTextFilename } from './composer/pasted-text';
import { modelsForDraft, modelStillCompatible } from '../../platform/model-capabilities';
import { Timeline } from './timeline/Timeline';
import type { ToolFoldMode } from './timeline/timeline-helpers';
import { type ContextUsage } from './composer/composer-widgets';
import { nextReq } from './req-id';
import { isPendingMutationRefusal } from './pending-mutation';
import { parseSlash, slashCandidates, type SlashCommand } from '../../conversation/slash-commands';
import { collectCanvasDiffs, clearCanvasStates } from './timeline/canvas-state';
import { Lock } from 'lucide-react';
import { api } from '../../platform/api.ts';
import { ensureSshUnlocked, resolveSessionSshTarget } from '../../auth/ssh-passkey.ts';
import { useT } from '../../i18n';
import { showToast } from '../../platform/toast';
import { ensureNotifyPermission } from '../../platform/notify';
import type { WsClient } from '../../platform/ws.ts';
import { reduceTimeline, mergeReplayWithPending } from '@shared/timeline-reducer';
import { groupConversationTurns, turnRootUserIds } from '@shared/conversation-model';
import { StatusDot } from "../../ui/StatusDot";
import type { SessionTimelineSnapshot } from './session-timeline-cache';
import { shouldSuggestFirstTask, suggestionForSession } from './first-task-suggestion';
import type {
  ApprovalPolicy,
  PendingMessage,
  PermissionDecision,
  PermissionRequestPayload,
  ServerEvent,
  SessionInfo,
  SessionStatus,
  ThinkingLevel,
  TimelineItem,
  ModelInfo,
} from '@shared/protocol';

let localMsgCounter = 0;
const nextLocalMsgId = () => "local_u_" + ++localMsgCounter;
const OPTIMISTIC_ECHO_TIMEOUT_MS = 10_000;

const MAX_PROMPT_HISTORY = 200;
const RESTING_TEXTAREA_H = 48;
const MAX_TEXTAREA_H = 140;
const canPreviewMarkdownImage = (path: string): boolean => mediaPreviewKind(path) === 'image';

function fitComposerTextarea(el: HTMLTextAreaElement): number {
  el.style.height = 'auto';
  const height = Math.min(Math.max(el.scrollHeight, RESTING_TEXTAREA_H), MAX_TEXTAREA_H);
  el.style.height = `${height}px`;
  return height;
}

export const MainContent = memo(function MainContent({
  ws,
  session,
  onActivity,
  onOpenTool,
  onOpenFile,
  onOpenCompaction,
  activeToolId,
  activeCompactionId,
  onTimelineChange,
  readTimelineSnapshot,
  onSandboxLoad,
  onAutoTitle,
  onSetThinkingLevel,
  onSetApprovalPolicy,
  models,
  onSetModel,
  onStatusChange,
  onShare,
  onFork,
  protocolVersion = 0,
  chatScale = 1,
  toolFold = 'off',
  wideMode = false,
}: {
  ws: WsClient;
  session: SessionInfo;
  onActivity: () => void;
  onOpenTool?: (id: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenCompaction?: (id: string) => void;
  activeToolId?: string | null;
  activeCompactionId?: string | null;
  onTimelineChange?: (snapshot: SessionTimelineSnapshot) => void;
  readTimelineSnapshot?: (sessionId: string) => SessionTimelineSnapshot | null;
  onSandboxLoad?: (load: { cpuPct: number; memUsed: number; memTotal: number } | null) => void;
  onAutoTitle?: (id: string, currentTitle: string, text: string) => void;
  onSetThinkingLevel?: (id: string, level: ThinkingLevel) => void;
  models?: ModelInfo[];
  onSetModel?: (id: string, provider: string, model: string) => void;
  onSetApprovalPolicy?: (id: string, policy: ApprovalPolicy) => void;
  onStatusChange?: (id: string, status: SessionStatus) => void;
  onShare?: () => void;
  onFork?: (fromSeq: number) => void;
  protocolVersion?: number;
  chatScale?: number;
  toolFold?: ToolFoldMode;
  wideMode?: boolean;
}) {
  const t = useT();
  const acquireMarkdownImage = useCallback(async (path: string, replaceGeneration?: number) => {
    const lease = await acquireFilePreviewSource(session.id, path, "", replaceGeneration);
    return { url: lease.source.url, generation: lease.generation, release: lease.release };
  }, [session.id]);
  const fileLinkCtx = useMemo(() => ({
    openFile: onOpenFile,
    canPreviewImage: canPreviewMarkdownImage,
    acquireImage: acquireMarkdownImage,
  }), [acquireMarkdownImage, onOpenFile]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const isImeComposing = (e: ReactKeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current;
  const promptHistoryRef = useRef<string[]>([]);
  const histCursorRef = useRef(-1);
  const histDraftRef = useRef('');
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const streamFollowRef = useRef<StreamScrollFollower | null>(null);
  const streamFollowActiveRef = useRef(false);
  const streamStabilityActiveRef = useRef(false);
  const streamCompensatorRef = useRef<HTMLDivElement>(null);
  const streamHeightStateRef = useRef<StreamHeightState>({ floor: null });
  const [composerH, setComposerH] = useState(140);
  const composerHRef = useRef(140);
  const prevComposerHRef = useRef(140);
  const lastWidthRef = useRef(0);
  const restingComposerHRef = useRef(140);
  const ignoringResizeScrollRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [composerSurfaceOpen, setComposerSurfaceOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [draftOverflow, setDraftOverflow] = useState(false);
  const fitDraft = useCallback((el: HTMLTextAreaElement) => {
    const height = fitComposerTextarea(el);
    setDraftOverflow(el.scrollHeight > height + 1);
  }, []);
  const [slashActive, setSlashActive] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  const slashList = useMemo(() => {
    const c = slashCandidates(inputValue);
    return c && c.length > 0 && inputValue !== slashDismissedFor ? c : null;
  }, [inputValue, slashDismissedFor]);
  useEffect(() => { setSlashActive(0); }, [inputValue]);
  const applySlash = useCallback((cmd: SlashCommand) => {
    const next = `/${cmd.name} `;
    setInputValue(next);
    setSlashDismissedFor(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) { el.focus(); el.setSelectionRange(next.length, next.length); }
    });
  }, []);
  const [initialTimeline] = useState<SessionTimelineSnapshot | null>(
    () => readTimelineSnapshot?.(session.id) ?? null,
  );
  const [items, setItems] = useState<TimelineItem[]>(() => initialTimeline?.items ?? []);
  const [pending, setPending] = useState<PendingMessage[]>(() => initialTimeline?.pending ?? []);
  const [status, setStatus] = useState<SessionStatus>(session.status);
  const [modelRetryProgress, setModelRetryProgress] = useState<{ attempt: number; limit: number } | null>(null);
  const [editing, setEditing] = useState<{ seq: number; original: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const draftBeforeEditRef = useRef('');
  const lastEditRef = useRef<{ seq: number; original: string } | null>(null);
  const pendingRewindReqRef = useRef<string | null>(null);
  const rewindRevertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rewindPrevStatusRef = useRef<SessionStatus>('idle');
  const sessionStatusRef = useRef(session.status);
  sessionStatusRef.current = session.status;
  const protocolVersionRef = useRef(protocolVersion);
  protocolVersionRef.current = protocolVersion;
  const [perm, setPerm] = useState<PermissionRequestPayload | null>(null);
  const WINDOW_STEP = 60;
  const [maxVisible, setMaxVisible] = useState(WINDOW_STEP);
  const restoreScrollRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [attachError, setAttachError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [sessionLoading, setSessionLoading] = useState(() => initialTimeline == null);
  const [sandboxConnecting, setSandboxConnecting] = useState(false);
  const [sshLock, setSshLock] = useState<{ targetId: string; locked: boolean } | null>(null);
  const [sshUnlocking, setSshUnlocking] = useState(false);
  const sshUnlockedAtRef = useRef(0);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const pendingOptimisticRef = useRef<{ localId: string; text: string; timer: ReturnType<typeof setTimeout> }[]>([]);
  const replayEpochRef = useRef<string | null>(initialTimeline?.epoch ?? null);
  const timelineVersionRef = useRef<number | null>(initialTimeline?.version ?? null);
  const timelineApproxCharsRef = useRef(initialTimeline?.approxChars ?? 0);

  useEffect(() => {
    let cancelled = false;
    sshUnlockedAtRef.current = Date.now();
    if (session.sandboxKind === 'ssh') {
      void resolveSessionSshTarget(session.sandboxTargetId).then((tgt) => {
        if (!cancelled) setSshLock(tgt && tgt.protected ? { targetId: tgt.id, locked: !tgt.unlocked } : null);
      });
    } else {
      setSshLock(null);
    }
    return () => { cancelled = true; };
  }, [session.id, session.sandboxKind, session.sandboxTargetId]);

  const doSshUnlock = useCallback(async (): Promise<boolean> => {
    if (!sshLock) return true;
    setSshUnlocking(true);
    try {
      const r = await ensureSshUnlocked(sshLock.targetId);
      if (r.ok) { sshUnlockedAtRef.current = Date.now(); setSshLock((p) => (p ? { ...p, locked: false } : null)); return true; }
      showToast(r.error || t('chat.sshUnlockFailed'));
      return false;
    } finally {
      setSshUnlocking(false);
    }
  }, [sshLock, t]);

  useEffect(() => {
    if (!sshLock || sshLock.locked) return;
    const since = sshUnlockedAtRef.current;
    const needsUnlock = items.slice(-8).some(
      (it) =>
        (it.ts ?? 0) > since &&
        ((it.kind === 'tool' && it.status === 'error' && /passkey unlock required/i.test(it.resultText ?? '')) ||
          (it.kind === 'error' && /passkey unlock required/i.test(it.message ?? ''))),
    );
    if (needsUnlock) setSshLock((p) => (p ? { ...p, locked: true } : null));
  }, [items, sshLock]);

  useEffect(() => {
    setItems(initialTimeline?.items ?? []);
    if (initialTimeline) observeTimelineToolTiming(session.id, initialTimeline.items);
    clearCanvasStates();
    setPending(initialTimeline?.pending ?? []);
    setPerm(null);
    setModelRetryProgress(null);
    setMaxVisible(WINDOW_STEP);
    setStatus(sessionStatusRef.current);
    setSessionLoading(initialTimeline == null);
    setSandboxConnecting(false);
    setContextUsage(null);
    pendingOptimisticRef.current.forEach((p) => clearTimeout(p.timer));
    pendingOptimisticRef.current = [];
    replayEpochRef.current = initialTimeline?.epoch ?? null;
    timelineVersionRef.current = initialTimeline?.version ?? null;
    timelineApproxCharsRef.current = initialTimeline?.approxChars ?? 0;
    setEditing(null);
    pendingRewindReqRef.current = null;
    if (rewindRevertTimerRef.current) { clearTimeout(rewindRevertTimerRef.current); rewindRevertTimerRef.current = null; }
    const loadTimer = window.setTimeout(() => setSessionLoading(false), 3000);

    const handle = (ev: ServerEvent) => {
      switch (ev.type) {
        case 'timeline_replay':
          if (ev.sessionId === session.id) {
            replayEpochRef.current = ev.epoch;
            timelineVersionRef.current = Number.isSafeInteger(ev.version) ? ev.version : null;
            timelineApproxCharsRef.current = ws.eventCharCount(ev);
            observeTimelineToolTiming(session.id, ev.items);
            setItems(() => mergeReplayWithPending(ev.items, pendingOptimisticRef.current));
            setPending(ev.pending ?? []);
            setSessionLoading(false);
            if (rewindRevertTimerRef.current) { clearTimeout(rewindRevertTimerRef.current); rewindRevertTimerRef.current = null; }
            pendingRewindReqRef.current = null;
            const ed = editingRef.current;
            if (ed && !ev.items.some((it) => it.kind === 'user' && it.seq === ed.seq)) {
              setEditing(null);
              setInputValue(draftBeforeEditRef.current);
              showToast(t('chat.editCancelledChanged'));
            }
          }
          break;
        case 'session_rewound':
          if (ev.sessionId === session.id && pendingRewindReqRef.current == null) {
            ws.send({ type: 'subscribe', sessionId: session.id, reqId: nextReq() });
          }
          break;
        case 'sandbox_changed':
          if (ev.sessionId === session.id) {
            ws.send({ type: 'subscribe', sessionId: session.id, reqId: nextReq() });
          }
          break;
        case 'pending_queue':
          if (ev.sessionId !== session.id) break;
          if (replayEpochRef.current !== null && ev.epoch !== replayEpochRef.current) break;
          timelineVersionRef.current = Number.isSafeInteger(ev.version) ? ev.version : null;
          setPending(ev.pending);
          break;
        case 'session_status':
          if (ev.sessionId === session.id) {
            setStatus(ev.status);
            if (rewindRevertTimerRef.current) { clearTimeout(rewindRevertTimerRef.current); rewindRevertTimerRef.current = null; }
          }
          break;
        case 'agent_event':
          if (ev.sessionId !== session.id) break;
          if (replayEpochRef.current !== null && ev.epoch !== replayEpochRef.current) break;
          observeToolTimingEvent(session.id, ev.event);
          if (
            ev.event.t === 'team_assignment'
            || ev.event.t === 'user_message'
            || ev.event.t === 'assistant_end'
            || ev.event.t === 'tool_start'
            || ev.event.t === 'tool_status'
            || ev.event.t === 'tool_end'
            || ev.event.t === 'compaction'
            || ev.event.t === 'recap'
            || ev.event.t === 'error'
          ) timelineVersionRef.current = Number.isSafeInteger(ev.version) ? ev.version : null;
          if (
            ev.event.t === 'team_assignment'
            || ev.event.t === 'user_message'
            || ev.event.t === 'assistant_end'
            || ev.event.t === 'tool_start'
            || ev.event.t === 'tool_end'
            || (ev.event.t === 'subagent_event' && (
              ev.event.event.t === 'user_message'
              || ev.event.event.t === 'assistant_end'
              || ev.event.event.t === 'tool_start'
              || ev.event.event.t === 'tool_end'
              || ev.event.event.t === 'compaction'
              || ev.event.event.t === 'error'
            ))
            || ev.event.t === 'compaction'
            || ev.event.t === 'recap'
            || ev.event.t === 'error'
          ) timelineApproxCharsRef.current += ws.eventCharCount(ev);
          if (ev.event.t === 'user_message') {
            const echo = ev.event;
            const pending = pendingOptimisticRef.current;
            const pi = pending.findIndex((p) => p.text === echo.text);
            if (pi !== -1) {
              const { localId } = pending[pi];
              const serverId = echo.id;
              clearTimeout(pending[pi].timer);
              pending.splice(pi, 1);
              setItems((cur) => {
                const li = cur.findIndex((it) => it.id === localId);
                if (li === -1) return reduceTimeline(cur, echo);
                const copy = cur.slice();
                const local = copy[li];
                if (local.kind !== 'user') return reduceTimeline(cur, echo);
                copy[li] = { ...local, id: serverId, seq: echo.seq, turnId: echo.turnId };
                return copy;
              });
              break;
            }
          }
          if (ev.event.t === 'model_retry') {
            setModelRetryProgress({ attempt: ev.event.attempt, limit: ev.event.limit });
          }
          setItems((cur) => reduceTimeline(cur, ev.event));
          if (ev.event.t === 'turn_start') setStatus('running');
          const outerTurnEnded = ev.event.t === 'turn_end' && protocolVersionRef.current >= 5;
          if (ev.event.t === 'tool_end' || outerTurnEnded || ev.event.t === 'agent_end') onActivity();
          if (outerTurnEnded && ev.event.t === 'turn_end') {
            setModelRetryProgress(null);
            setStatus(ev.event.status === 'failed' ? 'error' : 'idle');
            setSandboxConnecting(false);
          }
          if (ev.event.t === 'agent_end') { setStatus('idle'); setSandboxConnecting(false); }
          break;
        case 'recap':
          if (ev.sessionId === session.id) {
            setItems((cur) => {
              const id = `legacy_recap_${ev.ts}`;
              if (cur.some((item) => item.id === id)) return cur;
              const anchorSeq = cur.length ? cur[cur.length - 1].seq : 0;
              return [...cur, {
                kind: 'recap', id, seq: Date.now(), text: ev.text, ts: ev.ts, anchorSeq,
                contractVersion: 0, source: 'fallback', generatorProvider: 'legacy',
                generatorModel: 'legacy', turnProvider: 'unknown', turnModel: 'unknown',
              }];
            });
          }
          break;
        case 'permission_request':
          if (ev.sessionId === session.id) setPerm(ev.request);
          break;
        case 'permission_resolved':
          if (ev.sessionId === session.id) setPerm((current) => (current && current.requestId === ev.requestId ? null : current));
          break;
        case 'sandbox_connecting':
          if (ev.sessionId === session.id) setSandboxConnecting(ev.connecting);
          break;
        case 'sandbox_load':
          if (ev.sessionId === session.id) { onSandboxLoad?.({ cpuPct: ev.cpuPct, memUsed: ev.memUsed, memTotal: ev.memTotal }); setSandboxConnecting(false); }
          break;
        case 'context_usage':
          if (ev.sessionId === session.id) setContextUsage({ used: ev.used, measured: ev.measured, pending: ev.pending, total: ev.total, compactAt: ev.compactAt, parts: ev.parts });
          break;
        case 'error':
          if (ev.code) {
            if (isPendingMutationRefusal(ev, session.id) && ws.pendingMutationSession(ev) === session.id) {
              showToast(ev.message);
            }
            break;
          }
          if (ev.reqId && ev.reqId === pendingRewindReqRef.current) {
            pendingRewindReqRef.current = null;
            if (rewindRevertTimerRef.current) { clearTimeout(rewindRevertTimerRef.current); rewindRevertTimerRef.current = null; }
            setStatus(rewindPrevStatusRef.current);
            showToast(ev.message);
            const le = lastEditRef.current;
            if (le) { setEditing(le); setInputValue((cur) => (cur.trim() ? cur : le.original)); }
            break;
          }
          timelineApproxCharsRef.current += ws.eventCharCount(ev);
          setItems((cur) => reduceTimeline(cur, { t: 'error', message: ev.message }));
          break;
      }
    };

    const unsubHandle = ws.addHandler(handle);
    const subscribe = () => {
      const epoch = replayEpochRef.current;
      const version = timelineVersionRef.current;
      ws.send({
        type: 'subscribe',
        sessionId: session.id,
        reqId: nextReq(),
        resume: epoch !== null && version !== null ? { epoch, version } : undefined,
      });
    };
    const unsubConn = ws.onConnect((connected) => {
      if (connected) subscribe();
    });
    subscribe();

    return () => {
      window.clearTimeout(loadTimer);
      if (rewindRevertTimerRef.current) { clearTimeout(rewindRevertTimerRef.current); rewindRevertTimerRef.current = null; }
      pendingOptimisticRef.current.forEach((p) => clearTimeout(p.timer));
      unsubConn();
      unsubHandle();
    };
  }, [ws, session.id, initialTimeline, onActivity, onSandboxLoad]);

  useEffect(() => {
    if (!replayEpochRef.current || timelineVersionRef.current === null) return;
    onTimelineChange?.({
      sessionId: session.id,
      epoch: replayEpochRef.current,
      version: timelineVersionRef.current,
      items,
      pending,
      approxChars: timelineApproxCharsRef.current,
    });
  }, [items, pending, session.id, onTimelineChange]);

  useEffect(() => {
    onStatusChange?.(session.id, status);
  }, [status, session.id, onStatusChange]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreScrollRef.current != null || pendingTocScrollRef.current != null) return;
    const composerGrew = composerH - prevComposerHRef.current;
    prevComposerHRef.current = composerH;
    const tail = items[items.length - 1];
    const lineFollowOwnsGrowth = composerGrew === 0
      && streamFollowActiveRef.current
      && tail?.kind === 'assistant';
    if (pinnedRef.current && !lineFollowOwnsGrowth) {
      streamFollowRef.current?.cancel();
      el.scrollTop = el.scrollHeight;
    }
    else if (composerGrew > 0) el.scrollTop += composerGrew;
    lastScrollTopRef.current = el.scrollTop;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollButton((prev) => (distance > 120 ? true : distance < 40 ? false : prev));
  }, [items, perm, composerH, status, modelRetryProgress?.attempt, modelRetryProgress?.limit]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !el.firstElementChild) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const follower = createStreamScrollFollower((scrollTop) => {
      lastScrollTopRef.current = scrollTop;
    });
    streamFollowRef.current = follower;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      if (!pinnedRef.current) {
        el.style.overflowAnchor = '';
        return;
      }
      if (restoreScrollRef.current != null || pendingTocScrollRef.current != null) return;
      const compensator = streamCompensatorRef.current;
      if (compensator) {
        const currentSpacer = compensator.getBoundingClientRect().height;
        const naturalHeight = Math.max(0, el.scrollHeight - currentSpacer);
        const next = resolveStreamHeight(
          streamHeightStateRef.current,
          naturalHeight,
          streamStabilityActiveRef.current,
        );
        streamHeightStateRef.current = next.state;
        if (Math.abs(currentSpacer - next.spacer) > 0.5) {
          compensator.style.height = `${next.spacer / chatScale}px`;
          frame = requestAnimationFrame(measure);
          return;
        }
      }
      el.style.overflowAnchor = streamStabilityActiveRef.current ? 'none' : '';
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      const animate = shouldAnimateStreamFollow(
        target - el.scrollTop,
        streamFollowActiveRef.current && document.visibilityState === 'visible',
        reducedMotion?.matches === true,
      );
      follower.follow(el, animate);
    };
    const scheduleMeasure = () => {
      if (frame == null) frame = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(el.firstElementChild);
    const onReducedMotion = () => {
      if (!reducedMotion?.matches) return;
      follower.cancel();
      if (pinnedRef.current) {
        el.scrollTop = el.scrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') return;
      follower.cancel();
      if (pinnedRef.current) {
        el.scrollTop = el.scrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      }
    };
    reducedMotion?.addEventListener?.('change', onReducedMotion);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      ro.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
      reducedMotion?.removeEventListener?.('change', onReducedMotion);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      follower.cancel();
      el.style.overflowAnchor = '';
      if (streamFollowRef.current === follower) streamFollowRef.current = null;
    };
  }, [chatScale, session.id]);

  useLayoutEffect(() => {
    streamHeightStateRef.current = { floor: null };
    if (streamCompensatorRef.current) streamCompensatorRef.current.style.height = '0px';
  }, [chatScale, session.id]);

  useEffect(() => {
    const handleResize = () => {
      const el = scrollRef.current;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      setShowScrollButton(scrollHeight - scrollTop - clientHeight >= 120);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ignoringResizeScroll = ignoringResizeScrollRef;
    lastWidthRef.current = el.clientWidth;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === lastWidthRef.current) return;
      lastWidthRef.current = w;
      if (!pinnedRef.current) return;
      ignoringResizeScroll.current = true;
      streamFollowRef.current?.cancel();
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        ignoringResizeScroll.current = false;
        raf = 0;
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      ignoringResizeScroll.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const el = composerWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ta = textareaRef.current;
    if (ta) ta.style.height = `${RESTING_TEXTAREA_H}px`;
    let textareaWidth = ta?.getBoundingClientRect().width ?? 0;
    let textareaResizeRaf = 0;
    const textareaRo = ta
      ? new ResizeObserver(() => {
          const nextWidth = ta.getBoundingClientRect().width;
          if (Math.abs(nextWidth - textareaWidth) < 0.5) return;
          textareaWidth = nextWidth;
          ignoringResizeScrollRef.current = true;
          fitDraft(ta);
          if (textareaResizeRaf) cancelAnimationFrame(textareaResizeRaf);
          textareaResizeRaf = requestAnimationFrame(() => {
            ignoringResizeScrollRef.current = false;
            textareaResizeRaf = 0;
          });
        })
      : null;
    if (ta && textareaRo) textareaRo.observe(ta);
    const syncComposerHeight = () => {
      const newH = Math.round(el.getBoundingClientRect().height);
      if (newH <= 0 || newH === composerHRef.current) return;
      composerHRef.current = newH;
      setComposerH(newH);
      const taEl = textareaRef.current;
      if (taEl && Math.round(taEl.getBoundingClientRect().height) <= RESTING_TEXTAREA_H) {
        restingComposerHRef.current = newH;
      }
    };
    syncComposerHeight();
    const ro = new ResizeObserver(syncComposerHeight);
    ro.observe(el);
    return () => {
      ro.disconnect();
      textareaRo?.disconnect();
      if (textareaResizeRaf) cancelAnimationFrame(textareaResizeRaf);
      ignoringResizeScrollRef.current = false;
    };
  }, []);

  useEffect(() => {
    const root = composerWrapRef.current;
    if (!root || typeof MutationObserver === 'undefined') return;
    const selector = '[data-testid="slash-menu"], [role="dialog"], [role="menu"]';
    const sync = () => setComposerSurfaceOpen(
      Array.from(root.querySelectorAll<HTMLElement>(selector)).some((surface) => surface.getClientRects().length > 0),
    );
    sync();
    const mutations = new MutationObserver(sync);
    mutations.observe(root, { childList: true, subtree: true });
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const layoutMode = (width: number) => width < 48 * rem ? 0 : width < 64 * rem ? 1 : 2;
    let lastLayoutMode = layoutMode(root.clientWidth);
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const nextLayoutMode = layoutMode(root.clientWidth);
      if (nextLayoutMode !== lastLayoutMode) {
        lastLayoutMode = nextLayoutMode;
        closeComposerPopoverGroup('composer-footer');
        closeComposerPopoverGroup('composer-overflow');
      }
      sync();
    });
    resize?.observe(root);
    return () => {
      mutations.disconnect();
      resize?.disconnect();
    };
  }, []);

  const scrollToBottom = () => {
    pinnedRef.current = true;
    streamFollowRef.current?.cancel();
    setShowScrollButton(false);
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      el.focus({ preventScroll: true });
    });
  };

  const showEarlier = () => {
    const el = scrollRef.current;
    if (el) restoreScrollRef.current = el.scrollHeight - el.scrollTop;
    setMaxVisible((m) => m + WINDOW_STEP);
  };

  useLayoutEffect(() => {
    if (restoreScrollRef.current == null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - restoreScrollRef.current;
    restoreScrollRef.current = null;
  }, [maxVisible]);

  const conversationTurns = useMemo(() => groupConversationTurns(items), [items]);
  const rewindableUserIds = useMemo(() => turnRootUserIds(items), [items]);

  const turnUsageById = useMemo(() => {
    const byId = new Map<string, { input: number; output: number; total: number; costUsd: number }>();
    for (let index = 0; index < conversationTurns.length; index++) {
      const turn = conversationTurns[index];
      if (status === 'running' && index === conversationTurns.length - 1) continue;
      let acc: { input: number; output: number; total: number; costUsd: number } | null = null;
      let lastAssistantId: string | null = null;
      for (const item of turn.items) {
        if (item.kind !== 'assistant' || !item.usage) continue;
        acc = acc
          ? { input: acc.input + item.usage.input, output: acc.output + item.usage.output, total: acc.total + item.usage.total, costUsd: acc.costUsd + item.usage.costUsd }
          : { input: item.usage.input, output: item.usage.output, total: item.usage.total, costUsd: item.usage.costUsd };
        lastAssistantId = item.id;
      }
      if (lastAssistantId && acc) byId.set(lastAssistantId, acc);
    }
    return byId;
  }, [conversationTurns, status]);

  const turnCopyById = useMemo(() => {
    const byId = new Map<string, string>();
    for (let index = 0; index < conversationTurns.length; index++) {
      const turn = conversationTurns[index];
      if (status === 'running' && index === conversationTurns.length - 1) continue;
      let lastTextId: string | null = null;
      let lastText = '';
      for (const item of turn.items) {
        if (item.kind !== 'assistant') continue;
        const text = item.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
        if (text) { lastTextId = item.id; lastText = text; }
      }
      if (lastTextId) byId.set(lastTextId, lastText);
    }
    return byId;
  }, [conversationTurns, status]);
  const liveTail = items[items.length - 1];
  streamFollowActiveRef.current = liveTail?.kind === 'assistant' && liveTail.streaming === true;
  streamStabilityActiveRef.current = status === 'running';
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.style.overflowAnchor = status === 'running' && pinnedRef.current ? 'none' : '';
  }, [status]);

  const { turnEntries, tocOpen, setTocOpen, tocActiveId, jumpToPrompt, pendingTocScrollRef } = useReaderOutline({
    items,
    scrollRef,
    maxVisible,
    setMaxVisible,
    pinnedRef,
    resetKey: session.id,
  });

  const handleScroll = () => {
    if (!scrollRef.current) return;
    if (ignoringResizeScrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distance = scrollHeight - scrollTop - clientHeight;
    if (scrollTop < lastScrollTopRef.current - 6 && distance > 4) {
      pinnedRef.current = false;
      streamFollowRef.current?.cancel();
      scrollRef.current.style.overflowAnchor = '';
    }
    else if (distance < 40) {
      pinnedRef.current = true;
      scrollRef.current.style.overflowAnchor = status === 'running' ? 'none' : '';
    }
    lastScrollTopRef.current = scrollTop;
    setShowScrollButton((prev) => (distance > 120 ? true : distance < 40 ? false : prev));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputValue(value);
    histCursorRef.current = -1;

    if (textareaRef.current) {
      ignoringResizeScrollRef.current = true;
      requestAnimationFrame(() => {
        ignoringResizeScrollRef.current = false;
      });
      fitDraft(textareaRef.current);
    }
  };

  const applyRecall = (value: string) => {
    setInputValue(value);
    const el = textareaRef.current;
    if (el) {
      el.value = value;
      fitDraft(el);
      el.setSelectionRange(value.length, value.length);
    }
  };

  const recallHistory = (dir: 'prev' | 'next'): boolean => {
    const hist = promptHistoryRef.current;
    if (hist.length === 0) return false;
    let cursor = histCursorRef.current;
    if (dir === 'prev') {
      if (cursor === -1) {
        histDraftRef.current = inputValue;
        cursor = 0;
      } else if (cursor < hist.length - 1) {
        cursor += 1;
      } else {
        return true;
      }
      histCursorRef.current = cursor;
      applyRecall(hist[hist.length - 1 - cursor]);
      return true;
    }
    if (cursor === -1) return false;
    if (cursor === 0) {
      histCursorRef.current = -1;
      applyRecall(histDraftRef.current);
      return true;
    }
    cursor -= 1;
    histCursorRef.current = cursor;
    applyRecall(hist[hist.length - 1 - cursor]);
    return true;
  };

  const setDraftText = useCallback((text: string) => {
    setInputValue(text);
    histCursorRef.current = -1;
    const el = textareaRef.current;
    if (el) {
      ignoringResizeScrollRef.current = true;
      requestAnimationFrame(() => {
        ignoringResizeScrollRef.current = false;
      });
      el.value = text;
      fitDraft(el);
    }
  }, [fitDraft]);

  const suggestionKey = suggestionForSession(session.id);
  const firstTaskSuggestion = shouldSuggestFirstTask({ hasActivity: items.length > 0, draft: inputValue })
    ? t(`chat.${suggestionKey}`)
    : undefined;

  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (autoFocusedRef.current || sessionLoading || items.length > 0) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    autoFocusedRef.current = true;
    textareaRef.current?.focus({ preventScroll: true });
  }, [sessionLoading, items.length]);

  const prefillComposer = useCallback((text: string) => {
    setInputValue(text);
    const el = textareaRef.current;
    if (el) {
      fitDraft(el);
      el.focus();
      el.setSelectionRange(text.length, text.length);
    }
  }, []);

  const handleResume = useCallback((text: string) => { prefillComposer(text); }, [prefillComposer]);

  const handleRetry = useCallback(() => {
    ws.send({ type: 'send_message', sessionId: session.id, text: '', reqId: nextReq(), mode: 'retry' });
  }, [ws, session.id]);

  const beginEdit = useCallback((item: Extract<TimelineItem, { kind: 'user' }>) => {
    if (sessionStatusRef.current === 'running') return;
    const { cleanText } = parseMessageAttachments(item.text);
    draftBeforeEditRef.current = inputValueRef.current;
    setEditing({ seq: item.seq, original: cleanText });
    prefillComposer(cleanText);
  }, [prefillComposer]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    prefillComposer(draftBeforeEditRef.current);
  }, [prefillComposer]);

  const resetComposerHeight = useCallback(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = `${RESTING_TEXTAREA_H}px`;
    setDraftOverflow(false);
    composerHRef.current = restingComposerHRef.current;
    setComposerH(restingComposerHRef.current);
  }, []);

  const compactionFloorSeq = useMemo(
    () => items.reduce((f, it) => (it.kind === 'compaction' ? Math.max(f, it.seq) : f), -1),
    [items],
  );
  const canEdit = protocolVersion >= 2 && status !== 'running';
  const canFork = protocolVersion >= 2 && !!onFork;

  const MAX_FILES = 10;
  const MAX_UPLOAD = 10 * 1024 * 1024;

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    let total = attachments.reduce((n, a) => n + a.size, 0);
    const additions: Attachment[] = [];
    let err = '';
    for (const file of Array.from(list)) {
      if (attachments.length + additions.length >= MAX_FILES) { err = t('upload.atMostFiles', { count: MAX_FILES }); break; }
      if ([...attachments, ...additions].some((a) => a.name === file.name && a.size === file.size)) continue;
      if (total + file.size > MAX_UPLOAD) { err = t('upload.totalExceeds', { mb: MAX_UPLOAD / 1024 / 1024 }); break; }
      total += file.size;
      additions.push({ name: file.name, size: file.size, type: file.type, file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined });
    }
    setAttachError(err);
    if (additions.length) setAttachments((cur) => [...cur, ...additions]);
  };

  const addPastedText = (text: string) => {
    if (attachments.length >= MAX_FILES) {
      setAttachError(t('upload.atMostFiles', { count: MAX_FILES }));
      return;
    }
    const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
    if (text.length > MAX_UPLOAD - total) {
      setAttachError(t('upload.totalExceeds', { mb: MAX_UPLOAD / 1024 / 1024 }));
      return;
    }
    const seed = globalThis.crypto?.randomUUID?.()
      ?? `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    const name = pastedTextFilename(seed);
    const file = new File([text], name, { type: 'text/plain', lastModified: Date.now() });
    if (total + file.size > MAX_UPLOAD) {
      setAttachError(t('upload.totalExceeds', { mb: MAX_UPLOAD / 1024 / 1024 }));
      return;
    }
    setAttachError('');
    setAttachments((current) => [...current, {
      name,
      size: file.size,
      type: file.type,
      file,
      kind: 'pasted-text',
    }]);
  };

  const removeAttachment = (i: number) => {
    setAttachments((cur) => {
      const a = cur[i];
      if (a?.url) URL.revokeObjectURL(a.url);
      return cur.filter((_, idx) => idx !== i);
    });
  };

  const updatePastedText = (i: number, text: string): string | null => {
    const current = attachments[i];
    if (!current || current.kind !== 'pasted-text') return t('chat.pastedTextLoadFailed');
    const file = new File([text], current.name, { type: 'text/plain', lastModified: Date.now() });
    const nextTotal = attachments.reduce((sum, attachment, index) =>
      sum + (index === i ? file.size : attachment.size), 0);
    if (nextTotal > MAX_UPLOAD) return t('upload.totalExceeds', { mb: MAX_UPLOAD / 1024 / 1024 });
    setAttachments((all) => all.map((attachment, index) => index === i
      ? { ...attachment, size: file.size, type: file.type, file }
      : attachment));
    setAttachError('');
    return null;
  };

  // The selector's options follow the draft: an image attachment drops every model
  // whose catalog record does not declare image input, so an incompatible model can
  // never be chosen — and a stale choice is cleared instead of silently kept.
  const composerModels = useMemo(() => modelsForDraft(models ?? [], attachments), [models, attachments]);
  const currentModelInfo = useMemo(
    () => (models ?? []).find((m) => m.provider === session.provider && m.id === session.model),
    [models, session.provider, session.model],
  );
  const modelClearedForAttachments = useMemo(() => {
    if (currentModelInfo && !modelStillCompatible(currentModelInfo, attachments)) return true;
    if (!currentModelInfo) return false;
    return !composerModels.some((m) => m.provider === currentModelInfo.provider && m.id === currentModelInfo.id);
  }, [currentModelInfo, attachments, composerModels]);
  useEffect(() => {
    if (!modelClearedForAttachments) return;
    const fallback = composerModels.find((m) => !m.mock);
    if (fallback && onSetModel) onSetModel(session.id, fallback.provider, fallback.id);
    setAttachError(t('chat.modelIncompatible', { model: currentModelInfo?.name ?? session.model }));
  }, [modelClearedForAttachments, composerModels, onSetModel, session.id, session.model, currentModelInfo, t]);

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const send = async (mode?: 'steer' | 'queue') => {
    const text = inputValue.trim();

    if (sshLock?.locked) {
      const unlocked = await doSshUnlock();
      if (!unlocked) return;
    }

    if (editing) {
      if (!text || status === 'running') return;
      if (ws.state !== 'open') { showToast(t('chat.resendNoResponse')); return; }
      const reqId = nextReq();
      const toSeq = editing.seq;
      lastEditRef.current = editing;
      pendingRewindReqRef.current = reqId;
      rewindPrevStatusRef.current = status;
      setEditing(null);
      editingRef.current = null;
      setInputValue('');
      resetComposerHeight();
      pinnedRef.current = true;
      const hist = promptHistoryRef.current;
      if (hist[hist.length - 1] !== text) {
        hist.push(text);
        if (hist.length > MAX_PROMPT_HISTORY) hist.splice(0, hist.length - MAX_PROMPT_HISTORY);
      }
      histCursorRef.current = -1;
      setStatus('running');
      if (rewindRevertTimerRef.current) clearTimeout(rewindRevertTimerRef.current);
      rewindRevertTimerRef.current = setTimeout(() => {
        rewindRevertTimerRef.current = null;
        if (pendingRewindReqRef.current === reqId) {
          pendingRewindReqRef.current = null;
          setStatus(rewindPrevStatusRef.current);
          showToast(t('chat.resendNoResponse'));
        }
      }, 12000);
      ws.send({ type: 'rewind', sessionId: session.id, toSeq, newText: text, reqId });
      return;
    }

    if ((!text && attachments.length === 0) || uploading) return;
    const running = status === 'running';
    if (running && !mode) return;
    ensureNotifyPermission();
    const isFirstMessage = items.length === 0 && !running;
    pinnedRef.current = true;

    let note = '';
    if (attachments.length > 0) {
      setUploading(true);
      setUploadProgress(0);
      try {
        const payload = await Promise.all(attachments.map(async (a) => ({ name: a.name, dataBase64: await fileToBase64(a.file) })));
        const res = await api.upload(session.id, payload, setUploadProgress);
        const imgs = res.files.filter((f) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name));
        const pastedNames = new Set(
          attachments
            .filter((attachment) => attachment.kind === 'pasted-text')
            .map((attachment) => attachment.name),
        );
        const pasted = res.files.filter((file) => pastedNames.has(file.name));
        note =
          `\n\n[Attached ${res.files.length} file(s) in ./uploads/: ${res.files.map((f) => f.path).join(', ')}]` +
          (imgs.length ? `\nUse read_image to view the image(s): ${imgs.map((f) => f.path).join(', ')}.` : '') +
          (pasted.length ? `\nUse read_file to read the pasted text before responding: ${pasted.map((f) => f.path).join(', ')}.` : '');
      } catch (e) {
        setAttachError(e instanceof Error ? e.message : t('upload.failed'));
        setUploading(false);
        setUploadProgress(0);
        return;
      }
      setUploading(false);
      setUploadProgress(0);
    }

    let effectiveText = text;
    const slash = parseSlash(text);
    if (slash) {
      const built = slash.cmd.build(slash.arg);
      if (built == null) { showToast(t('slash.needsArg', { name: slash.cmd.name })); return; }
      effectiveText = built;
    }

    const wireText = (effectiveText + note).trim();
    const steerOrQueue = running && (mode === 'steer' || mode === 'queue');
    if (steerOrQueue) {
      const tempId = 'local_p_' + nextLocalMsgId();
      const optimistic: PendingMessage = { id: tempId, kind: mode, text: wireText, ts: Date.now(), ord: Number.MAX_SAFE_INTEGER };
      setPending((cur) => [...cur, optimistic]);
      ws.send({ type: 'send_message', sessionId: session.id, text: wireText, reqId: nextReq(), mode });
    } else {
      const localId = nextLocalMsgId();
      const timer = setTimeout(() => {
        const pend = pendingOptimisticRef.current;
        const i = pend.findIndex((p) => p.localId === localId);
        if (i === -1) return;
        pend.splice(i, 1);
        setItems((cur) => cur.filter((it) => it.id !== localId));
      }, OPTIMISTIC_ECHO_TIMEOUT_MS);
      pendingOptimisticRef.current.push({ localId, text: wireText, timer });
      setItems((cur) => [...cur, { kind: 'user', id: localId, seq: Date.now(), text: wireText, ts: Date.now() }]);
      const canvasState = collectCanvasDiffs() || undefined;
      ws.send({ type: 'send_message', sessionId: session.id, text: wireText, reqId: nextReq(), mode: undefined, canvasState });
    }
    if (text) {
      const hist = promptHistoryRef.current;
      if (hist[hist.length - 1] !== text) {
        hist.push(text);
        if (hist.length > MAX_PROMPT_HISTORY) hist.splice(0, hist.length - MAX_PROMPT_HISTORY);
      }
    }
    histCursorRef.current = -1;
    if (isFirstMessage && text) onAutoTitle?.(session.id, session.title, text);
    setInputValue('');
    attachments.forEach((a) => a.url && URL.revokeObjectURL(a.url));
    setAttachments([]);
    setAttachError('');
    if (textareaRef.current) {
      textareaRef.current.style.height = `${RESTING_TEXTAREA_H}px`;
      setDraftOverflow(false);
      composerHRef.current = restingComposerHRef.current;
      setComposerH(restingComposerHRef.current);
    }
    if (!running) setStatus('running');
  };

  const respond = (decision: PermissionDecision) => {
    if (!perm) return;
    ws.send({ type: 'permission_response', sessionId: session.id, requestId: perm.requestId, decision, reqId: nextReq() });
    setPerm(null);
  };

  const hasFiles = (e: DragEvent) => e.dataTransfer?.types?.includes('Files');

  return (
    <MarkdownFileLinkContext.Provider value={fileLinkCtx}>
    <div
      data-testid="main-content"
      data-session-cache-hit={initialTimeline ? "true" : "false"}
      className={`flex-1 flex flex-col relative min-w-0 h-full${wideMode ? ' reader-wide' : ''}`}
      onDragEnter={(e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth.current += 1; setDragOver(true); } }}
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragOver(false); }}
      onDrop={(e) => { dragDepth.current = 0; setDragOver(false); if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}
    >
      {dragOver && (
        <div className="absolute inset-0 z-30 m-3 rounded-2xl border-2 border-dashed border-[#A0A0A0] dark:border-[#555] bg-white/75 dark:bg-[#1A1A1A]/75 backdrop-blur-sm flex items-center justify-center pointer-events-none text-[14px] font-medium text-[#555] dark:text-[#bbb]">
          {t('chat.dropToAttach')}
        </div>
      )}
      <SessionLoaderOverlay active={sessionLoading} label={t('chat.loading')} bottomInset={composerH} />

      <ReaderActionDock
        bottom={composerH + 10}
        turns={turnEntries}
        tocOpen={tocOpen}
        setTocOpen={setTocOpen}
        tocActiveId={tocActiveId}
        onJumpToPrompt={jumpToPrompt}
        onShare={onShare}
        visible={!composerSurfaceOpen && !sandboxConnecting && !sshLock?.locked}
        recessed={status === 'running' && (inputValue.trim().length > 0 || attachments.length > 0) && !uploading}
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={(e) => {
          if (e.deltaY < 0) {
            pinnedRef.current = false;
            streamFollowRef.current?.cancel();
            e.currentTarget.style.overflowAnchor = '';
          }
        }}
        data-testid="timeline"
        tabIndex={-1}
        className="flex-1 overflow-y-auto p-6 mt-1"
        style={{ paddingBottom: composerH + 24 }}
      >

        <Timeline
          chatScale={chatScale}
          status={status}
          sessionLoading={sessionLoading}
          teamMemberSession={session.isTeamMemberSession}
          items={items}
          maxVisible={maxVisible}
          showEarlier={showEarlier}
          toolFold={toolFold}
          sessionId={session.id}
          onOpenTool={onOpenTool}
          onOpenFile={onOpenFile}
          onOpenCompaction={onOpenCompaction}
          activeToolId={activeToolId}
          activeCompactionId={activeCompactionId}
          handleResume={handleResume}
          handleRetry={protocolVersion >= 7 ? handleRetry : undefined}
          beginEdit={beginEdit}
          canEdit={canEdit}
          onFork={onFork}
          canFork={canFork}
          compactionFloorSeq={compactionFloorSeq}
          rewindableUserIds={rewindableUserIds}
          turnUsageById={turnUsageById}
          turnCopyById={turnCopyById}
          streamCompensatorRef={streamCompensatorRef}
          perm={perm}
          respond={respond}
        />
      </div>

      <JumpToLatest
        bottom={composerH + 10}
        show={showScrollButton && !tocOpen && !composerSurfaceOpen && !sandboxConnecting && !sshLock?.locked}
        onJump={scrollToBottom}
      />

      {sandboxConnecting && (
        <div
          className="absolute left-0 right-0 flex justify-center pointer-events-none"
          style={{ bottom: composerH + 10, zIndex: 20 }}
        >
          <span
            data-testid="sandbox-connecting"
            className="flex items-center gap-1.5 rounded-full bg-[#F4F4F5] dark:bg-[#2A2A2A] text-[#666] dark:text-[#999] text-[12.5px] pl-2.5 pr-3 py-1.5 shadow-[0_2px_10px_rgba(0,0,0,0.08)]"
          >
            <StatusDot tone="working" pulse />
            {t('chat.sandboxConnecting')}
          </span>
        </div>
      )}

      {sshLock?.locked && (
        <div className="absolute left-0 right-0 flex justify-center" style={{ bottom: composerH + 10, zIndex: 20 }}>
          <span
            data-testid="ssh-locked-banner"
            className="flex items-center gap-2 rounded-full bg-[#FBF1E0] dark:bg-[#332711] text-[#A07013] dark:text-[#D6A038] text-[12.5px] pl-3 pr-1.5 py-1 shadow-[0_2px_10px_rgba(0,0,0,0.08)]"
          >
            <Lock strokeWidth={2} className="size-[13px]" />
            {t('chat.sshLocked')}
            <button
              type="button"
              data-testid="ssh-unlock"
              onClick={() => void doSshUnlock()}
              disabled={sshUnlocking}
              className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-[#A07013] dark:bg-[#D6A038] text-white dark:text-[#241a06] text-[11.5px] font-medium px-2.5 py-1 hover:opacity-90 disabled:opacity-60 transition-opacity"
            >
              {sshUnlocking ? t('chat.sshUnlocking') : t('chat.sshUnlock')}
            </button>
          </span>
        </div>
      )}

      <Composer
        composerWrapRef={composerWrapRef}
        fileInputRef={fileInputRef}
        textareaRef={textareaRef}
        composingRef={composingRef}
        ws={ws}
        session={session}
        status={status}
        items={items}
        retryProgress={modelRetryProgress}
        awaitingApproval={perm !== null}
        slashList={slashList}
        slashActive={slashActive}
        setSlashActive={setSlashActive}
        setSlashDismissedFor={setSlashDismissedFor}
        applySlash={applySlash}
        pending={pending}
        setPending={setPending}
        editing={editing}
        cancelEdit={cancelEdit}
        attachments={attachments}
        attachError={attachError}
        addFiles={addFiles}
        addPastedText={addPastedText}
        removeAttachment={removeAttachment}
        updatePastedText={updatePastedText}
        uploading={uploading}
        draftOverflow={draftOverflow}
        setDraft={setDraftText}
        firstTaskSuggestion={firstTaskSuggestion}
        onAcceptSuggestion={firstTaskSuggestion ? () => prefillComposer(firstTaskSuggestion) : undefined}
        uploadProgress={uploadProgress}
        inputValue={inputValue}
        handleInputChange={handleInputChange}
        isImeComposing={isImeComposing}
        recallHistory={recallHistory}
        send={send}
        contextUsage={contextUsage}
        onSetThinkingLevel={onSetThinkingLevel}
        onSetApprovalPolicy={onSetApprovalPolicy}
        models={composerModels}
        onSetModel={onSetModel}
      />
    </div>
    </MarkdownFileLinkContext.Provider>
  );
});
