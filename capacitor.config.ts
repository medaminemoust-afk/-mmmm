import type { CapacitorConfig } from '@capacitor/cli';

// The Vite build inlines JS, CSS, artwork and the icon into a single dist/index.html,
// so Capacitor can serve the whole app from the device with no backend.
const config: CapacitorConfig = {
  appId: 'com.vibe.music',
  appName: 'vibe.',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
