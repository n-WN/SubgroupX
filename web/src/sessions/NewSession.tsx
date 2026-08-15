import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Cloud,
  Cpu,
  ChevronRight,
  Shield,
} from "lucide-react";
import { api, type ConnectorInfo, type SshTargetInfo } from "../platform/api.ts";
import { modelExecutorAvailability } from "../platform/executors.ts";
import { useT } from "../i18n";
import { userIcon, type LucideIcon } from "../dashboard/features/skills/skill-icons.ts";
import { BUILTIN_PERSONAS } from "../dashboard/features/skills/builtins.ts";
import { StatusDot } from "../ui/StatusDot.tsx";
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalDismiss,
  ModalBody,
  MODAL_EXIT_DURATION_MS,
} from "../ui/Modal.tsx";
import {
  OPERATOR_MODEL_PROVIDER,
  type ModelInfo,
  type SessionInfo,
  type SandboxMode,
  type SandboxKind,
  type SessionMode,
  type SkillSummary,
  type ApprovalPolicy,
  type ExecutorAvailability,
} from "@shared/protocol";

type ModeOption = {
  value: SessionMode;
  label: string;
  description: string;
  icon: LucideIcon;
};

type NewSessionState = {
  models: ModelInfo[];
  executors: ExecutorAvailability;
  sshTargets: SshTargetInfo[];
  connectors: ConnectorInfo[];
  userSkills: SkillSummary[];
  title: string;
  modelKey: string;
  sandboxMode: SandboxMode;
  mode: SessionMode;
  sandboxKind: SandboxKind;
  connectorId: string;
  sshTargetId: string;
  approvalPolicy: ApprovalPolicy;
  runtimeTouched: boolean;
  busy: boolean;
  error: string;
};

type NewSessionAction =
  | { type: "modelsLoaded"; models: ModelInfo[]; executors: ExecutorAvailability; isAdmin: boolean }
  | { type: "sshLoaded"; sshTargets: SshTargetInfo[]; isAdmin: boolean }
  | { type: "connectorsLoaded"; connectors: ConnectorInfo[]; isAdmin: boolean }
  | { type: "skillsLoaded"; userSkills: SkillSummary[] }
  | { type: "setTitle"; value: string }
  | { type: "setModelKey"; value: string }
  | { type: "setSandboxMode"; value: SandboxMode }
  | { type: "setMode"; value: SessionMode; isAdmin: boolean }
  | { type: "isAdminResolved"; isAdmin: boolean }
  | { type: "setSandboxKind"; value: SandboxKind }
  | { type: "setConnectorId"; value: string }
  | { type: "setSshTargetId"; value: string }
  | { type: "setApprovalPolicy"; value: ApprovalPolicy }
  | { type: "submitStart" }
  | { type: "submitError"; value: string }
  | { type: "submitDone" };

function preferredModelKey(models: ModelInfo[], fallback: string): string {
  const operator = models.find((m) => m.provider === OPERATOR_MODEL_PROVIDER);
  if (operator) return `${operator.provider}::${operator.id}`;
  return models[0] ? `${models[0].provider}::${models[0].id}` : fallback;
}

function boldRequiresConnector(mode: SessionMode, isAdmin: boolean): boolean {
  return mode === "bold" && !isAdmin;
}

function defaultRuntimeForMode(
  mode: SessionMode,
  isAdmin: boolean,
  executors: ExecutorAvailability,
  connectors: readonly ConnectorInfo[],
  sshTargets: readonly SshTargetInfo[],
): SandboxKind {
  if (boldRequiresConnector(mode, isAdmin)) return "connector";
  if (executors.e2b.available) return "e2b";
  if (connectors.length > 0) return "connector";
  if (sshTargets.length > 0) return "ssh";
  if (executors.local.available) return "local";
  return "connector";
}

const INITIAL_EXECUTORS: ExecutorAvailability = {
  local: { available: false, reason: "policy_disabled" },
  e2b: { available: false, reason: "not_configured" },
};

const CONTROL_CLASS =
  "h-10 w-full rounded-[10px] border border-[#DDE1D8] bg-[#FEFEFC] px-3 text-[13px] text-[#302F2A] outline-none transition-[border-color,box-shadow,background-color] focus:border-[#B89A70] focus:bg-white focus:ring-4 focus:ring-[#C77D2E]/10 dark:border-[#3C3B36] dark:bg-[#22221F] dark:text-[#E8E5DC] dark:focus:border-[#856B48] dark:focus:bg-[#262520]";

function SessionModeCard({
  value,
  active,
  icon,
  label,
  description,
  onSelect,
}: {
  value: SessionMode;
  active: boolean;
  icon: ReactNode;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  const optionTestId = `ns-mode-option-${value}`;
  const cardTestId = `ns-mode-card-${value}`;
  return (
    <label
      data-testid={optionTestId}
      className={`group relative min-h-[108px] cursor-pointer rounded-[14px] border p-3.5 text-left outline-none transition-[border-color,background-color,box-shadow,transform] focus-within:ring-2 focus-within:ring-[#C77D2E]/25 motion-safe:hover:-translate-y-px ${
        active
          ? "border-[#CDBB9D] bg-[#F3EEE3] shadow-[inset_0_0_0_1px_rgba(199,125,46,0.08)] dark:border-[#66583F] dark:bg-[#2A2821]"
          : "border-[#E1E4DC] bg-[#FDFEFA] hover:border-[#CDD1C7] hover:bg-white dark:border-[#373733] dark:bg-[#20201E] dark:hover:border-[#4A4942] dark:hover:bg-[#242421]"
      }`}
    >
      <input
        type="radio"
        name="new-session-mode"
        value={value}
        checked={active}
        onChange={onSelect}
        className="sr-only"
        data-testid={cardTestId}
      />
      <span className="flex items-start justify-between gap-3">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-[9px] border ${
            active
              ? "border-[#D8C6A8] bg-[#FBF7EE] text-[#8C6233] dark:border-[#5B503A] dark:bg-[#302D24] dark:text-[#D29A5B]"
              : "border-[#E3E5DF] bg-[#F5F7F2] text-[#72736C] dark:border-[#3C3C37] dark:bg-[#282824] dark:text-[#AAA79E]"
          }`}
        >
          {icon}
        </span>
        <span
          className={`flex size-5 items-center justify-center rounded-full border transition-opacity ${
            active
              ? "border-[#C7A778] bg-[#C77D2E] text-white opacity-100"
              : "border-[#D9DCD4] text-transparent opacity-0 group-hover:opacity-60 dark:border-[#494943]"
          }`}
          aria-hidden="true"
        >
          <Check className="size-3" strokeWidth={2.5} />
        </span>
      </span>
      <span className="mt-3 block text-[13px] font-semibold leading-4 text-[#2E2D28] dark:text-[#E8E5DC]">
        {label}
      </span>
      <span className="mt-1 block text-[11.5px] leading-[1.45] text-[#85857D] dark:text-[#96938A]">
        {description}
      </span>
    </label>
  );
}

function SessionConfigSection({
  icon,
  title,
  description,
  className = "",
  alignRows = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
  alignRows?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-[15px] border border-[#E1E4DC] bg-[#FDFEFA] p-4 dark:border-[#373733] dark:bg-[#20201E] ${
        alignRows ? "md:row-span-2 md:grid md:grid-rows-subgrid md:content-start" : ""
      } ${className}`}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-[#E1E4DC] bg-[#F3F5F0] text-[#74756E] dark:border-[#3E3E39] dark:bg-[#292925] dark:text-[#AAA79E]">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-[12.5px] font-semibold text-[#34332E] dark:text-[#E8E5DC]">{title}</span>
          <span className="mt-0.5 block text-[11px] leading-4 text-[#8A8981] dark:text-[#908E86]">{description}</span>
        </span>
      </div>
      <div className={`space-y-3 ${alignRows ? "mt-3.5 md:mt-0" : "mt-3.5"}`}>{children}</div>
    </section>
  );
}

function SessionField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1.5 block text-[11px] font-medium text-[#77776F] dark:text-[#9A978F]">{label}</span>
      {children}
    </label>
  );
}

function newSessionReducer(state: NewSessionState, action: NewSessionAction): NewSessionState {
  switch (action.type) {
    case "modelsLoaded":
      return {
        ...state,
        models: action.models,
        executors: action.executors,
        modelKey: preferredModelKey(action.models, state.modelKey),
        sandboxKind: state.runtimeTouched
          ? state.sandboxKind
          : defaultRuntimeForMode(state.mode, action.isAdmin, action.executors, state.connectors, state.sshTargets),
      };
    case "sshLoaded":
      return {
        ...state,
        sshTargets: action.sshTargets,
        sshTargetId: action.sshTargets[0]?.id ?? state.sshTargetId,
        sandboxKind: state.runtimeTouched
          ? state.sandboxKind
          : defaultRuntimeForMode(state.mode, action.isAdmin, state.executors, state.connectors, action.sshTargets),
      };
    case "connectorsLoaded":
      return {
        ...state,
        connectors: action.connectors,
        connectorId: action.connectors[0]?.id ?? state.connectorId,
        sandboxKind: state.runtimeTouched
          ? state.sandboxKind
          : defaultRuntimeForMode(state.mode, action.isAdmin, state.executors, action.connectors, state.sshTargets),
      };
    case "skillsLoaded":
      return { ...state, userSkills: action.userSkills };
    case "isAdminResolved":
      return state.mode === "bold" && !state.runtimeTouched
        ? { ...state, sandboxKind: defaultRuntimeForMode("bold", action.isAdmin, state.executors, state.connectors, state.sshTargets) }
        : state;
    case "setTitle":
      return { ...state, title: action.value };
    case "setModelKey":
      return { ...state, modelKey: action.value };
    case "setSandboxMode":
      return { ...state, sandboxMode: action.value };
    case "setMode":
      return {
        ...state,
        mode: action.value,
        modelKey: preferredModelKey(state.models, state.modelKey),
        sandboxKind: defaultRuntimeForMode(action.value, action.isAdmin, state.executors, state.connectors, state.sshTargets),
        runtimeTouched: false,
      };
    case "setSandboxKind":
      return { ...state, sandboxKind: action.value, runtimeTouched: true };
    case "setConnectorId":
      return { ...state, connectorId: action.value };
    case "setSshTargetId":
      return { ...state, sshTargetId: action.value };
    case "setApprovalPolicy":
      return { ...state, approvalPolicy: action.value };
    case "submitStart":
      return { ...state, busy: true, error: "" };
    case "submitError":
      return { ...state, error: action.value };
    case "submitDone":
      return { ...state, busy: false };
    default:
      return state;
  }
}

export function NewSession({
  onCreated,
  onClose,
  initialMode,
  initialSkill,
  isAdmin = false,
  onNavigateToConnectors,
}: {
  onCreated: (s: SessionInfo) => void;
  onClose: () => void;
  initialMode?: SessionMode;
  initialSkill?: SkillSummary;
  isAdmin?: boolean;
  onNavigateToConnectors?: () => void;
}) {
  const t = useT();
  const [state, dispatch] = useReducer(newSessionReducer, undefined, () => ({
    models: [],
    executors: INITIAL_EXECUTORS,
    sshTargets: [],
    connectors: [],
    userSkills: initialSkill ? [initialSkill] : [],
    title: "",
    modelKey: "mock::mock-coder",
    sandboxMode: "danger-full-access" as SandboxMode,
    mode: initialMode ?? "coding",
    sandboxKind: "connector" as SandboxKind,
    connectorId: "",
    sshTargetId: "",
    approvalPolicy: "never" as ApprovalPolicy,
    runtimeTouched: false,
    busy: false,
    error: "",
  }));
  const {
    models,
    executors,
    sshTargets,
    connectors,
    userSkills,
    title,
    modelKey,
    sandboxMode,
    mode,
    sandboxKind,
    connectorId,
    sshTargetId,
    approvalPolicy,
    busy,
    error,
  } = state;
  const [open, setOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.models().then((r) => {
      dispatch({ type: "modelsLoaded", models: r.models, executors: modelExecutorAvailability(r), isAdmin });
    });
    api.sshTargets().then((r) => dispatch({ type: "sshLoaded", sshTargets: r.enabled ? r.targets : [], isAdmin })).catch(() => {});
    api.connectors().then((r) => {
      const online = r.connectors.filter((connector) => connector.online);
      dispatch({ type: "connectorsLoaded", connectors: online, isAdmin });
    }).catch(() => {});
    api.skills().then((r) => {
      dispatch({ type: "skillsLoaded", userSkills: r.skills });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    dispatch({ type: "isAdminResolved", isAdmin });
  }, [isAdmin]);

  useEffect(() => {
    const timerRef = closeTimerRef;
    return () => {
      const timer = timerRef.current;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  function closeWithAnimation(callback?: () => void) {
    if (!open) return;
    setOpen(false);
    closeTimerRef.current = window.setTimeout(() => {
      callback?.();
      onClose();
    }, MODAL_EXIT_DURATION_MS);
  }

  async function create() {
    dispatch({ type: "submitStart" });
    try {
      const [provider, model] = modelKey.split("::");
      const res = await api.createSession({
        title: title || t("session.untitled"),
        provider,
        model,
        sandboxMode,
        sandboxKind,
        sandboxTargetId:
          sandboxKind === "connector"
            ? connectorId || connectors[0]?.id || null
            : sandboxKind === "ssh"
              ? sshTargetId || sshTargets[0]?.id || null
              : null,
        mode,
        approvalPolicy,
      });
      onCreated(res.session);
      closeWithAnimation();
    } catch (e) {
      dispatch({ type: "submitError", value: e instanceof Error ? e.message : "failed" });
    } finally {
      dispatch({ type: "submitDone" });
    }
  }

  const sshAvailable = sshTargets.length > 0;
  const boldGuard = boldRequiresConnector(mode, isAdmin);
  const boldNeedsSetup = boldGuard && connectors.length === 0;
  const selectedConnectorAvailable = connectors.some(
    (connector) => connector.id === (connectorId || connectors[0]?.id),
  );
  const selectedSshAvailable = sshTargets.some(
    (target) => target.id === (sshTargetId || sshTargets[0]?.id),
  );
  const runtimeAvailable =
    sandboxKind === "e2b"
      ? executors.e2b.available
      : sandboxKind === "local"
        ? executors.local.available
        : sandboxKind === "ssh"
          ? selectedSshAvailable
          : selectedConnectorAvailable;
  const noExecutorAvailable =
    !executors.e2b.available &&
    !executors.local.available &&
    !sshAvailable &&
    connectors.length === 0;
  const e2bCapacityUnavailable = executors.e2b.reason === "capacity_unavailable";
  const showExecutorGuidance = !boldNeedsSetup && noExecutorAvailable;
  const createDisabled = busy || boldNeedsSetup || !runtimeAvailable;
  const optionsLoaded = models.length > 0;
  const configBlocked = optionsLoaded && (boldNeedsSetup || !runtimeAvailable);
  const selectedModel = models.find((model) => `${model.provider}::${model.id}` === modelKey);
  const builtinModeOptions: ModeOption[] = BUILTIN_PERSONAS.map((persona) => ({
    value: persona.id,
    icon: persona.modeIcon,
    label: t(persona.modeLabelKey),
    description: t(persona.modeDescKey),
  }));
  // User personas render from raw skill data (never via t(), whose dynamic keys resolve blank).
  const userModeOptions: ModeOption[] = userSkills.map((skill) => ({
    value: skill.id,
    icon: userIcon(skill.icon),
    label: skill.name,
    description: skill.description,
  }));
  const modeOptions: ModeOption[] = [...builtinModeOptions, ...userModeOptions];
  const renderModeCard = (option: ModeOption) => {
    const Icon = option.icon;
    return (
      <SessionModeCard
        key={option.value}
        value={option.value}
        icon={<Icon className="size-4" />}
        label={option.label}
        description={option.description}
        active={mode === option.value}
        onSelect={() => dispatch({ type: "setMode", value: option.value, isAdmin })}
      />
    );
  };
  const sandboxSummary =
    sandboxMode === "read-only" ? t("ns.sumReadOnly")
    : sandboxMode === "danger-full-access" ? t("ns.sumFullAccess")
    : t("ns.sumWorkspace");
  const approvalSummary =
    approvalPolicy === "never" ? t("ns.sumNeverAsk")
    : approvalPolicy === "untrusted" ? t("ns.sumAskAll")
    : t("ns.sumAskCommands");
  const selectedModeLabel = modeOptions.find((option) => option.value === mode)?.label ?? t("ns.modeCoding");
  const runtimeLabel =
    noExecutorAvailable
      ? t("ns.runtimeUnavailable")
      : sandboxKind === "e2b"
      ? t("ns.runtimeE2b")
      : sandboxKind === "ssh"
        ? sshTargets.find((target) => target.id === sshTargetId)?.label || t("ns.runtimeSsh")
        : sandboxKind === "connector"
          ? connectors.find((connector) => connector.id === connectorId)?.name || t("ns.runtimeConnector")
          : t("ns.runtimeLocal");

  return (
    <Modal open={open} onOpenChange={(nextOpen) => { if (!nextOpen) closeWithAnimation(); }}>
      <ModalContent
        className="!max-w-[780px] !rounded-[20px] !bg-[var(--app-surface)] sm:!max-h-[min(92vh,880px)] dark:!bg-[#1B1B19]"
        overlayClassName="!bg-[#E9ECE5]/94 !backdrop-blur-none dark:!bg-black/70"
        overlayTestId="new-session-overlay"
        data-testid="new-session-modal"
      >
        <ModalDismiss className="right-5 top-5 rounded-lg border border-transparent hover:border-[#DEE1DA] hover:bg-[#F1F3EE] dark:hover:border-[#3B3B36] dark:hover:bg-[#252521]" />
        <ModalHeader className="border-b border-[#E4E7DF] px-6 pb-4 pt-5 dark:border-[#34342F]">
          <div className="pr-10">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9A7954] dark:text-[#BE8A52]">
              {t("ns.kicker")}
            </div>
            <ModalTitle className="text-[20px] font-semibold leading-tight tracking-[-0.025em]">
              {t("ns.title")}
            </ModalTitle>
            <ModalDescription className="mt-1.5 max-w-[580px] text-[12.5px]">
              {t("ns.description")}
            </ModalDescription>
          </div>
        </ModalHeader>
        <ModalBody className="min-h-0 overflow-y-auto px-6 pb-6 pt-5">
          <div className="space-y-5">
            <SessionField label={t("ns.titleLabel")} htmlFor="ns-title-input">
              <input
                id="ns-title-input"
                data-testid="ns-title"
                value={title}
                onChange={(event) => dispatch({ type: "setTitle", value: event.target.value })}
                placeholder={t("ns.titlePlaceholder")}
                className={`${CONTROL_CLASS} h-11 text-[14px] font-medium placeholder:font-normal placeholder:text-[#AAA9A1] dark:placeholder:text-[#67665F]`}
                autoFocus
              />
            </SessionField>

            <fieldset className="relative" data-testid="ns-mode">
              <legend className="sr-only">{t("ns.modeLabel")}</legend>
              <div className="mb-2.5 flex items-end justify-between gap-4">
                <div>
                  <div className="text-[12.5px] font-semibold text-[#34332E] dark:text-[#E8E5DC]">{t("ns.modeSection")}</div>
                  <div className="mt-0.5 text-[11px] text-[#898880] dark:text-[#918F87]">{t("ns.modeSectionHint")}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" data-testid="ns-mode-cards">
                {builtinModeOptions.map((option) => renderModeCard(option))}
              </div>
              {userModeOptions.length > 0 && (
                <div className="mt-4" data-testid="ns-mode-custom">
                  <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9A7954] dark:text-[#BE8A52]">
                    {t("ns.modeCustomSection")}
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" data-testid="ns-mode-custom-cards">
                    {userModeOptions.map((option) => renderModeCard(option))}
                  </div>
                </div>
              )}
            </fieldset>

            {(mode === "pentest" || mode === "exploit") && executors.e2b.available && (
              <p data-testid="ns-mode-help" className="-mt-2 text-[11px] leading-[1.5] text-[#89877F] dark:text-[#949188]">{t("ns.pentestHelp")}</p>
            )}
            {mode === "bold" && !boldNeedsSetup && (
              <p data-testid="ns-mode-help" className="-mt-2 text-[11px] leading-[1.5] text-[#89877F] dark:text-[#949188]">{boldGuard ? t("ns.boldConnectorHelp") : t("ns.boldHelp")}</p>
            )}

            <details
              data-testid="ns-advanced"
              open={advancedOpen || configBlocked}
              onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}
              className="group/adv rounded-[12px] border border-[#E1E4DC] bg-[#FAFBF7] dark:border-[#33342F] dark:bg-[#1F201D]"
            >
              <summary
                data-testid="ns-advanced-toggle"
                className="flex cursor-pointer list-none items-center gap-2.5 rounded-[12px] px-3.5 py-3 outline-none transition-colors hover:bg-[#F2F4EE] focus-visible:shadow-[inset_0_0_0_2px_rgba(173,145,94,.4)] dark:hover:bg-[#26271F] [&::-webkit-details-marker]:hidden"
              >
                <ChevronRight className="size-3.5 shrink-0 text-[#7E8279] transition-transform duration-150 group-open/adv:rotate-90 dark:text-[#8D9088]" strokeWidth={1.8} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-semibold text-[#34332E] dark:text-[#E8E5DC]">{t("ns.advancedLabel")}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-[#898880] dark:text-[#918F87]" data-testid="ns-advanced-summary">
                    {sandboxSummary} · {approvalSummary}
                  </span>
                </span>
              </summary>

              <div className="grid gap-3 border-t border-[#E1E4DC] p-3.5 md:grid-cols-2 md:grid-rows-[auto_auto_auto] dark:border-[#33342F]">
              <SessionConfigSection alignRows icon={<Cpu className="size-3.5" />} title={t("ns.engineSection")} description={t("ns.engineSectionHint")}>
                <SessionField label={t("ns.modelLabel")}>
                  <select
                    data-testid="ns-model"
                    value={modelKey}
                    onChange={(event) => dispatch({ type: "setModelKey", value: event.target.value })}
                    className={CONTROL_CLASS}
                  >
                    {models.map((model) => (
                      <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>
                        {model.name} {model.mock ? "(no key needed)" : `· ${model.provider}`}
                      </option>
                    ))}
                  </select>
                </SessionField>
              </SessionConfigSection>

              <SessionConfigSection alignRows icon={<Cloud className="size-3.5" />} title={t("ns.runtimeSection")} description={t("ns.runtimeSectionHint")}>

                {!boldGuard && (executors.e2b.available || executors.local.available || sshAvailable || connectors.length > 0) && (
                  <SessionField label={t("ns.runtimeLabel")}>
                    <select
                      data-testid="ns-runtime"
                      value={sandboxKind}
                      onChange={(event) => dispatch({ type: "setSandboxKind", value: event.target.value as SandboxKind })}
                      className={CONTROL_CLASS}
                    >
                      {executors.e2b.available && <option value="e2b">{t("ns.runtimeE2b")}</option>}
                      {sshAvailable && <option value="ssh">{t("ns.runtimeSsh")}</option>}
                      {connectors.length > 0 && <option value="connector">{t("ns.runtimeConnector")}</option>}
                      {executors.local.available && <option value="local">{t("ns.runtimeLocal")}</option>}
                    </select>
                  </SessionField>
                )}

                {showExecutorGuidance && (
                  <div
                    className="rounded-[11px] border border-[#DECDB2] bg-[#F6F0E4] p-3 dark:border-[#5C513D] dark:bg-[#29271F]"
                    data-testid="ns-executor-guidance"
                  >
                    <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[#4B4234] dark:text-[#E2DAC9]">
                      <StatusDot tone="working" />
                      {t(e2bCapacityUnavailable ? "ns.executorCapacityTitle" : "ns.executorUnavailableTitle")}
                    </div>
                    <p className="mb-2.5 mt-1 text-[11.5px] leading-[1.5] text-[#817665] dark:text-[#A69D8C]">
                      {t("ns.executorUnavailableBody")}
                    </p>
                    <button
                      type="button"
                      className="secondary !min-h-8 !rounded-lg !px-3 !py-1 !text-[12px]"
                      data-testid="ns-executor-connector-cta"
                      onClick={() => closeWithAnimation(() => onNavigateToConnectors?.())}
                    >
                      {t("ns.executorConnectorCta")}
                    </button>
                  </div>
                )}

                {boldNeedsSetup && (
                  <div
                    className="rounded-[11px] border border-[#DECDB2] bg-[#F6F0E4] p-3 dark:border-[#5C513D] dark:bg-[#29271F]"
                    data-testid="ns-bold-connector-guidance"
                  >
                    <div className="text-[12.5px] font-semibold text-[#4B4234] dark:text-[#E2DAC9]">{t("ns.boldNeedsConnectorTitle")}</div>
                    <p className="mb-2.5 mt-1 text-[11.5px] leading-[1.45] text-[#817665] dark:text-[#A69D8C]">{t("ns.boldNeedsConnectorBody")}</p>
                    <button
                      type="button"
                      className="secondary !min-h-8 !rounded-lg !px-3 !py-1 !text-[12px]"
                      data-testid="ns-bold-connector-cta"
                      onClick={() => closeWithAnimation(() => onNavigateToConnectors?.())}
                    >
                      {t("ns.boldNeedsConnectorCta")}
                    </button>
                  </div>
                )}

                {connectors.length > 0 && (boldGuard || sandboxKind === "connector") && (
                  <SessionField label={t("ns.connectorTargetLabel")}>
                    <select
                      data-testid="ns-connector-target"
                      value={connectorId}
                      onChange={(event) => dispatch({ type: "setConnectorId", value: event.target.value })}
                      className={CONTROL_CLASS}
                    >
                      {connectors.map((connector) => (
                        <option key={connector.id} value={connector.id}>
                          {connector.name} — {connector.workspaceRoot}
                        </option>
                      ))}
                    </select>
                  </SessionField>
                )}

                {sshTargets.length > 0 && !boldGuard && sandboxKind === "ssh" && (
                  <SessionField label={t("ns.sshTargetLabel")}>
                    <select
                      data-testid="ns-ssh-target"
                      value={sshTargetId}
                      onChange={(event) => dispatch({ type: "setSshTargetId", value: event.target.value })}
                      className={CONTROL_CLASS}
                    >
                      {sshTargets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.label} — {target.username}@{target.host}
                        </option>
                      ))}
                    </select>
                  </SessionField>
                )}

              </SessionConfigSection>

              <SessionConfigSection
                icon={<Shield className="size-3.5" />}
                title={t("ns.guardrailsSection")}
                description={t("ns.guardrailsSectionHint")}
                className="md:col-span-2"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <SessionField label={t("ns.sandboxLabel")}>
                    <select
                      data-testid="ns-sandbox"
                      value={sandboxMode}
                      onChange={(event) => dispatch({ type: "setSandboxMode", value: event.target.value as SandboxMode })}
                      className={CONTROL_CLASS}
                    >
                      <option value="read-only">{t("ns.sandboxReadOnly")}</option>
                      <option value="workspace-write">{t("ns.sandboxWorkspaceWrite")}</option>
                      <option value="danger-full-access">{t("ns.sandboxDangerFull")}</option>
                    </select>
                  </SessionField>
                  <SessionField label={t("ns.approvalLabel")}>
                    <select
                      data-testid="ns-approval"
                      value={approvalPolicy}
                      onChange={(event) => dispatch({ type: "setApprovalPolicy", value: event.target.value as ApprovalPolicy })}
                      className={CONTROL_CLASS}
                    >
                      <option value="never">{t("ns.approvalNever")}</option>
                      <option value="on-request">{t("ns.approvalOnRequest")}</option>
                      <option value="untrusted">{t("ns.approvalUntrusted")}</option>
                    </select>
                  </SessionField>
                </div>
              </SessionConfigSection>
              </div>
            </details>

            {error && (
              <div className="rounded-[10px] border border-[#E4B7B1] bg-[#FFF7F5] px-3 py-2 text-[12px] text-[#A63D32] dark:border-[#653C38] dark:bg-[#2B201F] dark:text-[#E79A90]">
                {error}
              </div>
            )}
          </div>
        </ModalBody>
        <ModalFooter className="dialog-actions !flex-row !items-center !justify-between !gap-3 border-[#E2E5DD] bg-[#F4F6F1] px-6 py-3.5 dark:border-[#34342F] dark:bg-[#20201D]">
          <div className="hidden min-w-0 items-center gap-2.5 sm:flex">
            <StatusDot tone={createDisabled ? "working" : "live"} pulse={createDisabled} />
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8D8C84] dark:text-[#85837B]">{t("ns.readyLabel")}</div>
              <div className="mt-0.5 max-w-[370px] truncate text-[11.5px] text-[#5C5B54] dark:text-[#B7B3A9]">
                {selectedModeLabel} · {selectedModel?.name ?? t("ns.modelLabel")} · {runtimeLabel}
              </div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            <ModalClose asChild>
              <button className="secondary !min-h-9 !rounded-[9px] !px-3.5 !py-1.5 !text-[12.5px]" type="button">{t("ns.cancel")}</button>
            </ModalClose>
            <button
              className="primary inline-flex !min-h-9 items-center gap-2 !rounded-[9px] !px-4 !py-1.5 !text-[12.5px]"
              data-testid="ns-create"
              onClick={create}
              disabled={createDisabled}
              title={
                boldNeedsSetup
                  ? t("ns.boldNeedsConnectorDisabled")
                  : !runtimeAvailable
                    ? t("ns.executorRequiredDisabled")
                    : undefined
              }
              type="button"
            >

              <span className="grid text-center">
                <span className="invisible col-start-1 row-start-1" aria-hidden="true">{t("ns.creating")}</span>
                <span className="invisible col-start-1 row-start-1" aria-hidden="true">{t("ns.create")}</span>
                <span className="col-start-1 row-start-1">{busy ? t("ns.creating") : t("ns.create")}</span>
              </span>
              <ArrowRight className={`size-3.5 ${busy ? "invisible" : ""}`} />
            </button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
