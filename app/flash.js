export function Flash({ sp }) {
  if (sp?.error) return <p className="flash flash-error" role="alert">{sp.error}</p>;
  if (sp?.notice) return <p className="flash flash-ok" role="status">{sp.notice}</p>;
  return null;
}

export const fmt = (d) =>
  d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
