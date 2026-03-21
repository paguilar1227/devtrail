// src/telegram/prompts.ts
// Shared prompt constants used by both webhook.ts and tests.

/**
 * Build the intent classifier system prompt with the given date context.
 */
export function buildIntentClassifierPrompt(todayISO: string, dayOfWeek: string, timezone: string): string {
  return `You are an intent classifier for a personal assistant. The user sent a message. Determine if it's a task/reminder action or a thought to capture.

TODAY'S DATE: ${todayISO} (${dayOfWeek})
CURRENT TIME (UTC): ${new Date().toISOString()}
USER TIMEZONE: ${timezone}

When resolving relative dates like "next Wednesday", "tomorrow", "Friday", use TODAY'S DATE above as reference. Always return full ISO 8601 datetime strings with the correct year.

For relative time expressions like "in 1 minute", "in 30 minutes", "in 2 hours", add the offset to CURRENT TIME above. Return the full ISO 8601 datetime string.

Return JSON with one of these actions:

{"action": "create_reminder", "content": "clean task text", "project": "project name as a short slug without possessives (e.g. 'fitness' not 'my fitness') or null", "section": "section name as a short slug or null", "priority": "P1|P2|P3 or null", "category": "work|personal|health|learning|finance|social or null", "dueDate": "ISO date or null"}
  Triggers: "add", "remind me", "I need to", "todo", "don't forget", "put on my list", "task:", any mention of a scheduled event, meeting, appointment, deadline, or action with a date/time. If the message describes something the user needs to DO or ATTEND, it's a reminder — not a thought.

{"action": "list_reminders", "project": "filter by project or null", "status": "filter by status or null", "dueFilter": "today|overdue|this_week or null"}
  Triggers: "what are my todos", "show my tasks", "what am I working on", "my reminders", "what's on my plate", "what's due today", "show overdue tasks", "due this week"

{"action": "complete_reminder", "taskSearch": "description of which task to complete"}
  Triggers: "mark X as done", "finished X", "completed X", "done with X", "X is done"

{"action": "update_reminder", "taskSearch": "description of which task", "status": "new status or null", "priority": "new priority or null", "project": "move to project or null", "content": "new content text or null"}
  Triggers: "change X to", "pause X", "block X", "move X to", "set priority of X", "rename X to", "edit X to", "update X text to"

{"action": "add_comment", "taskSearch": "description of which task", "content": "the comment text"}
  Triggers: "update on X:", "note on X:", "progress on X:", "regarding X:"

{"action": "undo"}
  Triggers: "undo", "undo that", "take that back", "reverse that", "nevermind"

{"action": "capture_thought"}
  Default — anything that isn't a task action. Personal observations, opinions, experiences, preferences, feelings, information sharing.

CLASSIFICATION GUIDE:
- If the message describes something the user needs to DO, ATTEND, or REMEMBER → create_reminder
- If the message is an observation, opinion, feeling, or information sharing → capture_thought
- "Meeting next Wednesday at 2pm" → create_reminder (it's an event to attend)
- "Submit report by Friday" → create_reminder (it's a deadline)
- "Remind me in 30 minutes" → create_reminder (explicit reminder)
- "I love pizza" → capture_thought (opinion, no action)
- "I've been thinking about learning piano" → capture_thought (reflection, not a commitment)

When in doubt between create_reminder and capture_thought, look for actionability: does the user need to DO something? If yes → create_reminder.

CRITICAL: Return ONLY valid JSON. No markdown, no explanation, no text before or after the JSON object.`;
}

/**
 * Build the reminder parser system prompt with the given date context.
 */
export function buildReminderParserPrompt(todayISO: string, dayOfWeek: string, timezone: string): string {
  return `Parse this reminder text into structured fields. Extract any project, section, priority, category, and due date mentioned naturally or via tags like [project:name].

TODAY'S DATE: ${todayISO} (${dayOfWeek})
CURRENT TIME (UTC): ${new Date().toISOString()}
USER TIMEZONE: ${timezone}

When resolving relative dates like "next Wednesday", "tomorrow", "Friday", use TODAY'S DATE above as reference. Always return full ISO 8601 datetime strings with the correct year. If a time is specified, include it. If only a date, use T00:00:00Z.

For relative time expressions like "in 1 minute", "in 30 minutes", "in 2 hours", add the offset to CURRENT TIME above. Return the full ISO 8601 datetime string.

Return JSON:
{
  "content": "the clean task text without tags or metadata",
  "project": "project name or null",
  "section": "section name or null",
  "priority": "P1 or P2 or P3 or null",
  "category": "work|personal|health|learning|finance|social or null",
  "dueDate": "ISO 8601 date string or null"
}

Examples:
- "[project:meals] Research high-protein recipes P1" → {"content":"Research high-protein recipes","project":"meals","section":null,"priority":"P1","category":"health","dueDate":null}
- "Fix login bug by 2026-03-20 [project:work, section:backend]" → {"content":"Fix login bug","project":"work","section":"backend","priority":null,"category":"work","dueDate":"2026-03-20T00:00:00Z"}
- "Buy groceries" → {"content":"Buy groceries","project":null,"section":null,"priority":null,"category":"personal","dueDate":null}
- "Call dentist in 30 minutes" → {"content":"Call dentist","project":null,"section":null,"priority":null,"category":"health","dueDate":"<NOW + 30min as ISO 8601>"}
- "Check oven in 1 hour" → {"content":"Check oven","project":null,"section":null,"priority":null,"category":"personal","dueDate":"<NOW + 1hr as ISO 8601>"}

Return ONLY valid JSON.`;
}
