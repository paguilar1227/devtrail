import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable flag lets each test flip the runtime between web and native.
let nativePlatform = false;
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => nativePlatform },
}));

import {
  apiOrigin,
  clearServerOrigin,
  fetchCredentials,
  isNativeApp,
  normalizeServerOrigin,
  saveServerOrigin,
  storedServerOrigin,
} from './nativeConfig';

beforeEach(() => {
  nativePlatform = false;
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('normalizeServerOrigin', () => {
  it('accepts a plain https origin unchanged', () => {
    expect(normalizeServerOrigin('https://devtrail.example.com')).toBe(
      'https://devtrail.example.com',
    );
  });

  it('defaults to https when no scheme is given', () => {
    expect(normalizeServerOrigin('devtrail.example.com')).toBe('https://devtrail.example.com');
  });

  it('keeps http for local development servers', () => {
    expect(normalizeServerOrigin('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('preserves non-default ports', () => {
    expect(normalizeServerOrigin('https://host.example.com:8443')).toBe(
      'https://host.example.com:8443',
    );
  });

  it('strips paths, queries, and trailing slashes down to the origin', () => {
    expect(normalizeServerOrigin('https://host.example.com/api/v1?x=1#y')).toBe(
      'https://host.example.com',
    );
    expect(normalizeServerOrigin('https://host.example.com/')).toBe('https://host.example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeServerOrigin('  https://host.example.com  ')).toBe('https://host.example.com');
  });

  it('rejects empty and whitespace-only input', () => {
    expect(normalizeServerOrigin('')).toBeNull();
    expect(normalizeServerOrigin('   ')).toBeNull();
  });

  it('rejects non-http(s) schemes', () => {
    expect(normalizeServerOrigin('ftp://host.example.com')).toBeNull();
    expect(normalizeServerOrigin('capacitor://localhost')).toBeNull();
  });

  // Local hosts almost never speak TLS — a schemeless local entry defaults
  // to http so "localhost:3001" doesn't become an unreachable https origin.
  it('defaults schemeless LOCAL hosts to http', () => {
    expect(normalizeServerOrigin('localhost:3001')).toBe('http://localhost:3001');
    expect(normalizeServerOrigin('127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
    expect(normalizeServerOrigin('192.168.0.10:8188')).toBe('http://192.168.0.10:8188');
    expect(normalizeServerOrigin('my-laptop.local:3001')).toBe(
      'http://my-laptop.local:3001',
    );
  });

  it('keeps an explicit scheme on local hosts', () => {
    expect(normalizeServerOrigin('https://localhost:8443')).toBe('https://localhost:8443');
    expect(normalizeServerOrigin('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('rejects input that cannot become a URL', () => {
    expect(normalizeServerOrigin('http://')).toBeNull();
    expect(normalizeServerOrigin('not a url at all')).toBeNull();
  });
});

describe('origin persistence (owned by this module)', () => {
  it('round-trips save → stored', () => {
    saveServerOrigin('https://host.example.com');
    expect(storedServerOrigin()).toBe('https://host.example.com');
  });

  it('returns empty string when nothing is stored', () => {
    expect(storedServerOrigin()).toBe('');
  });

  it('clearServerOrigin removes the persisted origin', () => {
    saveServerOrigin('https://host.example.com');
    clearServerOrigin();
    expect(storedServerOrigin()).toBe('');
  });
});

describe('apiOrigin', () => {
  it('is same-origin (empty prefix) on the web even if an origin is stored', () => {
    saveServerOrigin('https://host.example.com');
    expect(apiOrigin()).toBe('');
  });

  it('uses the stored origin when running natively', () => {
    nativePlatform = true;
    saveServerOrigin('https://host.example.com');
    expect(apiOrigin()).toBe('https://host.example.com');
  });

  it('is empty natively until the connect screen stores an origin', () => {
    nativePlatform = true;
    expect(apiOrigin()).toBe('');
  });
});

describe('fetchCredentials', () => {
  it("keeps 'include' on the web so the Easy Auth cookie rides along in prod", () => {
    expect(fetchCredentials()).toBe('include');
  });

  // Regression: the backend answers CORS with Access-Control-Allow-Origin: *,
  // which browsers reject for credentialed cross-origin responses. With
  // 'include', every native API call fails after connect (empty Home on iOS).
  it("omits credentials in the native shell — Bearer key only, no cookies", () => {
    nativePlatform = true;
    expect(fetchCredentials()).toBe('omit');
  });
});

describe('isNativeApp', () => {
  it('reflects the Capacitor platform flag', () => {
    expect(isNativeApp()).toBe(false);
    nativePlatform = true;
    expect(isNativeApp()).toBe(true);
  });
});
