// src/services/checkin.ts
import type { ServiceDeps } from './index.js';
import { getConsolidationLogsSince } from '../db/consolidation-log.js';
import { findFactsCreatedSince } from '../db/facts.js';
import { findInsightsCreatedSince } from '../db/insights.js';
import { countCapturesCreatedSince, countCapturesArchivedSince } from '../db/captures.js';
import { findPendingReviewFacts } from '../db/facts.js';
import { findPendingReviewInsights } from '../db/insights.js';

export interface CheckinContext {
  date: string;
  timezone: string;
  activity: {
    totals: { captures: number; facts: number; insights: number };
    capturesNew: number;
    capturesArchived: number;
    consolidationRuns: number;
    consolidationSuccesses: number;
    consolidationNoOps: number;
    factsCreated: Array<{ id: string; content: string; tags: string[] }>;
    insightsCreated: Array<{ id: string; content: string; tags: string[] }>;
    pendingReview: number;
  };
  reminders: {
    active: number;
    dueToday: number;
    overdue: number;
  };
  questions: string[];
  instructions: string;
}

const CHECKIN_QUESTIONS = [
  'What\'s one decision you made today (or recently) and why did you go that direction?',
  'What frustrated or energized you lately? What was behind that feeling?',
  'Did you learn something new, change your mind about something, or discover a gotcha worth remembering?',
  'Any commitments, deadlines, or follow-ups you want to track?',
  'Anything else you want future-you (or future AI sessions) to remember?',
];

const CHECKIN_INSTRUCTIONS = `You are conducting a daily check-in to help capture meaningful knowledge for Open Brain.

## How to Run This Check-in

1. Start by reviewing the activity summary below — mention anything noteworthy (new facts, pending reviews, overdue reminders).
2. Ask the questions ONE AT A TIME. Wait for the user's answer before moving to the next.
3. After each answer, capture the meaningful signal via capture_thought (third person, with tags).
4. Skip questions the user waves off — don't force it.
5. If an answer reveals a commitment or deadline, offer to create a reminder.
6. If there are pending review items, ask if the user wants to review them.
7. Keep the tone conversational — this should feel like a quick reflection, not an interrogation.

## What Makes a Good Capture

- Decisions with reasoning: "Alex chose X over Y because Z"
- Emotional signals: "Alex was frustrated by X — it slowed down the deploy"
- Learnings: "Discovered that Gemini Flash needs maxTokens >= 1024"
- Pattern observations: "Alex tends to prototype first, test after"
- Goals and intentions: "Alex wants to improve Open Brain's capture quality"

Don't capture the operational back-and-forth of the check-in itself.`;

/**
 * Gather context for a daily check-in session.
 * Returns recent activity, current state, questions, and instructions
 * for a Claude agent to drive the conversation.
 */
export async function getDailyCheckinContext(deps: ServiceDeps): Promise<CheckinContext> {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000); // last 24h

  const todayStr = now.toLocaleDateString('en-CA', { timeZone: deps.config.timezone });

  // Run all queries in parallel
  const [
    consolidationLogs,
    newFacts,
    newInsights,
    capturesNew,
    capturesArchived,
    pendingFacts,
    pendingInsights,
    reminderStats,
    totals,
  ] = await Promise.all([
    getConsolidationLogsSince(deps.db, since),
    findFactsCreatedSince(deps.db, since),
    findInsightsCreatedSince(deps.db, since),
    countCapturesCreatedSince(deps.db, since),
    countCapturesArchivedSince(deps.db, since),
    findPendingReviewFacts(deps.db, 100),
    findPendingReviewInsights(deps.db, 100),
    getReminderStats(deps, todayStr),
    getTotals(deps),
  ]);

  return {
    date: todayStr,
    timezone: deps.config.timezone,
    activity: {
      totals,
      capturesNew,
      capturesArchived,
      consolidationRuns: consolidationLogs.length,
      consolidationSuccesses: consolidationLogs.filter(l => l.status === 'success').length,
      consolidationNoOps: consolidationLogs.filter(l => l.status === 'no-op').length,
      factsCreated: newFacts.map(f => ({ id: f.id, content: f.content, tags: f.tags })),
      insightsCreated: newInsights.map(i => ({ id: i.id, content: i.content, tags: i.tags })),
      pendingReview: pendingFacts.length + pendingInsights.length,
    },
    reminders: reminderStats,
    questions: CHECKIN_QUESTIONS,
    instructions: CHECKIN_INSTRUCTIONS,
  };
}

async function getTotals(
  deps: ServiceDeps,
): Promise<{ captures: number; facts: number; insights: number }> {
  const result = await deps.db.query(`
    SELECT
      (SELECT count(*)::int FROM captures WHERE archived = false) AS captures,
      (SELECT count(*)::int FROM facts WHERE archived = false) AS facts,
      (SELECT count(*)::int FROM insights WHERE archived = false) AS insights
  `);
  return result.rows[0];
}

async function getReminderStats(
  deps: ServiceDeps,
  todayStr: string,
): Promise<{ active: number; dueToday: number; overdue: number }> {
  const result = await deps.db.query(`
    SELECT
      (SELECT count(*)::int FROM reminders WHERE status NOT IN ('done', 'cancelled') AND archived = false) AS active,
      (SELECT count(*)::int FROM reminders WHERE due_date::date = $1 AND status NOT IN ('done', 'cancelled') AND archived = false) AS due_today,
      (SELECT count(*)::int FROM reminders WHERE due_date < now() AND due_date::date < $1 AND status NOT IN ('done', 'cancelled') AND archived = false) AS overdue
  `, [todayStr]);
  const row = result.rows[0];
  return {
    active: row.active,
    dueToday: row.due_today,
    overdue: row.overdue,
  };
}
