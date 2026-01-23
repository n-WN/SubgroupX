/**
 * SubgroupX Landing Page Logic
 * Target Date: from /api/target-date (fallback below)
 */

const FALLBACK_TARGET_DATE = '2026-01-24T17:00:00+08:00';

const TRANSLATIONS = {
  en: {
    'banner.milestone': '[ MILESTONE ] Evolution track: when GitHub Stars hit 500 / 1000, deeper capabilities unlock.',
    'nav.agent': '[ AGENT ]',
    'nav.protocol': '[ PROTOCOL ]',
    'nav.brief': '[ BRIEF ]',
    'nav.honors': '[ HONORS ]',
    'tooltip.arxiv': 'The manuscript is being refined. Please check back soon.',
    'status.pending': 'SYSTEM_STATUS: PENDING_LAUNCH',
    'hero.title.top': 'GEOMETRIC',
    'hero.title.bottom': 'INTELLIGENCE',
    'countdown.days': 'DAYS',
    'countdown.hours': 'HRS',
    'countdown.minutes': 'MIN',
    'countdown.seconds': 'SEC',
    'cta.github': 'View on GitHub',
    'cta.brief': 'Agent Brief',
    'section.identity.marker': '01 // IDENTITY',
    'section.identity.title.top': 'CALCULATED',
    'section.identity.title.bottom': 'SECURITY',
    'section.identity.body':
      'SubgroupX brings calculated precision to offensive security. An AI Agent crafted by <span class="highlight">Normal Subgroup</span>, engineered for Capture The Flag (CTF) challenges, penetration testing, and proactive defense systems.',
    'section.capabilities.marker': '02 // CAPABILITIES',
    'feature.autonomy': 'Self-directed vulnerability assessment algorithms.',
    'feature.accuracy': 'Mathematical precision in exploit chain execution.',
    'feature.adaptation': 'Real-time learning from adversarial geometries.',
    'feature.defense': 'Proactive shielding against asymmetric threats.',
    'section.agent.marker': '03 // AGENT BRIEF',
    'section.agent.title.top': 'OPSEC',
    'section.agent.title.bottom': 'FIRST',
    'section.agent.body':
      'The full Agent core is not public yet. This page only exposes safe, non-sensitive descriptions. For verified updates and roadmap milestones, follow the GitHub repository.',
    'glossary.agent': 'A task-driven system that plans, uses tools, and produces reproducible results.',
    'glossary.ctf': 'Capture The Flag competitions; practical security problem-solving.',
    'glossary.domains': 'Common categories: binary exploitation, web security, and cryptography.',
    'glossary.geom': 'A metaphor for structured reasoning: states, constraints, and paths.',
    'cta.github.secondary': 'Follow on GitHub',
    'collab.title': 'COLLABORATION',
    'collab.body':
      'Collaboration (research or commercialization): email <a class="info-link" href="mailto:Latticebased@outlook.com">Latticebased@outlook.com</a> — keep it non-sensitive.',
    'waitlist.title': 'WAITLIST',
    'waitlist.body':
      'Leave an email for the launch notification (optional). Prefer a dedicated address if privacy-sensitive.',
    'waitlist.label': 'Email',
    'waitlist.placeholder': 'Email address',
    'waitlist.submit': 'JOIN',
    'waitlist.status.success': 'Added to waitlist.',
    'waitlist.status.already': 'Already on the list.',
    'waitlist.status.invalid': 'Please enter a valid email.',
    'waitlist.status.error': 'Submission failed. Please try again later.',
    'waitlist.status.empty': 'Email is required.',
    'waitlist.privacy':
      'Privacy note: stored in Cloudflare D1 (email + timestamp only) for launch updates. No marketing, no resale. Request removal by emailing <a class="info-link" href="mailto:Latticebased@outlook.com">Latticebased@outlook.com</a> (from the same address).',
    'info.title': 'PUBLIC STATUS',
    'info.launch': 'LAUNCH',
    'info.mode': 'MODE',
    'info.mode.value': 'PENDING_LAUNCH',
    'info.repo': 'REPO',
    'section.recognition.marker': '04 // RECOGNITION',
    'section.recognition.title.top': 'BATTLE-',
    'section.recognition.title.bottom': 'TESTED',
    'award.secondPlace': 'Second Place',
    'award.runnerUp': 'Runner-up',
    'award.coverage.title': 'FULL-SPECTRUM COVERAGE',
    'award.coverage.body': 'Pwn · Web · Crypto · Reverse · Blockchain · Misc (Forensics)',
    'award.impact.title': 'REAL-WORLD IMPACT',
    'award.impact.body': 'Zero-day vulnerabilities discovered in production systems',
    'footer.brand': 'SUBGROUPX // NORMAL SUBGROUP',
    'footer.meta': 'LAUNCHING: REMOTE<br>COORDINATES: CYBERSPACE',
    'meta.description': 'SubgroupX Agent - CTF & Penetration Testing AI. Launching {date} {time} ({tz}).',
    'countdown.label': 'T-MINUS // TARGET {date} {time} ({tz})',
    'countdown.launched': 'LAUNCH SEQUENCE INITIATED',
    'lang.toggle.aria': 'Switch language',
  },
  zh: {
    'banner.milestone': '[ 里程碑 ] 进化轨迹：GitHub Star 达到 500 / 1000 节点后，将逐步解锁更深能力。',
    'nav.agent': '[ 介绍 ]',
    'nav.protocol': '[ 能力 ]',
    'nav.brief': '[ 简报 ]',
    'nav.honors': '[ 荣誉 ]',
    'tooltip.arxiv': '稿件正在完善中，敬请期待。',
    'status.pending': 'SYSTEM_STATUS: 待发布',
    'hero.title.top': 'GEOMETRIC',
    'hero.title.bottom': 'INTELLIGENCE',
    'countdown.days': '天',
    'countdown.hours': '时',
    'countdown.minutes': '分',
    'countdown.seconds': '秒',
    'cta.github': '前往 GitHub',
    'cta.brief': '了解 Agent',
    'section.identity.marker': '01 // 身份',
    'section.identity.title.top': '计算式',
    'section.identity.title.bottom': '安全',
    'section.identity.body':
      'SubgroupX 将可复现的精确性带入攻防安全。由 <span class="highlight">Normal Subgroup</span> 设计构建，面向 CTF、渗透测试与主动防御等场景。更多核心细节将在公开发布后释出。',
    'section.capabilities.marker': '02 // 能力',
    'feature.autonomy': '自主漏洞评估、任务拆解与执行。',
    'feature.accuracy': '以可验证的逻辑链路完成关键步骤。',
    'feature.adaptation': '从对抗样本与约束中实时调整策略。',
    'feature.defense': '面向非对称威胁的主动防护与收敛。',
    'section.agent.marker': '03 // AGENT 简报',
    'section.agent.title.top': 'OPSEC',
    'section.agent.title.bottom': '优先',
    'section.agent.body':
      '完整 Agent 内核目前尚未公开。本页面仅展示对外安全的描述与术语解释。想获取经过验证的更新与路线图，请关注 GitHub 仓库。',
    'glossary.agent': '以任务为中心：规划 → 调用工具 → 产出可复现结果。',
    'glossary.ctf': 'CTF（夺旗赛）：面向实战的安全解题与攻防训练。',
    'glossary.domains': '常见方向：Pwn（二进制利用）、Web（Web 安全）、Crypto（密码学）。',
    'glossary.geom': 'Geometric Intelligence 在此是隐喻：用状态、约束、路径组织推理与行动。',
    'cta.github.secondary': '关注 GitHub 更新',
    'collab.title': '合作',
    'collab.body':
      '合作（科研或商业化）：请邮件联系 <a class="info-link" href="mailto:Latticebased@outlook.com">Latticebased@outlook.com</a>，沟通请仅包含可公开/非敏感信息。',
    'waitlist.title': '等待列表',
    'waitlist.body': '留下邮箱（可选），用于发布通知。若介意隐私，建议使用专门/一次性邮箱。',
    'waitlist.label': '邮箱',
    'waitlist.placeholder': '邮箱地址',
    'waitlist.submit': '提交',
    'waitlist.status.success': '已加入等待列表。',
    'waitlist.status.already': '该邮箱已在列表中。',
    'waitlist.status.invalid': '请输入有效的邮箱地址。',
    'waitlist.status.error': '提交失败，请稍后再试。',
    'waitlist.status.empty': '请填写邮箱地址。',
    'waitlist.privacy':
      '隐私提示：邮箱将存储在 Cloudflare D1（仅邮箱 + 提交时间），仅用于发布通知；不做营销，不出售/共享。如需删除，请使用同一邮箱发邮件至 <a class="info-link" href="mailto:Latticebased@outlook.com">Latticebased@outlook.com</a>。',
    'info.title': '公开状态',
    'info.launch': '发布时间',
    'info.mode': '模式',
    'info.mode.value': '待发布',
    'info.repo': '仓库',
    'section.recognition.marker': '04 // 荣誉',
    'section.recognition.title.top': '实战',
    'section.recognition.title.bottom': '验证',
    'award.secondPlace': '第二名',
    'award.runnerUp': '亚军',
    'award.coverage.title': '全栈覆盖',
    'award.coverage.body': 'Pwn(二进制) · Web(Web 安全) · Crypto(密码学) · Reverse(逆向) · Blockchain(区块链) · Misc(杂项/取证)',
    'award.impact.title': '真实世界影响',
    'award.impact.body': '在生产环境系统中发现并报告 0-day 漏洞',
    'footer.brand': 'SUBGROUPX // NORMAL SUBGROUP',
    'footer.meta': '发布：远程<br>坐标：网络空间',
    'meta.description': 'SubgroupX Agent - 面向 CTF 与渗透测试的 AI Agent。预计 {date} {time}（{tz}）发布。',
    'countdown.label': '倒计时 // 目标 {date} {time}（{tz}）',
    'countdown.launched': '发布序列启动',
    'lang.toggle.aria': '切换语言',
  },
};

const state = {
  lang: 'en',
  targetDateString: FALLBACK_TARGET_DATE,
};

let TARGET_DATE = new Date(FALLBACK_TARGET_DATE);

// DOM Elements
const els = {
  days: document.getElementById('days'),
  hours: document.getElementById('hours'),
  minutes: document.getElementById('minutes'),
  seconds: document.getElementById('seconds'),
  countdown: document.getElementById('countdown'),
  countdownLabel: document.querySelector('.countdown-label'),
  releaseTime: document.getElementById('release-time'),
  langToggle: document.getElementById('lang-toggle'),
  waitlistForm: document.getElementById('waitlist-form'),
  waitlistEmail: document.getElementById('waitlist-email'),
  waitlistStatus: document.getElementById('waitlist-status'),
};

function normalizeLang(lang) {
  if (!lang) return 'en';
  const v = String(lang).trim().toLowerCase();
  if (v === 'zh' || v.startsWith('zh-')) return 'zh';
  if (v === 'en' || v.startsWith('en-')) return 'en';
  return 'en';
}

function getInitialLang() {
  const url = new URL(window.location.href);
  const param = normalizeLang(url.searchParams.get('lang'));
  if (param === 'zh' || param === 'en') return param;

  const stored = localStorage.getItem('lang');
  if (stored === 'zh' || stored === 'en') return stored;

  const langs = Array.isArray(navigator.languages) ? navigator.languages : [];
  const first = langs.length ? langs[0] : navigator.language;
  return normalizeLang(first);
}

function t(key) {
  return TRANSLATIONS[state.lang]?.[key] ?? TRANSLATIONS.en[key] ?? key;
}

function formatTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

function parseTargetDateParts(targetDateString) {
  const labelDate = targetDateString.split('T')[0];
  const timeMatch = targetDateString.match(/T(\d{2}:\d{2})/);
  const labelTime = timeMatch ? timeMatch[1] : '00:00';

  const tzMatch = targetDateString.match(/([+-]\d{2}):\d{2}$/);
  const tzHours = tzMatch ? parseInt(tzMatch[1], 10) : 0;
  const tz = `UTC${tzHours >= 0 ? '+' : ''}${tzHours}`;

  return { date: labelDate, time: labelTime, tz };
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });

  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });

  document.querySelectorAll('[data-i18n-attr][data-i18n-attr-key]').forEach((el) => {
    const attr = el.dataset.i18nAttr;
    const key = el.dataset.i18nAttrKey;
    if (attr && key) el.setAttribute(attr, t(key));
  });

  if (els.langToggle) {
    els.langToggle.setAttribute('aria-label', t('lang.toggle.aria'));
  }
}

function updateCountdownLabel(targetDateString) {
  const parts = parseTargetDateParts(targetDateString);

  if (els.countdownLabel) {
    els.countdownLabel.textContent = formatTemplate(t('countdown.label'), parts);
  }

  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription) {
    metaDescription.setAttribute('content', formatTemplate(t('meta.description'), parts));
  }

  if (els.releaseTime) {
    els.releaseTime.textContent = `${parts.date} ${parts.time} ${parts.tz}`;
  }
}

function setLang(lang, { persist = true } = {}) {
  state.lang = normalizeLang(lang);
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';

  if (persist) {
    localStorage.setItem('lang', state.lang);
    const url = new URL(window.location.href);
    url.searchParams.set('lang', state.lang);
    window.history.replaceState({}, '', url);
  }

  applyTranslations();
  updateCountdownLabel(state.targetDateString);
}

async function loadTargetDate() {
  try {
    const res = await fetch('/api/target-date', { cache: 'no-store' });
    if (!res.ok) throw new Error(`target-date fetch failed: ${res.status}`);

    const data = await res.json();
    if (!data || typeof data.targetDate !== 'string') {
      throw new Error('target-date response missing targetDate');
    }

    const parsed = new Date(data.targetDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`invalid targetDate: ${data.targetDate}`);
    }

    state.targetDateString = data.targetDate;
    TARGET_DATE = parsed;
    updateCountdownLabel(state.targetDateString);
  } catch (err) {
    console.warn('Using fallback target date:', err);
    state.targetDateString = FALLBACK_TARGET_DATE;
    updateCountdownLabel(state.targetDateString);
  }
}

function updateCountdown() {
  const now = new Date();
  const diff = TARGET_DATE - now;

  if (diff <= 0) {
    // Launch Time
    els.countdown.innerHTML = `<div style="font-size: 2rem; color: var(--accent-magenta);">${t('countdown.launched')}</div>`;
    return;
  }

  // Calculate time components
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / 1000 / 60) % 60);
  const seconds = Math.floor((diff / 1000) % 60);

  // Pad with zeros and update DOM
  els.days.textContent = Math.max(0, days).toString().padStart(3, '0');
  els.hours.textContent = Math.max(0, hours).toString().padStart(2, '0');
  els.minutes.textContent = Math.max(0, minutes).toString().padStart(2, '0');
  els.seconds.textContent = Math.max(0, seconds).toString().padStart(2, '0');
}

function validateEmail(value) {
  const email = String(value || '').trim();
  if (!email) return { ok: false, reason: 'empty' };
  if (email.length > 254) return { ok: false, reason: 'invalid' };
  const simple = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!simple.test(email)) return { ok: false, reason: 'invalid' };
  return { ok: true, email: email.toLowerCase() };
}

async function submitWaitlist(email, honeypot = '') {
  const payload = {
    email,
    lang: state.lang,
    company: honeypot,
  };

  const res = await fetch('/api/waitlist', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const code = data?.code || 'error';
    const err = new Error(code);
    err.code = code;
    throw err;
  }

  return data;
}

// Initialize
function init() {
  console.log('SubgroupX System Initialized');
  console.log('Target:', TARGET_DATE);

  setLang(getInitialLang(), { persist: false });
  if (els.langToggle) {
    els.langToggle.addEventListener('click', () => {
      setLang(state.lang === 'zh' ? 'en' : 'zh');
    });
  }

  loadTargetDate();
  updateCountdown();
  setInterval(updateCountdown, 1000);

  if (els.waitlistForm && els.waitlistEmail && els.waitlistStatus) {
    const submitButton = els.waitlistForm.querySelector('button[type="submit"]');
    const honeypotInput = els.waitlistForm.querySelector('input[name="company"]');

    els.waitlistForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      els.waitlistStatus.textContent = '';

      const hp = honeypotInput?.value ? String(honeypotInput.value) : '';
      const validated = validateEmail(els.waitlistEmail.value);
      if (!validated.ok) {
        els.waitlistStatus.textContent =
          validated.reason === 'empty' ? t('waitlist.status.empty') : t('waitlist.status.invalid');
        return;
      }

      if (hp) {
        els.waitlistStatus.textContent = t('waitlist.status.success');
        return;
      }

      if (submitButton) submitButton.disabled = true;

      try {
        const result = await submitWaitlist(validated.email, hp);
        const already = Boolean(result?.already);
        els.waitlistStatus.textContent = already ? t('waitlist.status.already') : t('waitlist.status.success');
        els.waitlistEmail.value = '';
      } catch (err) {
        if (err?.code === 'invalid_email') {
          els.waitlistStatus.textContent = t('waitlist.status.invalid');
        } else {
          els.waitlistStatus.textContent = t('waitlist.status.error');
        }
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  }

  // Simple scroll reveal (optional enhancement)
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.feature-card, .text-block').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });
}

init();
