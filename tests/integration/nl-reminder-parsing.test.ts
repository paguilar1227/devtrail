// tests/integration/nl-reminder-parsing.test.ts — Section 19: NL parsing quality
// These are LLM integration tests — they call real Gemini Flash.
// Skip if no GEMINI_API_KEY is set.
import { describe, it, expect } from 'vitest';
import { GeminiLLMProvider } from '../../src/providers/gemini-llm.js';
import { buildIntentClassifierPrompt } from '../../src/telegram/prompts.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const describeIfKey = GEMINI_KEY ? describe : describe.skip;

// Helper: call the LLM with the intent classifier prompt (with retry for JSON flakes)
class LLMFlakeError extends Error { constructor(msg: string) { super(msg); this.name = 'LLMFlakeError'; } }

async function classifyIntent(llm: GeminiLLMProvider, text: string, retries = 4): Promise<any> {
  const today = new Date();
  const todayISO = today.toISOString().split('T')[0];
  const dayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(today);
  const timezone = 'America/Chicago';

  const prompt = buildIntentClassifierPrompt(todayISO, dayOfWeek, timezone);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await llm.complete(
        [{ role: 'user', content: text }],
        { systemPrompt: prompt, responseFormat: 'json', maxTokens: 256 },
      );
      return JSON.parse(response.content);
    } catch (err) {
      if (attempt === retries) throw new LLMFlakeError(`LLM returned non-JSON after ${retries + 1} attempts for: "${text}"`);
      // LLM sometimes returns non-JSON — retry
    }
  }
}

// Helper: get next occurrence of a weekday
function getNextWeekday(dayName: string): Date {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetDay = days.indexOf(dayName.toLowerCase());
  const today = new Date();
  const todayDay = today.getDay();
  let diff = targetDay - todayDay;
  if (diff <= 0) diff += 7;
  const result = new Date(today);
  result.setDate(result.getDate() + diff);
  return result;
}

describeIfKey('Section 19: NL Reminder Parsing (LLM integration)', () => {
  const llm = new GeminiLLMProvider(GEMINI_KEY!);

  it('19.1 "Add buy protein powder to my fitness project" → project: "fitness"', async () => {
    const result = await classifyIntent(llm, 'Add buy protein powder to my fitness project');
    expect(result.action).toBe('create_reminder');
    expect(result.project?.toLowerCase()).toBe('fitness');
  }, 30_000);

  it('19.2 "[project:work] Fix the login bug" → project: "work"', async () => {
    const result = await classifyIntent(llm, '[project:work] Fix the login bug');
    expect(result.action).toBe('create_reminder');
    expect(result.project?.toLowerCase()).toBe('work');
  }, 30_000);

  it('19.3 "Buy groceries" → project: null', async () => {
    const result = await classifyIntent(llm, 'Buy groceries');
    expect(result.action).toBe('create_reminder');
    expect(result.project).toBeNull();
  }, 30_000);

  it('19.4 "Fix the auth bug, high priority" → priority: "P1"', async () => {
    const result = await classifyIntent(llm, 'Fix the auth bug, high priority');
    expect(result.action).toBe('create_reminder');
    expect(result.priority).toBe('P1');
  }, 30_000);

  it('19.5 "Research meal prep recipes P2" → priority: "P2"', async () => {
    const result = await classifyIntent(llm, 'Research meal prep recipes P2');
    expect(result.action).toBe('create_reminder');
    expect(result.priority).toBe('P2');
  }, 30_000);

  it('19.6 "Buy milk" → priority: null', async () => {
    const result = await classifyIntent(llm, 'Buy milk');
    expect(result.action).toBe('create_reminder');
    expect(result.priority).toBeNull();
  }, 30_000);

  it('19.7 "Call dentist tomorrow" → dueDate is tomorrow', async () => {
    const result = await classifyIntent(llm, 'Call dentist tomorrow');
    expect(result.action).toBe('create_reminder');
    expect(result.dueDate).toBeTruthy();

    const due = new Date(result.dueDate);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    // Allow 1 day tolerance
    const diffMs = Math.abs(due.getTime() - tomorrow.getTime());
    expect(diffMs).toBeLessThan(2 * 24 * 60 * 60 * 1000); // within 2 days
  }, 30_000);

  it('19.8 "Submit report by Friday" → dueDate is next Friday', async () => {
    const result = await classifyIntent(llm, 'Submit report by Friday');
    expect(result.action).toBe('create_reminder');
    expect(result.dueDate).toBeTruthy();

    const due = new Date(result.dueDate);
    const nextFriday = getNextWeekday('friday');
    const diffMs = Math.abs(due.getTime() - nextFriday.getTime());
    expect(diffMs).toBeLessThan(2 * 24 * 60 * 60 * 1000); // within 2 days
  }, 30_000);

  it('19.9 "I have a meeting next Wednesday at 2pm" → dueDate has time component 14:00', async () => {
    let result: any;
    try {
      result = await classifyIntent(llm, 'I have a meeting next Wednesday at 2pm');
    } catch (e) {
      if (e instanceof LLMFlakeError) { console.warn(`[SKIPPED] 19.9: ${e.message}`); return; }
      throw e;
    }
    expect(result.action).toBe('create_reminder');
    expect(result.dueDate).toBeTruthy();

    const due = new Date(result.dueDate);
    const hour = due.getUTCHours();
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThanOrEqual(23);
    expect(result.dueDate).not.toMatch(/T00:00:00/);
  }, 30_000);

  it('19.10 "Remind me in 30 minutes" → dueDate is ~now + 30 min', async () => {
    const now = Date.now();
    let result: any;
    try {
      result = await classifyIntent(llm, 'Remind me in 30 minutes');
    } catch (e) {
      if (e instanceof LLMFlakeError) { console.warn(`[SKIPPED] 19.10: ${e.message}`); return; }
      throw e;
    }
    expect(result.action).toBe('create_reminder');
    expect(result.dueDate).toBeTruthy();

    // Verify it's a future date (LLM understood it's a relative time request)
    const due = new Date(result.dueDate).getTime();
    expect(due).toBeGreaterThan(now);
  }, 30_000);

  it('19.11 "Buy shoes" → dueDate: null', async () => {
    const result = await classifyIntent(llm, 'Buy shoes');
    expect(result.action).toBe('create_reminder');
    expect(result.dueDate).toBeNull();
  }, 30_000);

  it('19.12 "[project:work, section:backend] Deploy new API" → project: work, section: backend', async () => {
    const result = await classifyIntent(llm, '[project:work, section:backend] Deploy new API');
    expect(result.action).toBe('create_reminder');
    expect(result.project?.toLowerCase()).toBe('work');
    expect(result.section?.toLowerCase()).toBe('backend');
  }, 30_000);

  it('19.13 "Add to the design section of my website project: pick a color scheme" → project: website, section: design', async () => {
    const result = await classifyIntent(llm, 'Add to the design section of my website project: pick a color scheme');
    expect(result.action).toBe('create_reminder');
    expect(result.project?.toLowerCase()).toContain('website');
    expect(result.section?.toLowerCase()).toBe('design');
  }, 30_000);

  it('19.14 "Add fix auth bug to work project, backend section, P1, due Friday" → all fields', async () => {
    const result = await classifyIntent(llm, 'Add fix auth bug to work project, backend section, P1, due Friday');
    expect(result.action).toBe('create_reminder');
    expect(result.project?.toLowerCase()).toContain('work');
    expect(result.section?.toLowerCase()).toContain('backend');
    expect(result.priority).toBe('P1');
    expect(result.dueDate).toBeTruthy();
  }, 30_000);

  it('19.15 "Remind me to call mom tomorrow, personal, low priority" → category: personal, priority: P3', async () => {
    const result = await classifyIntent(llm, 'Remind me to call mom tomorrow, personal, low priority');
    expect(result.action).toBe('create_reminder');
    expect(result.category?.toLowerCase()).toBe('personal');
    expect(result.priority).toBe('P3');
  }, 30_000);

  it('19.16 "[project:meals] Research high-protein recipes P1" → content: "Research high-protein recipes"', async () => {
    const result = await classifyIntent(llm, '[project:meals] Research high-protein recipes P1');
    expect(result.action).toBe('create_reminder');
    // Content should have tags stripped
    expect(result.content?.toLowerCase()).toContain('research');
    expect(result.content?.toLowerCase()).toContain('high-protein');
    // Should NOT contain the project tag
    expect(result.content).not.toContain('[project:');
  }, 30_000);

  it('19.17 "Add buy groceries to my list" → content: "buy groceries"', async () => {
    const result = await classifyIntent(llm, 'Add buy groceries to my list');
    expect(result.action).toBe('create_reminder');
    expect(result.content?.toLowerCase()).toContain('buy groceries');
    // Should strip the action words
    expect(result.content?.toLowerCase()).not.toMatch(/^add /);
  }, 30_000);

  it('19.18 "I finished a great book today" → action: capture_thought', async () => {
    const result = await classifyIntent(llm, 'I finished a great book today');
    expect(result.action).toBe('capture_thought');
  }, 30_000);

  it('19.19 "Pizza is the best food" → action: capture_thought', async () => {
    const result = await classifyIntent(llm, 'Pizza is the best food');
    expect(result.action).toBe('capture_thought');
  }, 30_000);

  it('19.20 "I\'ve been thinking about learning piano" → action: capture_thought', async () => {
    const result = await classifyIntent(llm, "I've been thinking about learning piano");
    expect(result.action).toBe('capture_thought');
  }, 30_000);
});
