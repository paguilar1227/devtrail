import { describe, it, expect } from 'vitest';
import { ALLOWED_TAGS, validateTags, isValidTag, TAG_DESCRIPTIONS } from '../../../src/capture/tags.js';

describe('tag allowlist', () => {
  it('has exactly 14 tags', () => {
    expect(ALLOWED_TAGS).toHaveLength(14);
  });

  it('has a description for every tag', () => {
    for (const tag of ALLOWED_TAGS) {
      expect(TAG_DESCRIPTIONS[tag]).toBeDefined();
      expect(typeof TAG_DESCRIPTIONS[tag]).toBe('string');
    }
  });
});

describe('isValidTag', () => {
  it('accepts all allowed tags', () => {
    for (const tag of ALLOWED_TAGS) {
      expect(isValidTag(tag)).toBe(true);
    }
  });

  it('rejects unknown tag', () => {
    expect(isValidTag('foobar')).toBe(false);
  });

  it('rejects wrong case', () => {
    expect(isValidTag('Preference')).toBe(false);
    expect(isValidTag('DECISION')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidTag('')).toBe(false);
  });
});

describe('validateTags', () => {
  it('returns all valid tags unchanged', () => {
    expect(validateTags(['preference', 'skill'])).toEqual(['preference', 'skill']);
  });

  it('filters out invalid tags', () => {
    expect(validateTags(['preference', 'bogus', 'skill'])).toEqual(['preference', 'skill']);
  });

  it('deduplicates tags', () => {
    expect(validateTags(['preference', 'preference', 'skill'])).toEqual(['preference', 'skill']);
  });

  it('returns empty array for all invalid', () => {
    expect(validateTags(['bogus', 'invalid'])).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(validateTags([])).toEqual([]);
  });
});
