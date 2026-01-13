function getTargetDateString(env) {
  const raw = env?.TARGET_DATE;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return '2026-01-15T23:00:00+08:00';
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return ch;
    }
  });
}

export async function onRequest({ env }) {
  const targetDateString = getTargetDateString(env);
  const targetDate = new Date(targetDateString);

  if (Number.isNaN(targetDate.getTime())) {
    return new Response('Invalid TARGET_DATE', { status: 500 });
  }

  let diffMs = targetDate.getTime() - Date.now();
  if (diffMs < 0) diffMs = 0;

  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs / 3600000) % 24);
  const timeText = diffMs <= 0 ? 'SYSTEM_DEPLOYED' : `${days.toString().padStart(3, '0')}D : ${hours.toString().padStart(2, '0')}H`;

  const labelDate = targetDateString.split('T')[0];
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="400" height="80" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#0a0a0a" rx="4"/>
  <text x="50%" y="45" font-family="monospace" font-size="32" fill="#00ffff" text-anchor="middle" font-weight="bold">${escapeXml(timeText)}</text>
  <text x="50%" y="70" font-family="monospace" font-size="12" fill="#ffffff" text-anchor="middle" opacity="0.5">T-MINUS // TARGET: ${escapeXml(labelDate)}</text>
  <rect x="10%" y="55" width="80%" height="2" fill="#333"/>
  <rect x="10%" y="55" width="80%" height="2" fill="#00ffff">
    <animate attributeName="width" from="0%" to="80%" dur="2s" fill="freeze" />
  </rect>
</svg>
`;

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

