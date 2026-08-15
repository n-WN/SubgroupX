import { useEffect, useReducer, useRef, useState } from "react";
import {
  Blocks,
  ArrowRight,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import { Spinner } from "../../../ui/Spinner";
import { api } from "../../../platform/api.ts";
import { SKILL_ICON_KEYS, type SessionMode, type SkillSummary, type SkillDetail, type SkillIconKey } from "@shared/protocol";
import { useT } from "../../../i18n";
import { fieldClass, labelClass, primaryButtonClass, quietButtonClass, iconButtonClass } from "../../ui/controlStyles.ts";
import { ViewHeader } from "../../ui/ViewHeader.tsx";
import { userIcon, normalizeIconKey } from "./skill-icons.ts";
import { BUILTIN_PERSONAS, type BuiltinPersona } from "./builtins.ts";

type FormState = {
  name: string;
  description: string;
  prompt: string;
  icon: SkillIconKey;
  busy: boolean;
  error: string;
};

type FormAction =
  | { type: "patch"; patch: Partial<Pick<FormState, "name" | "description" | "prompt" | "icon">> }
  | { type: "submitStart" }
  | { type: "submitError"; message: string };

function initForm(initial: SkillDetail | null): FormState {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    prompt: initial?.prompt ?? "",
    icon: initial ? normalizeIconKey(initial.icon) : "sparkles",
    busy: false,
    error: "",
  };
}

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "patch":
      return { ...state, ...action.patch };
    case "submitStart":
      return { ...state, busy: true, error: "" };
    case "submitError":
      return { ...state, busy: false, error: action.message };
  }
}

function SkillForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: SkillDetail | null;
  onSaved: (skill: SkillDetail) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [form, dispatch] = useReducer(formReducer, initial, initForm);
  const { name, description, prompt, icon, busy, error } = form;
  const PreviewIcon = userIcon(icon);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    dispatch({ type: "submitStart" });
    const body = {
      name: name.trim(),
      description: description.trim(),
      icon,
      prompt: prompt.trim(),
    };
    try {
      const res = initial ? await api.updateSkill(initial.id, body) : await api.createSkill(body);
      onSaved(res.skill);
    } catch (err) {
      dispatch({ type: "submitError", message: err instanceof Error ? err.message : t("skills.error") });
    }
  }

  const canSubmit = name.trim().length > 0 && prompt.trim().length > 0 && !busy;

  return (
    <form
      data-testid="skill-form"
      onSubmit={submit}
      className="mt-4 border-y border-[#DDE1D8] bg-[var(--app-surface)] px-5 py-5 dark:border-[#383B37] dark:bg-[#1A1A1A] md:px-7"
    >
      <h3 className="mb-4 text-[13px] font-semibold text-[#3A3D36] dark:text-[#DADCD5]">
        {t(initial ? "skills.editTitle" : "skills.new")}
      </h3>

      <div className="mb-4 flex flex-col gap-1.5">
        <label htmlFor="skill-name-input" className={labelClass}>{t("skills.nameField")}</label>
        <input
          id="skill-name-input"
          data-testid="skill-name"
          className={fieldClass}
          value={name}
          onChange={(e) => dispatch({ type: "patch", patch: { name: e.target.value } })}
          placeholder={t("skills.namePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="mb-4 flex flex-col gap-1.5">
        <label htmlFor="skill-description-input" className={labelClass}>{t("skills.descField")}</label>
        <input
          id="skill-description-input"
          data-testid="skill-description"
          className={fieldClass}
          value={description}
          onChange={(e) => dispatch({ type: "patch", patch: { description: e.target.value } })}
          placeholder={t("skills.descPlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="mb-4 flex flex-col gap-1.5">
        <label htmlFor="skill-prompt-input" className={labelClass}>{t("skills.promptField")}</label>
        <textarea
          id="skill-prompt-input"
          data-testid="skill-prompt"
          className={`${fieldClass} min-h-[120px] resize-y`}
          value={prompt}
          onChange={(e) => dispatch({ type: "patch", patch: { prompt: e.target.value } })}
          placeholder={t("skills.promptPlaceholder")}
        />
      </div>

      <div className="mb-4 flex flex-col gap-1.5">
        <label htmlFor="skill-icon-input" className={labelClass}>{t("skills.iconField")}</label>
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[4px] border border-[#D9DDD4] text-[#676B61] dark:border-[#3A3C37] dark:text-[#A9ACA2]">
            <PreviewIcon className="size-[18px]" strokeWidth={1.6} />
          </span>
          <select
            id="skill-icon-input"
            data-testid="skill-icon"
            className={`${fieldClass} font-mono`}
            value={icon}
            onChange={(e) => dispatch({ type: "patch", patch: { icon: e.target.value as SkillIconKey } })}
          >
            {SKILL_ICON_KEYS.map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div data-testid="skill-form-error" className="mb-4 text-[11.5px] leading-4 text-[#B74335] dark:text-[#E28A7D]">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={quietButtonClass}>
          {t("common.cancel")}
        </button>
        <button data-testid="skill-form-submit" type="submit" disabled={!canSubmit} className={primaryButtonClass}>
          {busy && <Spinner className="size-[13px]" strokeWidth={2.4} />}
          {busy ? t("skills.saving") : t(initial ? "skills.saveEdit" : "skills.save")}
        </button>
      </div>
    </form>
  );
}

function CapsRow({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-[#7E8279] dark:text-[#8D9088]">
      {labels.map((label, index) => (
        <span key={`${label}-${index}`} className="flex items-center gap-x-2">
          {index > 0 && (
            <span aria-hidden="true" className="size-[2px] rounded-full bg-[#C3C7BD] dark:bg-[#4A4C46]" />
          )}
          {label}
        </span>
      ))}
    </span>
  );
}

function BuiltinCard({ persona, onLaunch }: { persona: BuiltinPersona; onLaunch: (mode: SessionMode) => void }) {
  const t = useT();
  const Icon = persona.skillIcon;
  return (
    <button
      type="button"
      data-testid={`skill-${persona.id}`}
      onClick={() => onLaunch(persona.id)}
      aria-labelledby={`skill-name-${persona.id} skill-action-${persona.id}`}
      aria-describedby={`skill-desc-${persona.id}`}
      className="group flex min-h-[88px] w-full items-center border-b border-[#DDE1D8] px-1 py-4 text-left outline-none transition-colors duration-150 hover:bg-[#F3F4EF] active:bg-[#ECEEE8] focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_2px_rgba(173,145,94,.5)] dark:border-[#393B35] dark:hover:bg-[#292A26] dark:active:bg-[#2E302B]"
    >
      <span className="flex size-9 shrink-0 items-center justify-center text-[#676B61] dark:text-[#A9ACA2]">
        <Icon className="size-[18px]" strokeWidth={1.6} />
      </span>

      <span className="min-w-0 flex-1 px-2.5">
        <span id={`skill-name-${persona.id}`} className="block text-[13.5px] font-semibold text-[#353730] dark:text-[#E0E1DB]">{t(persona.nameKey)}</span>
        <span id={`skill-desc-${persona.id}`} className="mt-1 block max-w-[560px] text-[11.5px] leading-[1.55] text-[#686C63] dark:text-[#A0A39B]">
          {t(persona.descKey)}
        </span>

        <CapsRow labels={persona.caps.map((cap) => t(cap))} />
      </span>

      <span
        id={`skill-action-${persona.id}`}
        data-testid={`skill-launch-${persona.id}`}
        className="mr-2 flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-[#70746B] dark:text-[#A0A39B]"
      >
        <span className="sr-only sm:not-sr-only">{t("skills.start")}</span>
        <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" strokeWidth={1.7} />
      </span>
    </button>
  );
}

function UserCard({
  skill,
  deleting,
  onLaunch,
  onEdit,
  onDelete,
}: {
  skill: SkillSummary;
  deleting: boolean;
  onLaunch: (mode: SessionMode, skill?: SkillSummary) => void;
  onEdit: (skill: SkillSummary) => void;
  onDelete: (skill: SkillSummary) => void;
}) {
  const t = useT();
  const Icon = userIcon(skill.icon);
  return (
    <div
      data-testid={`skill-${skill.id}`}
      className="flex items-stretch border-b border-[#DDE1D8] dark:border-[#393B35]"
    >
      <button
        type="button"
        data-testid={`skill-launch-${skill.id}`}
        onClick={() => onLaunch(skill.id, skill)}
        className="group flex min-h-[88px] flex-1 items-center px-1 py-4 text-left outline-none transition-colors duration-150 hover:bg-[#F3F4EF] active:bg-[#ECEEE8] focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_2px_rgba(173,145,94,.5)] dark:hover:bg-[#292A26] dark:active:bg-[#2E302B]"
      >
        <span className="flex size-9 shrink-0 items-center justify-center text-[#676B61] dark:text-[#A9ACA2]">
          <Icon className="size-[18px]" strokeWidth={1.6} />
        </span>

        <span className="min-w-0 flex-1 px-2.5">
          <span className="block text-[13.5px] font-semibold text-[#353730] dark:text-[#E0E1DB]">{skill.name}</span>
          {skill.description && (
            <span className="mt-1 block max-w-[560px] text-[11.5px] leading-[1.55] text-[#686C63] dark:text-[#A0A39B]">
              {skill.description}
            </span>
          )}
        </span>

        <span className="mr-2 flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-[#70746B] dark:text-[#A0A39B]">
          <span className="sr-only sm:not-sr-only">{t("skills.start")}</span>
          <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" strokeWidth={1.7} />
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1 pl-1 pr-1">
        <button
          type="button"
          data-testid={`skill-edit-${skill.id}`}
          onClick={() => onEdit(skill)}
          aria-label={t("skills.editAction")}
          title={t("skills.editAction")}
          className={iconButtonClass}
        >
          <Pencil className="size-[15px]" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          data-testid={`skill-delete-${skill.id}`}
          onClick={() => onDelete(skill)}
          disabled={deleting}
          aria-label={t("skills.deleteAction")}
          title={t("skills.deleteAction")}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[4px] text-[#8A6F69] outline-none transition-[background-color,color,box-shadow] duration-150 hover:bg-[#F4E8E5] hover:text-[#B74335] focus-visible:shadow-[0_0_0_2px_rgba(183,67,53,.2)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[#8A6F69] dark:text-[#A08A85] dark:hover:bg-[#332421] dark:hover:text-[#E28A7D] dark:disabled:hover:bg-transparent dark:disabled:hover:text-[#A08A85]"
        >
          <Trash2 className="size-[15px]" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

export function SkillsView({
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  onLaunch,
}: {
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
  onLaunch: (mode: SessionMode, skill?: SkillSummary) => void;
}) {
  const t = useT();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SkillDetail | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState(false);
  const editReq = useRef(0);

  async function load() {
    const res = await api.skills();
    setSkills(res.skills);
    setLoaded(true);
  }

  useEffect(() => {
    void load().catch(() => {
      setLoadError(true);
      setLoaded(true);
    });
  }, []);

  function openCreate() {
    editReq.current++;
    setEditing(null);
    setFormOpen(true);
  }

  async function openEdit(skill: SkillSummary) {
    const req = ++editReq.current;
    setLoadError(false);
    try {
      const res = await api.skill(skill.id);
      if (req !== editReq.current) return;
      setEditing(res.skill);
      setFormOpen(true);
    } catch {
      if (req === editReq.current) setLoadError(true);
    }
  }

  function closeForm() {
    editReq.current++;
    setFormOpen(false);
    setEditing(null);
  }

  function handleSaved(saved: SkillDetail) {
    const summary: SkillSummary = {
      id: saved.id,
      name: saved.name,
      description: saved.description,
      icon: saved.icon,
      createdAt: saved.createdAt,
    };
    setSkills((cur) =>
      cur.some((s) => s.id === summary.id) ? cur.map((s) => (s.id === summary.id ? summary : s)) : [summary, ...cur],
    );
    closeForm();
  }

  async function remove(skill: SkillSummary) {
    if (deletingId) return;
    if (!confirm(t("skills.deleteConfirm"))) return;
    editReq.current++; // invalidate an in-flight openEdit so it cannot reopen the deleted skill
    setDeletingId(skill.id);
    setDeleteError(false);
    try {
      await api.deleteSkill(skill.id);
      setSkills((cur) => cur.filter((s) => s.id !== skill.id));
      if (editing?.id === skill.id) closeForm();
    } catch {
      setDeleteError(true);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div
      data-testid="skills-view"
      className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--app-surface)] dark:bg-[#1A1A1A]"
    >
      <ViewHeader
        icon={Blocks}
        title={t("skills.title")}
        subtitle={t("skills.headerSubtitle")}
        isLeftSidebarOpen={isLeftSidebarOpen}
        onOpenLeftSidebar={onOpenLeftSidebar}
      />

      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--app-surface)] px-5 py-6 hide-scrollbar dark:bg-[#1D1E1B] md:px-8 md:py-8">
        <div className="mx-auto max-w-[760px]">
          <h2 className="text-[20px] font-semibold tracking-[-0.025em] text-[#30322D] dark:text-[#E3E4DE]">
            {t("skills.heading")}
          </h2>
          <p className="mt-1.5 max-w-[640px] text-[12px] leading-[1.6] text-[#656960] dark:text-[#A0A39B]">
            {t("skills.subtitle")}
          </p>

          <div className="mt-6 border-t border-[#DDE1D8] dark:border-[#393B35]">
            {BUILTIN_PERSONAS.map((persona) => (
              <BuiltinCard key={persona.id} persona={persona} onLaunch={onLaunch} />
            ))}
          </div>

          <div className="mt-8 flex items-end justify-between gap-3">
            <div>
              <h3 className="text-[15px] font-semibold tracking-[-0.02em] text-[#30322D] dark:text-[#E3E4DE]">
                {t("skills.custom.heading")}
              </h3>
              <p className="mt-1 max-w-[560px] text-[12px] leading-[1.6] text-[#656960] dark:text-[#A0A39B]">
                {t("skills.custom.subtitle")}
              </p>
            </div>
            {!formOpen && (
              <button
                type="button"
                data-testid="skill-new"
                onClick={openCreate}
                className={`${quietButtonClass} shrink-0`}
              >
                <Plus className="size-[15px]" strokeWidth={2} />
                {t("skills.new")}
              </button>
            )}
          </div>

          {formOpen && (
            <SkillForm key={editing?.id ?? "new"} initial={editing} onSaved={handleSaved} onCancel={closeForm} />
          )}

          {(loadError || deleteError) && (
            <div
              data-testid="skills-error"
              className="mt-4 text-[11.5px] leading-4 text-[#B74335] dark:text-[#E28A7D]"
            >
              {t("skills.error")}
            </div>
          )}

          {!loaded ? null : skills.length === 0 ? (
            !formOpen && (
              <div className="mt-4 border-t border-[#DDE1D8] px-1 py-6 text-[12px] leading-[1.6] text-[#7E8279] dark:border-[#393B35] dark:text-[#8D9088]">
                {t("skills.custom.empty")}
              </div>
            )
          ) : (
            <div className="mt-4 border-t border-[#DDE1D8] dark:border-[#393B35]">
              {skills.map((skill) => (
                <UserCard
                  key={skill.id}
                  skill={skill}
                  deleting={deletingId === skill.id}
                  onLaunch={onLaunch}
                  onEdit={(s) => void openEdit(s)}
                  onDelete={(s) => void remove(s)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
