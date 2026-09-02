import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Native Android project — Gradle build intermediates contain JS bundles
    // (e.g. native-bridge.js) that must never be linted.
    "android/**",
    // Serwist regenerates this minified service worker on every build.
    "public/sw.js",
  ]),
  {
    // react-hooks v6 (via eslint-config-next 16.2.10) errors on the
    // "latest ref" mirror pattern (`someRef.current = prop` during render)
    // and setState-in-effect. The native player hooks use both deliberately
    // and pervasively to keep stable callbacks in sync with props/state —
    // see useNativeTTSPlayer's "Coordination refs" doc block. Mechanical
    // fixes would change timing in a carefully-tuned state machine, so keep
    // these visible as warnings instead of hard errors.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/incompatible-library": "warn",
    },
  },
  {
    files: ["app/admin/**/*.tsx"],
    // Admin forms intentionally hydrate controlled drafts when the selected
    // server record changes. They are regression-only in the Android roadmap;
    // replacing these effects would alter edit/reset semantics without a UI
    // benefit. Keep the exception scoped to admin form code.
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: [
      "hooks/useSpeechPlayer.ts",
      "hooks/useNativeTTSPlayer.ts",
      "hooks/useBrowserTTSPlayer.ts",
      "hooks/useProgressSync.ts",
      "hooks/useSleepTimer.ts",
      "context/PlayerContext.tsx",
    ],
    // These hooks implement the documented playback state-machine invariants.
    // Stable media callbacks read synchronized refs specifically to close
    // chapter-change, auto-advance, and process-restoration race windows. They
    // are covered by transition tests before any timing refactor is attempted.
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: [
      "app/books/**/listen/ListenPageClient.tsx",
      "app/books/**/read/ReadPageClient.tsx",
      "components/books/ChapterPickerSheet.tsx",
    ],
    // TanStack Virtual intentionally returns imperative measurement functions;
    // React Compiler skips only these two consumers and the lists stay
    // virtualized. This is an upstream-library compatibility boundary.
    rules: {
      "react-hooks/incompatible-library": "off",
    },
  },
]);

export default eslintConfig;
