// Thin device wrapper — the workflow lives in shared/theme.ts so the
// desktop and mobile projects run the identical suite (parity by construction).
import { defineThemeTests } from '../../shared/theme';

defineThemeTests();
