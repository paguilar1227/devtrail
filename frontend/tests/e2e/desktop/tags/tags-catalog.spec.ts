// Thin device wrapper — the workflow lives in shared/tags.ts so the
// desktop and mobile projects run the identical suite (parity by construction).
import { defineTagsTests } from '../../shared/tags';

defineTagsTests();
