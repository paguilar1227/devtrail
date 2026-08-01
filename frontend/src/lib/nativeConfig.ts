// frontend/src/lib/nativeConfig.ts
//
// Runtime configuration for the native (Capacitor) shell.
//
// On the web the SPA is served by the same Hono process that hosts the API,
// so every request uses same-origin relative URLs. Inside the iOS app the
// bundle loads from capacitor://localhost — there is no same origin — so the
// API origin is configured once on the connect screen and persisted in
// localStorage (WKWebView keeps it per install).

import { Capacitor } from '@capacitor/core';

// Not exported on purpose: this module OWNS origin persistence. Callers use
// saveServerOrigin / clearServerOrigin / storedServerOrigin.
const SERVER_ORIGIN_STORAGE_KEY = 'ob.server_origin';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

// Hosts where a schemeless entry should default to http:// — a local dev
// server ("localhost:3001", a LAN IP, a .local mDNS name) almost never
// speaks TLS, and defaulting it to https just yields a misleading
// "could not reach the server".
function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    /^127\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname)
  );
}

// Normalize user input into an origin usable as a URL prefix: default to
// https:// when no scheme is given (http:// for local hosts), drop any
// path/query/hash. Returns null for input that can't become an http(s)
// origin.
export function normalizeServerOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hadScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (!hadScheme && isLocalHostname(url.hostname)) {
    url = new URL(url.origin.replace(/^https:/, 'http:'));
  }
  return url.origin;
}

export function storedServerOrigin(): string {
  try {
    return localStorage.getItem(SERVER_ORIGIN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveServerOrigin(origin: string): void {
  localStorage.setItem(SERVER_ORIGIN_STORAGE_KEY, origin);
}

export function clearServerOrigin(): void {
  try {
    localStorage.removeItem(SERVER_ORIGIN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// Prefix for every API path. Web: '' (same-origin). Native: the configured
// server origin — still '' until the connect screen stores one.
export function apiOrigin(): string {
  return isNativeApp() ? storedServerOrigin() : '';
}

// Credentials mode for API fetches. Web needs 'include' so the Easy Auth
// session cookie rides along in prod. The native shell authenticates with
// the Bearer key alone — and MUST NOT send credentials: the backend answers
// CORS with `Access-Control-Allow-Origin: *`, which browsers reject for
// credentialed cross-origin responses, failing every request. (Bug found in
// the iOS simulator on first connect: Home rendered empty because each list
// query was killed by exactly this rule.)
export function fetchCredentials(): RequestCredentials {
  return isNativeApp() ? 'omit' : 'include';
}
