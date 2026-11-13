import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

const respond = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubEnv('VITE_DEVTRAIL_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('bootAuth on the web', () => {
  it('asks for the API key when the server has no Easy Auth token exchange', async () => {
    respond(404, { error: 'Not found' });
    const api = await import('./api');
    await expect(api.bootAuth()).rejects.toBeInstanceOf(api.ApiKeyRequired);
  });

  it('stores the exchanged key and remembers Easy Auth mode for sign-out', async () => {
    respond(200, { key: 'exchanged-key', principalId: 'p', principalName: 'n' });
    const api = await import('./api');
    await api.bootAuth();
    expect(localStorage.getItem('devtrail.api_key')).toBe('exchanged-key');
    expect(localStorage.getItem('devtrail.auth_mode')).toBe('easyauth');
    expect(api.signedInAccount()).toEqual({ name: 'n', detail: 'Microsoft Entra ID' });
  });

  it('ignores a build-time dev key outside the Vite dev server', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DEVTRAIL_API_KEY', 'baked-into-bundle');
    respond(404, { error: 'Not found' });
    const api = await import('./api');
    await expect(api.bootAuth()).rejects.toBeInstanceOf(api.ApiKeyRequired);
  });
});
