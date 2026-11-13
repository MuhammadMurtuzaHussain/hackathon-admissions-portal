// Signal score: a transparent rubric that helps reviewers sort a large pile.
// It never accepts or rejects anyone by itself. This is the seam where an LLM
// rubric pass (or GitHub activity lookup) plugs in later: keep the same
// return shape and the admin UI needs no changes.

const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com'];

export function scoreApplication(a, email) {
  const words = a.motivation.trim().split(/\s+/).filter(Boolean).length;
  const parts = [
    { label: 'GitHub profile', pts: a.github ? 15 : 0, max: 15 },
    { label: 'LinkedIn', pts: a.linkedin ? 10 : 0, max: 10 },
    { label: 'Portfolio or past work', pts: a.portfolio ? 15 : 0, max: 15 },
    { label: 'Depth of answer', pts: Math.min(45, Math.round((words / 70) * 45)), max: 45 },
    { label: 'Complete profile', pts: a.full_name.trim().includes(' ') && a.affiliation.trim().length > 2 ? 15 : 5, max: 15 },
  ];
  const flags = [];
  if (words < 15) flags.push('thin answer');
  if (DISPOSABLE.includes((email.split('@')[1] || '').toLowerCase())) flags.push('disposable email');
  if (!a.github && !a.linkedin && !a.portfolio) flags.push('no links');
  return { score: parts.reduce((s, p) => s + p.pts, 0), detail: { parts, flags } };
}
