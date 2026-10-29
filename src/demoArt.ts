import sharp from 'sharp';

/** Studio-style demo frames. These are generated placeholders, not photographs of real products. */
export function demoProductSvg(opts: { title: string; color: string; accent: string; angle: number; label: string }): string {
  const { title, color, accent, angle, label } = opts;
  const safe = title.replace(/[<>&]/g, '');
  const caption = label.replace(/[<>&]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1000" viewBox="0 0 1400 1000">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#120c16"/>
      <stop offset="0.55" stop-color="${color}"/>
      <stop offset="1" stop-color="#07060b"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="38%">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft"><feDropShadow dx="0" dy="28" stdDeviation="24" flood-color="#000" flood-opacity="0.45"/></filter>
  </defs>
  <rect width="1400" height="1000" fill="url(#bg)"/>
  <rect width="1400" height="1000" fill="url(#glow)"/>
  <ellipse cx="700" cy="820" rx="340" ry="36" fill="rgba(0,0,0,.45)"/>
  <g filter="url(#soft)" transform="translate(700 470) rotate(${angle}) translate(-700 -470)">
    <rect x="430" y="250" width="540" height="380" rx="48" fill="#16131d" stroke="${accent}" stroke-width="6"/>
    <rect x="470" y="300" width="460" height="220" rx="24" fill="${color}"/>
    <circle cx="560" cy="410" r="54" fill="none" stroke="#f7f4fb" stroke-width="10"/>
    <circle cx="840" cy="410" r="54" fill="none" stroke="#f7f4fb" stroke-width="10"/>
    <path d="M560 356 C620 300 780 300 840 356" fill="none" stroke="#f7f4fb" stroke-width="10" stroke-linecap="round"/>
    <rect x="500" y="560" width="180" height="18" rx="9" fill="${accent}"/>
    <rect x="700" y="560" width="120" height="18" rx="9" fill="rgba(247,244,251,.35)"/>
  </g>
  <text x="80" y="900" fill="#f7f4fb" font-family="sans-serif" font-size="54" font-weight="700">${safe}</text>
  <text x="80" y="950" fill="#b7afc4" font-family="sans-serif" font-size="28">${caption}</text>
</svg>`;
}

export async function demoProductPng(opts: { title: string; color: string; accent: string; angle: number; label: string }): Promise<Buffer> {
  const svg = demoProductSvg(opts);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
