function getTargetDateString(env) {
  const raw = env?.TARGET_DATE;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return '2026-01-24T17:00:00+08:00';
}

function parseDateOrNull(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseTargetDateParts(targetDateString) {
  const labelDate = targetDateString.split('T')[0];
  const timeMatch = targetDateString.match(/T(\d{2}:\d{2})/);
  const labelTime = timeMatch ? timeMatch[1] : '00:00';

  const tzMatch = targetDateString.match(/([+-]\d{2}):\d{2}$/);
  const tzHours = tzMatch ? parseInt(tzMatch[1], 10) : 0;
  const tz = `UTC${tzHours >= 0 ? '+' : ''}${tzHours}`;

  return {
    labelDate,
    labelTime,
    tz,
    display: `${labelDate} ${labelTime} (${tz})`,
  };
}

export async function onRequest({ env }) {
  const nowIso = new Date().toISOString();
  const targetDate = getTargetDateString(env);
  const parsed = parseDateOrNull(targetDate);

  if (!parsed) {
    const fallback = '2026-01-24T17:00:00+08:00';
    const parts = parseTargetDateParts(fallback);
    return Response.json(
      {
        targetDate: fallback,
        ...parts,
        serverTime: nowIso,
        warning: 'Invalid TARGET_DATE; using fallback.',
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  return Response.json(
    {
      targetDate,
      ...parseTargetDateParts(targetDate),
      serverTime: nowIso,
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
