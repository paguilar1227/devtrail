// Thin device wrapper — the workflow lives in shared/activity-page.ts so the
// desktop and mobile projects run the identical suite (parity by construction).
import { defineActivityPageTests } from '../../shared/activity-page';

defineActivityPageTests();
