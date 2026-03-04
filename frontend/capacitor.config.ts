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
  },
};

export default config;
