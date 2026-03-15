// src/notifications/digest.ts

export interface DigestData {
  capturesProcessed: number;
  factsCreated: number;
  factsUpdated: number;
  insightsCreated: number;
  pendingReview: number;
  activeReminders: number;
  completedToday: number;
}

export function formatDailyDigest(data: DigestData): string {
  // Matches spec digest format with emojis
  const lines = [
    '\u{1F9E0} Open Brain Daily Digest',
    `Processed: ${data.capturesProcessed} captures`,
    `Facts created: ${data.factsCreated} | Updated: ${data.factsUpdated}`,
    `Insights created: ${data.insightsCreated}`,
  ];

  if (data.pendingReview > 0) {
    lines.push(`\u26A1 ${data.pendingReview} items need your review`);
  }

  lines.push('');
  lines.push(`\u{1F4CB} Reminders: ${data.activeReminders} active | ${data.completedToday} completed today`);

  if (data.pendingReview > 0) {
    lines.push('Tap /review to see pending items');
  }
  lines.push('Tap /todos to see your reminders');

  return lines.join('\n');
}

export async function sendDigestViaTelegram(
  sendMessage: (chatId: string, text: string, options: Record<string, unknown>) => Promise<unknown>,
  chatId: string,
  message: string,
): Promise<void> {
  await sendMessage(chatId, message, { parse_mode: 'Markdown' });
}
