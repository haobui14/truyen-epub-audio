import type { MyBookProgressEntry } from "@/types";

/**
 * Keep the progress-list boundary honest at runtime. TypeScript's generic on
 * request() cannot protect the UI when a proxy or an older backend returns an
 * object instead of the array promised by /api/progress/my-books.
 */
export function parseMyBooksResponse(value: unknown): MyBookProgressEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Dữ liệu tiến độ không hợp lệ, vui lòng thử lại.");
  }
  return value as MyBookProgressEntry[];
}
