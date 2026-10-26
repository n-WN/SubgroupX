import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../../../platform/api.ts';
import type { OrcaProviderInfo } from '../../../platform/api.ts';
import { useT } from '../../../i18n';

/**
 * OrcaRouter Cyber Inference settings.
 *
 * Two explicit authentication choices share one credential seam: paste an existing
 * `sk-orca-…` key, or authorize with an OrcaRouter account (OAuth 2.0 + PKCE, code
 * paste-back). Both end at the same server-side store, so the provider and the model
 * catalog never learn which one was used.
 */
export function OrcaRouterPanel({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<OrcaProviderInfo | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState<'' | 'key' | 'login' | 'clear'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState('');
  const [code, setCode] = useState('');
  const generation = useRef(0);
  const attemptRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.orcaProvider();
      setInfo(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('orca.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const releaseLogin = useCallback((cancelServer: boolean) => {
    const pending = attemptRef.current;
    attemptRef.current = null;
    setAttemptId(null);
    setAuthUrl('');
    setCode('');
    setBusy((current) => (current === 'login' ? '' : current));
    if (pending && cancelServer) api.orcaLoginCancelKeepalive(pending);
  }, []);

  // pagehide: clear local state synchronously, then tell the server with keepalive.
  useEffect(() => {
    const onHide = () => releaseLogin(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (attemptRef.current) api.orcaLoginCancelKeepalive(attemptRef.current);
    };
  }, [releaseLogin]);

  async function saveKey() {
    const key = keyDraft.trim();
    if (!key) return;
    setError('');
    setNotice('');
    setBusy('key');
    generation.current++;
    try {
      const saved = await api.orcaSaveKey(key);
      setKeyDraft('');
      setInfo((current) => current ? {
        ...current,
        credential: { configured: true, hint: saved.hint, source: 'api_key', needsReauth: false, generation: saved.generation },
      } : current);
      setNotice(t('orca.keySaved'));
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('orca.keySaveFailed'));
    } finally {
      setBusy('');
    }
  }

  async function removeKey() {
    setError('');
    setNotice('');
    setBusy('clear');
    generation.current++;
    try {
      await api.orcaClearKey();
      setInfo((current) => current ? {
        ...current,
        credential: { configured: false, hint: null, source: null, needsReauth: false, generation: 0 },
      } : current);
      setNotice(t('orca.keyCleared'));
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('orca.keyClearFailed'));
    } finally {
      setBusy('');
    }
  }

  async function startLogin() {
    setError('');
    setNotice('');
    setBusy('login');
    generation.current++;
    try {
      const started = await api.orcaLoginStart();
      attemptRef.current = started.attemptId;
      setAttemptId(started.attemptId);
      setAuthUrl(started.url);
      window.open(started.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('orca.loginStartFailed'));
      setBusy('');
    }
  }

  async function completeLogin() {
    const pending = attemptRef.current;
    if (!pending || !code.trim()) return;
    setError('');
    setNotice('');
    setBusy('login');
    const attemptGeneration = generation.current;
    try {
      const done = await api.orcaLoginComplete(pending, code.trim());
      if (attemptGeneration !== generation.current) return; // a newer action took over
      attemptRef.current = null;
      setAttemptId(null);
      setAuthUrl('');
      setCode('');
      setInfo((current) => current ? {
        ...current,
        credential: { configured: true, hint: done.hint, source: 'oauth_pkce', needsReauth: false, generation: done.generation },
      } : current);
      setNotice(t('orca.loginSucceeded'));
      onChanged?.();
    } catch (e) {
      if (attemptGeneration !== generation.current) return;
      setError(e instanceof Error ? e.message : t('orca.loginFailed'));
    } finally {
      if (attemptGeneration === generation.current) setBusy('');
    }
  }

  function cancelLogin() {
    releaseLogin(true);
    setError('');
    setNotice(t('orca.loginCanceled'));
  }

  const credential = info?.credential;
  const sourceLabel = credential?.source === 'oauth_pkce'
    ? t('orca.sourceAccount')
    : credential?.source === 'api_key'
      ? t('orca.sourceKey')
      : '';

  return (
    <section className="space-y-4 pt-2" data-testid="orca-panel">
      <div className="flex flex-col items-start gap-2">
        <div className="font-medium text-[14.5px] text-[#222] dark:text-[#E0E0E0]">{t('orca.title')}</div>
        <p className="text-[13px] leading-[1.55] text-[#777] dark:text-[#999]">{t('orca.intro')}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <a href={info?.providerUrl ?? 'https://www.orcarouter.ai/cyber'} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#8A5A2B] hover:underline dark:text-[#C79356]">
            {t('orca.providerPage')}<ExternalLink className="size-3" strokeWidth={2} />
          </a>
          <a href={info?.cyberCatalogUrl ?? 'https://www.orcarouter.ai/models?tier=cyber'} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#8A5A2B] hover:underline dark:text-[#C79356]">
            {t('orca.cyberCatalog')}<ExternalLink className="size-3" strokeWidth={2} />
          </a>
          <a href={info?.dashboardUrl ?? 'https://www.orcarouter.ai/console'} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#8A5A2B] hover:underline dark:text-[#C79356]">
            {t('orca.console')}<ExternalLink className="size-3" strokeWidth={2} />
          </a>
        </div>
        <p className="text-[12px] leading-[1.5] text-[#888] dark:text-[#888]" data-testid="orca-defaults">
          {t('orca.modelsHint')}
        </p>
      </div>

      {credential?.configured && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-[#F1F1EC] px-3 py-2 text-[12.5px] dark:bg-[#26261F]">
          <span className="font-medium text-[#333] dark:text-[#DDD]" data-testid="orca-credential-status">
            {t('orca.connected', { hint: credential.hint ?? '····', source: sourceLabel })}
          </span>
          {credential.needsReauth && (
            <span className="rounded-full bg-[#F6E3D8] px-2 py-[2px] text-[11.5px] font-medium text-[#9A4B22] dark:bg-[#4A2E22] dark:text-[#E8B591]" data-testid="orca-needs-reauth">
              {t('orca.needsReauth')}
            </span>
          )}
        </div>
      )}

      <div className="rounded-[10px] border border-[#E4E4DC] p-3 dark:border-[#34342F]" data-testid="orca-api-key-panel">
        <div className="mb-2 text-[13px] font-medium text-[#333] dark:text-[#E0E0E0]">{t('orca.apiKeyHeading')}</div>
        <div className="flex items-center gap-2">
          <input
            id="orca-api-key"
            data-testid="orca-api-key-input"
            type="password"
            autoComplete="off"
            aria-label={t('orca.apiKeyHeading')}
            placeholder={t('orca.apiKeyPlaceholder')}
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-[#EBEBEB] px-3 py-2.5 text-[14px] text-[#333] outline-none transition-colors focus:border-[#BBB] dark:bg-[#2A2A2A] dark:text-[#E0E0E0] dark:focus:border-[#555]"
          />
          <button type="button" data-testid="orca-api-key-save" onClick={() => void saveKey()} disabled={busy !== '' || !keyDraft.trim()}
            className="min-h-10 shrink-0 rounded-md bg-[#E0E0E0] px-4 py-2 text-[13px] font-medium text-[#333] transition-colors hover:bg-[#D0D0D0] disabled:opacity-50 dark:bg-[#333] dark:text-[#E0E0E0] dark:hover:bg-[#444]">
            {t('settings.save')}
          </button>
        </div>
      </div>

      <div className="rounded-[10px] border border-[#E4E4DC] p-3 dark:border-[#34342F]" data-testid="orca-pkce-panel">
        <div className="mb-2 text-[13px] font-medium text-[#333] dark:text-[#E0E0E0]">{t('orca.pkceHeading')}</div>
        {!attemptId ? (
          <button type="button" data-testid="orca-connect" onClick={() => void startLogin()} disabled={busy !== ''}
            className="min-h-10 rounded-md bg-[#222] px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-[#E0E0E0] dark:text-[#222]">
            {t('orca.connect')}
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-[12.5px] leading-[1.5] text-[#666] dark:text-[#AAA]">{t('orca.codeHelp')}</p>
            <div className="break-all rounded bg-[#F4F4EF] px-2 py-1.5 font-mono text-[11px] text-[#555] dark:bg-[#242420] dark:text-[#AAA]" data-testid="orca-auth-url">
              {authUrl}
            </div>
            <div className="flex items-center gap-2">
              <input
                data-testid="orca-code-input"
                type="text"
                autoComplete="off"
                aria-label={t('orca.codeLabel')}
                placeholder={t('orca.codePlaceholder')}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-[#EBEBEB] px-3 py-2.5 font-mono text-[13px] text-[#333] outline-none focus:border-[#BBB] dark:bg-[#2A2A2A] dark:text-[#E0E0E0] dark:focus:border-[#555]"
              />
              <button type="button" data-testid="orca-connect-complete" onClick={() => void completeLogin()} disabled={busy === 'login' && !code.trim()}
                className="min-h-10 shrink-0 rounded-md bg-[#222] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50 dark:bg-[#E0E0E0] dark:text-[#222]">
                {t('orca.connectFinish')}
              </button>
              <button type="button" data-testid="orca-connect-cancel" onClick={cancelLogin}
                className="min-h-10 shrink-0 rounded-md bg-[#E0E0E0] px-3 py-2 text-[13px] text-[#333] dark:bg-[#333] dark:text-[#E0E0E0]">
                {t('orca.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {credential?.configured && (
        <button type="button" data-testid="orca-clear" onClick={() => void removeKey()} disabled={busy !== ''}
          className="text-[12.5px] text-[#A33] hover:underline disabled:opacity-50 dark:text-[#E89B9B]">
          {t('orca.clearKey')}
        </button>
      )}

      {error && <div className="text-[12.5px] text-[#C0392B] dark:text-[#E89B9B]" data-testid="orca-error">{error}</div>}
      {notice && <div className="text-[12.5px] text-[#4C7A4C] dark:text-[#9CC99C]" data-testid="orca-notice">{notice}</div>}
    </section>
  );
}
