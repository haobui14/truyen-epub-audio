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
]);

export default eslintConfig;
