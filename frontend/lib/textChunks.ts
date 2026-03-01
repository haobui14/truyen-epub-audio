/**
 * Split text into approximately `targetCount` chunks at sentence boundaries.
 * `hardMaxLen` caps each chunk's character count (TTS engine stability limit).
 *
 * With targetCount = 20 each chunk is ~5% of the chapter, so ±1 chunk
 * buttons give clean 5% forward/backward seek controls.
 */
export function splitIntoChunks(
  text: string,
  targetCount = 20,
  hardMaxLen = 600,
): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) ?? [text];
  // Target size: evenly divide total length, but never below 50 chars per chunk
  const softMaxLen = Math.max(Math.ceil(text.length / targetCount), 50);
  const maxLen = Math.min(softMaxLen, hardMaxLen);

  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length > maxLen && cur.length > 0) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}
