export const cls = (...xs: Array<string | false | null | undefined>) =>
  xs.filter(Boolean).join(' ');

export function fmtRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const sign = ms < 0 ? 'in ' : '';
  const suffix = ms < 0 ? '' : ' ago';
  if (abs < 60e3) return ms < 0 ? 'soon' : 'just now';
  const m = Math.round(abs / 60e3);
  if (m < 60) return `${sign}${m}m${suffix}`;
  const h = Math.round(abs / 3600e3);
  if (h < 24) return `${sign}${h}h${suffix}`;
  const d = Math.round(abs / 86400e3);
  if (d < 30) return `${sign}${d}d${suffix}`;
  const mo = Math.round(d / 30);
  return `${sign}${mo}mo${suffix}`;
}

export const isOverdue = (iso: string | null) =>
  !!iso && Date.now() > new Date(iso).getTime();
