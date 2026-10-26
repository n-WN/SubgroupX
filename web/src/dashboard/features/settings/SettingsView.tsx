import { useEffect, useReducer, useState, type FormEvent } from 'react';
import { ViewHeader } from "../../ui/ViewHeader.tsx";
import { primaryButtonClass, quietButtonClass } from "../../ui/controlStyles.ts";
import { SlidersHorizontal, X } from 'lucide-react';
import { api } from '../../../platform/api.ts';
import { useI18n } from '../../../i18n';
import type { ProviderKeyInfo } from '@shared/protocol';
import type { ToolFoldMode } from '../../session/timeline/timeline-helpers';
import { OrcaRouterPanel } from './OrcaRouterPanel';

type EgressState = {
  jumpServer: string;
  proxyPool: string;
  saved: 'applied' | 'saved' | null;
  error: string;
};

type EgressAction =
  | { type: 'loaded'; jumpServer: string; proxyPool: string }
  | { type: 'jumpServerChanged'; value: string }
  | { type: 'proxyPoolChanged'; value: string }
  | { type: 'saveStarted' }
  | { type: 'saveSucceeded'; saved: 'applied' | 'saved' }
  | { type: 'saveFailed'; error: string }
  | { type: 'savedCleared' };

const initialEgress: EgressState = { jumpServer: '', proxyPool: '', saved: null, error: '' };

function egressReducer(state: EgressState, action: EgressAction): EgressState {
  switch (action.type) {
    case 'loaded':
      return { ...state, jumpServer: action.jumpServer, proxyPool: action.proxyPool };
    case 'jumpServerChanged':
      return { ...state, jumpServer: action.value };
    case 'proxyPoolChanged':
      return { ...state, proxyPool: action.value };
    case 'saveStarted':
      return { ...state, error: '' };
    case 'saveSucceeded':
      return { ...state, saved: action.saved };
    case 'saveFailed':
      return { ...state, error: action.error };
    case 'savedCleared':
      return { ...state, saved: null };
  }
}

function MemorySection() {
  const { t, locale } = useI18n();
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState('');
  const [notes, setNotes] = useState('');
  const [dreamedAt, setDreamedAt] = useState<number | null>(null);
  const [flash, setFlash] = useState<'saved' | 'cleared' | null>(null);

  useEffect(() => {
    void api.memory()
      .then((m) => {
        setEnabled(m.enabled);
        setState(m.state);
        setNotes(m.userNotes);
        setDreamedAt(m.lastDreamedAt);
      })
      .catch(() => {});
  }, []);

  const flashThen = (kind: 'saved' | 'cleared') => {
    setFlash(kind);
    window.setTimeout(() => setFlash(null), 2000);
  };

  return (
    <section className="space-y-4" data-testid="memory-settings">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('settings.memory')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          data-testid="memory-toggle"
          onClick={() => {
            const next = !enabled;
            setEnabled(next);
            void api.setMemory({ enabled: next }).catch(() => setEnabled(!next));
          }}
          className={`relative inline-flex h-[24px] w-[42px] shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-[#222] dark:bg-[#E0E0E0]' : 'bg-[#D2D2CC] dark:bg-[#3A3A3A]'}`}
        >
          <span className={`inline-block size-[18px] rounded-full bg-white dark:bg-[#1A1A1A] shadow-sm transition-transform ${enabled ? 'translate-x-[21px]' : 'translate-x-[3px]'}`} />
        </button>
      </div>
      <p className="-mt-2 text-[12.5px] text-[#999] dark:text-[#777]">{t('settings.memoryHelp')}</p>

      {enabled && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px] font-medium text-[#333] dark:text-[#D8D8D8]">{t('settings.memorySummary')}</span>
              {dreamedAt != null && (
                <span className="text-[11.5px] text-[#999] dark:text-[#777]">
                  {t('settings.memoryDreamedAt', { when: new Date(dreamedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') })}
                </span>
              )}
            </div>
            {state ? (
              <pre data-testid="memory-state" className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[#E5E5E0] bg-[#FAFAF7] px-3 py-2.5 font-sans text-[12.5px] leading-relaxed text-[#4A493F] dark:border-[#333] dark:bg-[#222] dark:text-[#C9C7BE]">{state}</pre>
            ) : (
              <p data-testid="memory-state-empty" className="text-[12.5px] text-[#999] dark:text-[#777]">{t('settings.memoryEmpty')}</p>
            )}
            {state && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="memory-clear"
                  onClick={() => {
                    if (!window.confirm(t('settings.memoryClearConfirm'))) return;
                    void api.clearMemoryState().then(() => {
                      setState('');
                      setDreamedAt(null);
                      flashThen('cleared');
                    }).catch(() => {});
                  }}
                  className="self-start rounded-md border border-[#D9D7CE] px-2.5 py-1 text-[12px] font-medium text-[#5F5D56] transition-colors hover:border-[#C9C5B8] hover:bg-[#F1EFE8] dark:border-[#44413A] dark:text-[#BBB6AA] dark:hover:bg-[#2D2B25]"
                >
                  {t('settings.memoryClear')}
                </button>
                {flash === 'cleared' && <span className="text-[12.5px] text-[#2E7D45] dark:text-[#6FBF87]">{t('settings.memoryCleared')}</span>}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="memory-notes" className="text-[13.5px] font-medium text-[#333] dark:text-[#D8D8D8]">{t('settings.memoryNotes')}</label>
            <span className="text-[12.5px] text-[#999] dark:text-[#777]">{t('settings.memoryNotesHelp')}</span>
            <textarea
              id="memory-notes"
              data-testid="memory-notes"
              value={notes}
              rows={3}
              maxLength={4000}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => void api.setMemory({ userNotes: notes }).then(() => flashThen('saved')).catch(() => {})}
              className="w-full resize-y rounded border border-transparent bg-[#EBEBEB] px-3 py-2.5 text-[13.5px] leading-relaxed text-[#333] outline-none transition-colors focus:border-[#BBB] dark:bg-[#2A2A2A] dark:text-[#E0E0E0] dark:focus:border-[#555]"
              placeholder={t('settings.memoryNotesPlaceholder')}
            />
            {flash === 'saved' && <span className="text-[12.5px] text-[#2E7D45] dark:text-[#6FBF87]">{t('settings.memorySaved')}</span>}
          </div>
        </>
      )}
    </section>
  );
}

export function SettingsView({
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  userEmail,
  hasPassword = true,
  connected,
  chatScale,
  onChatScaleChange,
  toolFold,
  onToolFoldChange,
  onProvidersChanged,
  onLogout,
  onDone,
}: {
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
  userEmail: string;
  hasPassword?: boolean;
  connected: boolean;
  chatScale: number;
  onChatScaleChange: (scale: number) => void;
  toolFold: ToolFoldMode;
  onToolFoldChange: (v: ToolFoldMode) => void;
  onProvidersChanged?: () => void;
  onLogout: () => void;
  onDone?: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [data, setData] = useState<{ providers: string[]; keys: ProviderKeyInfo[] }>({ providers: [], keys: [] });
  const { providers, keys } = data;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [localHasPassword, setLocalHasPassword] = useState(hasPassword);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSaved, setPwSaved] = useState(false);
  const [stepupToken, setStepupToken] = useState<string | null>(null);
  const [stepupError, setStepupError] = useState('');
  const [stepupBusy, setStepupBusy] = useState(false);
  useEffect(() => {
    try {
      const tok = sessionStorage.getItem('oiia.pwsetup');
      if (tok) { setStepupToken(tok); sessionStorage.removeItem('oiia.pwsetup'); }
      const err = sessionStorage.getItem('oiia.pwerror');
      if (err) { setStepupError(t('settings.stepupFailed')); sessionStorage.removeItem('oiia.pwerror'); }
    } catch {  }
  }, [t]);

  async function startStepup() {
    setStepupError('');
    setStepupBusy(true);
    try {
      const { url } = await api.stepupUrl();
      window.location.href = url;
    } catch (err) {
      setStepupError(err instanceof Error ? err.message : t('settings.stepupFailed'));
      setStepupBusy(false);
    }
  }
  const [egress, dispatchEgress] = useReducer(egressReducer, initialEgress);
  const { jumpServer, proxyPool, saved: egressSaved, error: egressError } = egress;

  async function load() {
    const res = await api.providers();
    setData({ providers: res.providers, keys: res.keys });
  }

  useEffect(() => {
    void load();
    void api.egress()
      .then((e) => dispatchEgress({ type: 'loaded', jumpServer: e.jumpServer, proxyPool: e.proxyUrl }))
      .catch(() => {});
  }, []);

  async function saveEgress() {
    dispatchEgress({ type: 'saveStarted' });
    try {
      const res = await api.setEgress(proxyPool.trim(), jumpServer.trim());
      dispatchEgress({ type: 'saveSucceeded', saved: res.proxyApplies ? 'applied' : 'saved' });
      window.setTimeout(() => dispatchEgress({ type: 'savedCleared' }), 2000);
    } catch (e) {
      dispatchEgress({ type: 'saveFailed', error: e instanceof Error ? e.message : 'failed to save' });
    }
  }

  async function save(provider: string) {
    const key = drafts[provider];
    if (!key) return;
    setBusy(provider);
    try {
      await api.setKey(provider, key);
      setDrafts((current) => ({ ...current, [provider]: '' }));
      await load();
      onProvidersChanged?.();
    } finally {
      setBusy('');
    }
  }

  async function remove(provider: string) {
    setBusy(provider);
    try {
      await api.deleteKey(provider);
      await load();
      onProvidersChanged?.();
    } finally {
      setBusy('');
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setPwError('');
    setPwSaved(false);
    if (pw.next.length < 8) {
      setPwError(t('settings.pwTooShort'));
      return;
    }
    if (pw.next.length > 200) {
      setPwError(t('settings.pwTooLong'));
      return;
    }
    if (pw.next !== pw.confirm) {
      setPwError(t('settings.pwMismatch'));
      return;
    }
    setPwBusy(true);
    try {
      await api.changePassword(pw.current, pw.next, stepupToken ?? undefined);
      setPw({ current: '', next: '', confirm: '' });
      setStepupToken(null);
      setLocalHasPassword(true);
      setPwSaved(true);
      window.setTimeout(() => setPwSaved(false), 4000);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : t('settings.pwFailed'));
      if (!localHasPassword && stepupToken) {
        setStepupToken(null);
        setStepupError(t('settings.stepupFailed'));
      }
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div
      data-testid="settings-modal"
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-surface)] dark:bg-[#1A1A1A]"
    >
      <ViewHeader
        icon={SlidersHorizontal}
        title={t("settings.title")}
        subtitle={t("settings.headerSubtitle")}
        isLeftSidebarOpen={isLeftSidebarOpen}
        onOpenLeftSidebar={onOpenLeftSidebar}
        action={
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="settings-cancel"
              onClick={onDone}
              className={`${quietButtonClass} !min-h-8 !px-3 !text-[11.5px]`}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-testid="settings-done"
              onClick={onDone}
              className={`${primaryButtonClass} !min-h-8 !px-3 !text-[11.5px]`}
            >
              {t("settings.done")}
            </button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="max-w-[42rem] mx-auto w-full py-6 px-4 md:py-8 md:px-8 space-y-8 pb-24">
        <section>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('settings.language')}</span>
            <div className="flex gap-1 rounded-lg bg-[#EBEBEB] dark:bg-[#2A2A2A] p-0.5">
              {(['en', 'zh'] as const).map((lng) => (
                <button
                  key={lng}
                  type="button"
                  aria-pressed={locale === lng}
                  onClick={() => setLocale(lng)}
                  className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${locale === lng ? 'bg-white dark:bg-[#3A3A3A] text-[#111] dark:text-[#F0F0F0] shadow-sm' : 'text-[#666] dark:text-[#999] hover:text-[#222] dark:hover:text-[#DDD]'}`}
                >
                  {t(lng === 'en' ? 'lang.en' : 'lang.zh')}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('settings.chatFont')}</span>
            <div className="flex gap-1 rounded-lg bg-[#EBEBEB] dark:bg-[#2A2A2A] p-0.5">
              {([
                { value: 0.88, key: 'settings.fontCompact' as const },
                { value: 0.94, key: 'settings.fontDefault' as const },
                { value: 1.0, key: 'settings.fontLarge' as const },
              ]).map((opt) => {
                const active = Math.abs(chatScale - opt.value) < 0.001;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onChatScaleChange(opt.value)}
                    className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${active ? 'bg-white dark:bg-[#3A3A3A] text-[#111] dark:text-[#F0F0F0] shadow-sm' : 'text-[#666] dark:text-[#999] hover:text-[#222] dark:hover:text-[#DDD]'}`}
                  >
                    {t(opt.key)}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="mt-1.5 text-[12.5px] text-[#999] dark:text-[#777]">{t('settings.chatFontHelp')}</p>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('settings.toolFold')}</span>
            <div className="flex gap-1 rounded-lg bg-[#EBEBEB] dark:bg-[#2A2A2A] p-0.5">
              {([
                { value: 'off' as const, key: 'settings.toolFoldOff' as const },
                { value: 'quiet' as const, key: 'settings.toolFoldQuiet' as const },
                { value: 'all' as const, key: 'settings.toolFoldAll' as const },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={toolFold === opt.value}
                  data-testid={`tool-fold-${opt.value}`}
                  onClick={() => onToolFoldChange(opt.value)}
                  className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${toolFold === opt.value ? 'bg-white dark:bg-[#3A3A3A] text-[#111] dark:text-[#F0F0F0] shadow-sm' : 'text-[#666] dark:text-[#999] hover:text-[#222] dark:hover:text-[#DDD]'}`}
                >
                  {t(opt.key)}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1.5 text-[12.5px] text-[#999] dark:text-[#777]">{t('settings.toolFoldHelp')}</p>
        </section>

        <MemorySection />

        <section className="space-y-6">
          <div className="flex flex-col gap-2">
            <label htmlFor="jump-server" className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('settings.jumpServer')}</label>
            <span className="text-[13px] text-[#777] dark:text-[#999]">
              {t('settings.jumpServerHelp')}
            </span>
            <input
              id="jump-server"
              type="text"
              value={jumpServer}
              onChange={(e) => dispatchEgress({ type: 'jumpServerChanged', value: e.target.value })}
              onBlur={() => void saveEgress()}
              className="w-full bg-[#EBEBEB] dark:bg-[#2A2A2A] border border-transparent rounded pl-3 pr-3 py-2.5 text-[14px] text-[#333] dark:text-[#E0E0E0] outline-none focus:border-[#BBB] dark:focus:border-[#555] font-mono mt-1 transition-colors"
              placeholder={t('settings.jumpServerPlaceholder')}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="proxy-pool" className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('settings.proxyPool')}</label>
            <span className="text-[13px] text-[#777] dark:text-[#999]">
              {t('settings.proxyPoolHelp')}
            </span>
            <input
              id="proxy-pool"
              type="text"
              value={proxyPool}
              onChange={(e) => dispatchEgress({ type: 'proxyPoolChanged', value: e.target.value })}
              onBlur={() => void saveEgress()}
              className="w-full bg-[#EBEBEB] dark:bg-[#2A2A2A] border border-transparent rounded pl-3 pr-3 py-2.5 text-[14px] text-[#333] dark:text-[#E0E0E0] outline-none focus:border-[#BBB] dark:focus:border-[#555] font-mono mt-1 transition-colors"
              placeholder={t('settings.proxyPoolPlaceholder')}
            />
            {egressError ? (
              <span className="text-[12.5px] text-[#C0392B] dark:text-[#E07A6B]">{egressError}</span>
            ) : egressSaved ? (
              <span className="text-[12.5px] text-[#2E7D45] dark:text-[#6FBF87]">
                {egressSaved === 'applied' ? t('settings.egressApplied') : t('settings.egressSaved')}
              </span>
            ) : (
              <span className="text-[12.5px] text-[#999] dark:text-[#777]">
                {t('settings.proxyHint')}
              </span>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <div className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('settings.account')}</div>
            <div className="mt-1 text-[13px] text-[#777] dark:text-[#999] break-all">{userEmail}</div>
          </div>
          <form onSubmit={(e) => void submitPassword(e)} className="space-y-3" data-testid="change-password-form">
            <div className="text-[13.5px] font-medium text-[#333] dark:text-[#D8D8D8]">
              {localHasPassword ? t('settings.changePassword') : t('settings.setPassword')}
            </div>
            {!localHasPassword && (
              <p className="-mt-1 text-[12.5px] text-[#999] dark:text-[#777]">{t('settings.setPasswordHelp')}</p>
            )}

            {!localHasPassword && !stepupToken ? (
              <>
                {stepupError && <div className="text-[12.5px] text-[#B4453B] dark:text-[#E59A92]" data-testid="stepup-error">{stepupError}</div>}
                <button
                  type="button"
                  data-testid="stepup-start"
                  disabled={stepupBusy}
                  onClick={() => void startStepup()}
                  className="min-h-10 md:min-h-0 inline-flex items-center gap-2 bg-[#222] dark:bg-[#E8E8E8] text-white dark:text-[#1A1A1A] hover:opacity-90 text-[13px] px-4 py-2 rounded-md transition-opacity disabled:opacity-50"
                >
                  {t('settings.verifyGithub')}
                </button>
              </>
            ) : (
              <>

                <input type="text" name="username" autoComplete="username" value={userEmail} readOnly hidden aria-hidden="true" />
                {!localHasPassword && stepupToken && (
                  <div className="text-[12.5px] text-[#2E7D45] dark:text-[#7FCF9B]" data-testid="stepup-verified">{t('settings.githubVerified')}</div>
                )}
                {localHasPassword && (
                  <input
                    type="password"
                    autoComplete="current-password"
                    data-testid="pw-current"
                    value={pw.current}
                    onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))}
                    placeholder={t('settings.currentPassword')}
                    className="w-full bg-[#EBEBEB] dark:bg-[#2A2A2A] border border-transparent rounded-md pl-3 pr-3 py-2.5 text-[14px] text-[#333] dark:text-[#E0E0E0] outline-none focus:border-[#BBB] dark:focus:border-[#555] transition-colors"
                  />
                )}
                <input
                  type="password"
                  autoComplete="new-password"
                  data-testid="pw-new"
                  value={pw.next}
                  onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))}
                  placeholder={t('settings.newPassword')}
                  className="w-full bg-[#EBEBEB] dark:bg-[#2A2A2A] border border-transparent rounded-md pl-3 pr-3 py-2.5 text-[14px] text-[#333] dark:text-[#E0E0E0] outline-none focus:border-[#BBB] dark:focus:border-[#555] transition-colors"
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  data-testid="pw-confirm"
                  value={pw.confirm}
                  onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))}
                  placeholder={t('settings.confirmPassword')}
                  className="w-full bg-[#EBEBEB] dark:bg-[#2A2A2A] border border-transparent rounded-md pl-3 pr-3 py-2.5 text-[14px] text-[#333] dark:text-[#E0E0E0] outline-none focus:border-[#BBB] dark:focus:border-[#555] transition-colors"
                />
                {pwError && <div className="text-[12.5px] text-[#B4453B] dark:text-[#E59A92]" data-testid="pw-error">{pwError}</div>}
                {pwSaved && <div className="text-[12.5px] text-[#2E7D45] dark:text-[#7FCF9B]" data-testid="pw-saved">{t('settings.passwordChanged')}</div>}
                <button
                  type="submit"
                  disabled={pwBusy}
                  data-testid="pw-submit"
                  className="min-h-10 md:min-h-0 bg-[#E0E0E0] dark:bg-[#333] hover:bg-[#D0D0D0] dark:hover:bg-[#444] text-[13px] text-[#333] dark:text-[#E0E0E0] px-4 py-2 rounded-md transition-colors disabled:opacity-50"
                >
                  {localHasPassword ? t('settings.changePassword') : t('settings.setPassword')}
                </button>
              </>
            )}
          </form>
        </section>

        <section className="space-y-5 pt-2">
          <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('settings.providerKeys')}</div>
              <div className="mt-1 text-[13px] text-[#777] dark:text-[#999]">
                {connected ? t('settings.providerKeysConnected') : t('settings.providerKeysOffline')}
              </div>
            </div>
            <button type="button"
              onClick={onLogout}
              className="inline-flex min-h-10 md:min-h-0 items-center whitespace-nowrap bg-[#E0E0E0] dark:bg-[#333] hover:bg-[#D0D0D0] dark:hover:bg-[#444] text-[#333] dark:text-[#E0E0E0] px-4 py-2 rounded font-medium text-[13px] transition-colors"
            >
              {t('settings.logout')}
            </button>
          </div>

          <div className="text-[13px] text-[#888] dark:text-[#888] break-all">{userEmail}</div>

          <div className="space-y-3">
            {providers.filter((provider) => provider !== 'orcarouter').map((provider) => {
              const existing = keys.find((key) => key.provider === provider);
              return (
                <div
                  key={provider}
                  className="key-row grid grid-cols-1 gap-2 md:grid-cols-[104px_minmax(0,1fr)_auto] md:items-center md:gap-3"
                >

                  <label htmlFor={`provider-key-${provider}`} className="font-mono text-[13px] font-medium text-[#333] dark:text-[#E0E0E0] break-all md:break-normal md:truncate">
                    {provider}
                  </label>

                  <div className="flex items-center gap-2 min-w-0">
                    <input
                      id={`provider-key-${provider}`}
                      type="password"
                      aria-label={t('settings.keyPlaceholder', { provider })}
                      placeholder={existing ? t('settings.keyUpdatePlaceholder', { provider }) : t('settings.keyPlaceholder', { provider })}
                      value={drafts[provider] ?? ''}
                      onChange={(e) => setDrafts((current) => ({ ...current, [provider]: e.target.value }))}
                      autoComplete="off"
                      className="flex-1 min-w-0 bg-[#EBEBEB] dark:bg-[#2A2A2A] border border-transparent rounded-md pl-3 pr-3 py-2.5 text-[14px] text-[#333] dark:text-[#E0E0E0] outline-none focus:border-[#BBB] dark:focus:border-[#555] transition-colors"
                    />
                    {existing && (
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-[#E6E6E6] dark:bg-[#2E2E2E] pl-2 pr-1 py-[3px] font-mono text-[11.5px] text-[#888] dark:text-[#999]">
                        ····{existing.hint}
                        <button type="button"
                          onClick={() => void remove(provider)}
                          disabled={busy === provider}
                          aria-label={t('settings.remove')}
                          title={t('settings.remove')}
                          className="rounded-full p-0.5 text-[#999] hover:text-[#C0392B] dark:hover:text-[#E89B9B] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors disabled:opacity-50"
                        >
                          <X className="size-3" strokeWidth={2.5} />
                        </button>
                      </span>
                    )}
                  </div>

                  <button type="button"
                    onClick={() => void save(provider)}
                    disabled={busy === provider}
                    className="justify-self-stretch md:justify-self-end min-h-10 md:min-h-0 bg-[#E0E0E0] dark:bg-[#333] hover:bg-[#D0D0D0] dark:hover:bg-[#444] text-[13px] font-medium text-[#333] dark:text-[#E0E0E0] px-4 py-2 rounded-md transition-colors disabled:opacity-50"
                  >
                    {t('settings.save')}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <OrcaRouterPanel onChanged={() => { void load(); onProvidersChanged?.(); }} />

      </div>
      </div>
    </div>
  );
}
