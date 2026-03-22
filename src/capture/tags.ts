export const ALLOWED_TAGS = [
  'preference', 'decision', 'problem-solution', 'pattern',
  'goal', 'opinion', 'skill', 'relationship',
  'resource', 'idea', 'interest', 'health',
  'dislike', 'milestone',
] as const;

export type AllowedTag = typeof ALLOWED_TAGS[number];

export const TAG_DESCRIPTIONS: Record<AllowedTag, string> = {
  'preference': 'How the person likes things done',
  'decision': 'A choice made with rationale',
  'problem-solution': 'A problem encountered and how it was resolved',
  'pattern': 'A recurring behavior or habit observed over time',
  'goal': 'An aspiration, target, or planned direction',
  'opinion': 'A stance or belief with reasoning',
  'skill': 'A capability or expertise level',
  'relationship': 'Knowledge about a specific person',
  'resource': 'A tool, link, article, or reference worth recalling',
  'idea': 'An uncommitted exploration or possibility',
  'interest': 'A hobby, passion, or thing enjoyed',
  'health': 'Medical, fitness, dietary, or wellness information',
  'dislike': 'Something to avoid or never suggest',
  'milestone': 'A significant achievement or turning point',
};

const TAG_SET = new Set<string>(ALLOWED_TAGS);

export function isValidTag(tag: string): boolean {
  return TAG_SET.has(tag);
}

export function validateTags(tags: string[]): string[] {
  return [...new Set(tags.filter(isValidTag))];
}
