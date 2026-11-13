import type { CapacitorConfig } from '@capacitor/cli';

// One codebase, two targets: the same `dist/` bundle Hono serves as the web
// app is what the iOS shell wraps. Which backend the native app talks to is
// runtime config (the connect screen), NOT baked into this file.
const config: CapacitorConfig = {
  appId: 'com.example.devtrail',
  appName: 'DevTrail',
  webDir: 'dist',
};

export default config;
