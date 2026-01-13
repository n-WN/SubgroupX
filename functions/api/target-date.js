function getTargetDateString(env) {
  const raw = env?.TARGET_DATE;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return '2026-01-15T23:00:00+08:00';
}

function parseDateOrNull(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export async function onRequest({ env }) {
  const nowIso = new Date().toISOString();
  const targetDate = getTargetDateString(env);
  const parsed = parseDateOrNull(targetDate);

  if (!parsed) {
    return Response.json(
      {
        targetDate: '2026-01-15T23:00:00+08:00',
        labelDate: '2026-01-15',
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
      labelDate: targetDate.split('T')[0],
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

