// src/telegram/handlers.ts

export interface TelegramTextInput {
  text: string;
  chatId: string;
}

export interface TelegramPhotoInput {
  caption: string | null;
  fileId: string;
  chatId: string;
}

type CaptureFn = (input: { content: string; files: Array<{ data: Buffer; contentType: string; filename: string }>; source: string }) => Promise<{ success: boolean; captureId?: string; reason?: string; warnings?: string[] }>;
type DownloadFn = (fileId: string) => Promise<Buffer>;
type CreateReminderFn = (content: string, source: string) => Promise<{ id: string }>;
type ListRemindersFn = () => Promise<Array<{ id: string; content: string; status: string }>>;
type CompleteReminderFn = (id: string) => Promise<void>;
type AddCommentFn = (reminderId: string, content: string, source: string) => Promise<{ id: string }>;

export async function handleTextMessage(
  input: TelegramTextInput,
  capture: CaptureFn,
): Promise<{ success: boolean; captureId?: string; reason?: string; warnings?: string[] }> {
  return capture({
    content: input.text,
    files: [],
    source: 'telegram',
  });
}

export async function handleRemindCommand(
  input: TelegramTextInput,
  createReminder: CreateReminderFn,
): Promise<{ id: string; content: string }> {
  const content = input.text.replace(/^\/remind\s+/, '').trim();
  const result = await createReminder(content, 'telegram');
  return { id: result.id, content };
}

export async function handleTodosCommand(
  listReminders: ListRemindersFn,
): Promise<string> {
  const reminders = await listReminders();
  if (reminders.length === 0) return 'No active reminders.';

  return reminders
    .map((r, i) => `${i + 1}. [${r.status}] ${r.content} (${r.id.slice(0, 8)})`)
    .join('\n');
}

export async function handleDoneCommand(
  reminderId: string,
  completeReminder: CompleteReminderFn,
): Promise<void> {
  await completeReminder(reminderId);
}

export async function handleCommentCommand(
  input: TelegramTextInput,
  addComment: AddCommentFn,
): Promise<{ id: string; reminderId: string; content: string }> {
  // Format: /comment <id> <text>
  const withoutCmd = input.text.replace(/^\/comment\s+/, '').trim();
  const spaceIdx = withoutCmd.indexOf(' ');
  if (spaceIdx === -1) {
    throw new Error('Usage: /comment <id> <text>');
  }
  const reminderId = withoutCmd.slice(0, spaceIdx).trim();
  const content = withoutCmd.slice(spaceIdx + 1).trim();
  if (!content) {
    throw new Error('Usage: /comment <id> <text>');
  }
  const result = await addComment(reminderId, content, 'telegram');
  return { id: result.id, reminderId, content };
}

export async function handlePhotoMessage(
  input: TelegramPhotoInput,
  capture: CaptureFn,
  downloadFile: DownloadFn,
): Promise<{ success: boolean; captureId?: string; reason?: string; warnings?: string[] }> {
  const photoBuffer = await downloadFile(input.fileId);

  return capture({
    content: input.caption ?? 'Photo capture',
    files: [{ data: photoBuffer, contentType: 'image/jpeg', filename: `${input.fileId}.jpg` }],
    source: 'telegram',
  });
}

export async function handleVoiceMessage(
  input: { fileId: string; chatId: string },
  capture: CaptureFn,
  downloadFile: DownloadFn,
  transcribe: (audio: Buffer) => Promise<string>,
): Promise<{ success: boolean; captureId?: string; reason?: string; warnings?: string[] }> {
  const audioBuffer = await downloadFile(input.fileId);
  const transcription = await transcribe(audioBuffer);

  return capture({
    content: transcription,
    files: [{ data: audioBuffer, contentType: 'audio/ogg', filename: `${input.fileId}.ogg` }],
    source: 'telegram',
  });
}

export async function handleDocumentMessage(
  input: { fileId: string; fileName: string; mimeType: string; chatId: string },
  capture: CaptureFn,
  downloadFile: DownloadFn,
  summarize: (content: Buffer, mimeType: string) => Promise<string>,
): Promise<{ success: boolean; captureId?: string; reason?: string; warnings?: string[] }> {
  const fileBuffer = await downloadFile(input.fileId);
  const summary = await summarize(fileBuffer, input.mimeType);

  return capture({
    content: summary,
    files: [{ data: fileBuffer, contentType: input.mimeType, filename: input.fileName }],
    source: 'telegram',
  });
}
