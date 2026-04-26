// One-shot: send the same m4a bytes to Gemini under different mime types
// to find one that actually triggers transcription. No deploy, no DB write.
//
// Usage: npx tsx scripts/diagnostics/test-gemini-audio-mime.ts <path-to-audio>
import { readFileSync } from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { execSync } from 'child_process';

const path = process.argv[2];
if (!path) { console.error('usage: tsx test-gemini-audio-mime.ts <audio-file>'); process.exit(1); }

const apiKey = execSync(
  'az keyvault secret show --vault-name your-keyvault --name google-ai-studio-api-key --query value -o tsv',
  { encoding: 'utf-8' }
).trim();

const bytes = readFileSync(path);
console.log(`Loaded ${bytes.length} bytes from ${path}`);

const client = new GoogleGenerativeAI(apiKey);

// Mirror production's extractMetadata call exactly: same model, same system
// instruction, same generation config (JSON mode + 8192 maxTokens), same
// message shape (text part labelled "(no text content)" + inlineData).
const SYSTEM_PROMPT = `You analyze a piece of content (text + attached media) and produce structured metadata for a personal knowledge base.

Return JSON with these fields:
- title: a short, descriptive title (max 80 chars) capturing the essence of the content. For media files, describe what they show. Never return an empty title.
- topics: array of topics/subjects discussed (max 10)
- tags: array of flat organizational labels (max 5). Examples: "reference", "meeting-notes", "recipe", "coding", "research". Use lowercase kebab-case. These are flexible — pick what would help the user find this later.
- extracted_text: if media files contain clearly legible text (documents, signs, whiteboards, printed/handwritten text, captions in images), extract ALL of it verbatim. For audio/video, transcribe speech. Return null if media doesn't contain readable text (photos of people, animals, scenery, food, objects, etc.). Do NOT hallucinate text that isn't clearly there.
- published_at: ISO-8601 datetime if the content has an EXPLICIT publication or creation date visible in the text. Use null for: user's own notes, content with no visible date, dates that only refer to events within the content (not the publication itself).

Return ONLY valid JSON, no markdown formatting.`;

const candidates = ['audio/mp4', 'audio/aac', 'audio/wav'];
const modes: Array<{label: string; jsonMode: boolean}> = [
  { label: 'plain (raw transcript prompt)', jsonMode: false },
  { label: 'production-equivalent (JSON mode + extraction prompt)', jsonMode: true },
];

for (const mode of modes) {
  console.log(`\n========== ${mode.label} ==========`);
  for (const mime of candidates) {
    process.stdout.write(`\n=== mime: ${mime}\n`);
    try {
      const model = client.getGenerativeModel({
        model: 'gemini-3-flash-preview',
        ...(mode.jsonMode && { systemInstruction: SYSTEM_PROMPT }),
        ...(mode.jsonMode && {
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 8192,
          },
        }),
      });
      const userText = mode.jsonMode ? '(no text content)' : 'Transcribe the speech in this audio file verbatim. Return only the transcript text, no preamble.';
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: userText },
            { inlineData: { data: bytes.toString('base64'), mimeType: mime } },
          ],
        }],
      });
      const text = result.response.text();
      const usage = result.response.usageMetadata;
      console.log(`  ok — ${text.length} chars, tokens in/out=${usage?.promptTokenCount ?? '?'}/${usage?.candidatesTokenCount ?? '?'}`);
      if (mode.jsonMode) {
        try {
          const parsed = JSON.parse(text);
          const et = typeof parsed.extracted_text === 'string' ? parsed.extracted_text : null;
          console.log(`  parsed.title="${parsed.title ?? '(missing)'}"`);
          console.log(`  parsed.extracted_text=${et ? `${et.length} chars: "${et.slice(0,160).replace(/\n/g,' ')}..."` : '(null/missing)'}`);
        } catch {
          console.log(`  raw preview: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
        }
      } else {
        console.log(`  preview: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
      }
    } catch (err: any) {
      console.log(`  err: ${err.message?.slice(0, 200) ?? err}`);
    }
  }
}
