// Thin device wrapper — the workflow lives in shared/project-chat.ts so the
// desktop and mobile projects run the identical suite (parity by construction).
import { defineProjectChatTests } from '../../shared/project-chat';

defineProjectChatTests();
