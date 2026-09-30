import { describe, expect, it } from "vitest";
import { browserVoiceRank } from "./useBrowserTTSPlayer";

const voice = (name: string, localService = true) => ({ name, localService });

describe("browserVoiceRank", () => {
  it("puts Chrome's Google vi voices first, speaker 2 (Android default) ahead", () => {
    const names = [
      voice("Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)", false),
      voice("Microsoft An - Vietnamese (Vietnam)"),
      voice("Chrome OS Tiếng Việt 1"),
      voice("Chrome OS Tiếng Việt 2"),
      voice("Google Tiếng Việt 1 (Natural)"),
      voice("Google Tiếng Việt 2 (Natural)"),
    ]
      .sort((a, b) => browserVoiceRank(a) - browserVoiceRank(b))
      .map((v) => v.name);

    expect(names).toEqual([
      "Google Tiếng Việt 2 (Natural)",
      "Google Tiếng Việt 1 (Natural)",
      "Chrome OS Tiếng Việt 2",
      "Chrome OS Tiếng Việt 1",
      "Microsoft An - Vietnamese (Vietnam)",
      "Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)",
    ]);
  });

  it("keeps offline voices ahead of network ones", () => {
    expect(browserVoiceRank(voice("Microsoft An"))).toBeLessThan(
      browserVoiceRank(voice("Microsoft NamMinh Online (Natural)", false)),
    );
  });
});
