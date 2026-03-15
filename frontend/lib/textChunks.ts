/**
 * Split text into approximately `targetCount` chunks at sentence boundaries.
 * `hardMaxLen` caps each chunk's character count (TTS engine stability limit).
 *
 * Default: 20 chunks per chapter so each chunk = 5% of progress.
 * Native TTS engines handle long text well; chunking is mainly
 * for progress tracking and seek granularity.
 */
export function splitIntoChunks(
  text: string,
  targetCount = 20,
  hardMaxLen = 4000,
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
