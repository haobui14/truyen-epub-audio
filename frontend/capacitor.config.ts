import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.truyenaudio.app",
  appName: "TruyệnAudio",
  webDir: "out",
  server: {
    androidScheme: "https",
  },
  plugins: {
    KeepAwake: {
      // Prevents the device screen from dimming/locking during TTS playback
    },
    SystemBars: {
      // The UI is always dark, so pin the bars to light (white) icons.
      // MainActivity also calls setAppearanceLight*Bars(false), but the plugin
      // re-applies its own style from a posted Runnable after onCreate returns
      // (and again on every configuration change), so on a device in system
      // light mode it would otherwise flip the icons to dark and make them
      // vanish against the dark UI. "DARK" here means "dark background".
      style: "DARK",
    },
  },
};

export default config;
