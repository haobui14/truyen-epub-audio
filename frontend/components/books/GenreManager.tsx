"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Genre } from "@/types";

const COLOR_OPTIONS = [
  { key: "indigo", bg: "bg-indigo-100 dark:bg-indigo-900/40", text: "text-indigo-700 dark:text-indigo-300", dot: "bg-indigo-500" },
  { key: "purple", bg: "bg-purple-100 dark:bg-purple-900/40", text: "text-purple-700 dark:text-purple-300", dot: "bg-purple-500" },
  { key: "pink",   bg: "bg-pink-100 dark:bg-pink-900/40",     text: "text-pink-700 dark:text-pink-300",     dot: "bg-pink-500" },
  { key: "rose",   bg: "bg-rose-100 dark:bg-rose-900/40",     text: "text-rose-700 dark:text-rose-300",     dot: "bg-rose-500" },
  { key: "red",    bg: "bg-red-100 dark:bg-red-900/40",       text: "text-red-700 dark:text-red-300",       dot: "bg-red-500" },
  { key: "orange", bg: "bg-orange-100 dark:bg-orange-900/40", text: "text-orange-700 dark:text-orange-300", dot: "bg-orange-500" },
  { key: "amber",  bg: "bg-amber-100 dark:bg-amber-900/40",   text: "text-amber-700 dark:text-amber-300",   dot: "bg-amber-500" },
  { key: "yellow", bg: "bg-yellow-100 dark:bg-yellow-900/40", text: "text-yellow-700 dark:text-yellow-300", dot: "bg-yellow-500" },
  { key: "green",  bg: "bg-green-100 dark:bg-green-900/40",   text: "text-green-700 dark:text-green-300",   dot: "bg-green-500" },
  { key: "teal",   bg: "bg-teal-100 dark:bg-teal-900/40",     text: "text-teal-700 dark:text-teal-300",     dot: "bg-teal-500" },
  { key: "cyan",   bg: "bg-cyan-100 dark:bg-cyan-900/40",     text: "text-cyan-700 dark:text-cyan-300",     dot: "bg-cyan-500" },
  { key: "blue",   bg: "bg-blue-100 dark:bg-blue-900/40",     text: "text-blue-700 dark:text-blue-300",     dot: "bg-blue-500" },
  { key: "gray",   bg: "bg-gray-100 dark:bg-gray-700",        text: "text-gray-700 dark:text-gray-300",     dot: "bg-gray-500" },
] as const;

export type ColorKey = typeof COLOR_OPTIONS[number]["key"];

export function getColorClasses(color: string) {
  return COLOR_OPTIONS.find((c) => c.key === color) ?? COLOR_OPTIONS[0];
}

function ColorPicker({ value, onChange }: { value: ColorKey; onChange: (c: ColorKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_OPTIONS.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.key)}
          className={`w-7 h-7 rounded-full cursor-pointer ${c.dot} transition-transform ${value === c.key ? "ring-2 ring-offset-2 ring-gray-500 dark:ring-gray-300 scale-110" : "opacity-60 hover:opacity-100 active:scale-95"}`}
          title={c.key}
        />
      ))}
    </div>
  );
}

/** Small pill tag for displaying a genre */
export function GenreTag({ genre, onRemove }: { genre: Pick<Genre, "name" | "color">; onRemove?: () => void }) {
  const c = getColorClasses(genre.color);
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      {genre.name}
      {onRemove && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
          className="ml-0.5 cursor-pointer hover:opacity-70 active:opacity-50 transition-opacity leading-none p-0.5"
          aria-label={`Remove ${genre.name}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

interface GenreManagerProps {
  bookId: string;
}

export function GenreManager({ bookId }: GenreManagerProps) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<ColorKey>("indigo");
  const [createError, setCreateError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState<ColorKey>("indigo");
  const [isManaging, setIsManaging] = useState(false);

  // Seed assigned IDs synchronously from the already-cached book data.
  // The parent (EditBookClient) fetches the book before rendering this component,
  // so the cache is always populated. Using a lazy initializer means this runs
  // exactly once on mount and is never affected by background refetches.
  const [assignedIds, setAssignedIds] = useState<Set<string>>(() => {
    const cached = qc.getQueryData<{ genres?: Genre[] }>(["book", bookId]);
    return new Set((cached?.genres ?? []).map((g) => g.id));
  });

  // Keep a local map of id→genre so we can render assigned tags even before
  // allGenres loads, and for newly-created genres not yet in the server list.
  const [localGenreMap, setLocalGenreMap] = useState<Record<string, Genre>>(() => {
    const cached = qc.getQueryData<{ genres?: Genre[] }>(["book", bookId]);
    return Object.fromEntries((cached?.genres ?? []).map((g) => [g.id, g]));
  });

  const { data: allGenres = [], isLoading } = useQuery({
    queryKey: ["genres"],
    queryFn: api.listGenres,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["book", bookId] });
    qc.invalidateQueries({ queryKey: ["books"] });
    qc.invalidateQueries({ queryKey: ["genres"] });
  };

  function handleAssign(genreId: string) {
    setAssignedIds((prev) => new Set([...prev, genreId]));
    // Ensure we have the genre object for rendering
    const genre = allGenres.find((g) => g.id === genreId);
    if (genre) setLocalGenreMap((prev) => ({ ...prev, [genreId]: genre }));
    api.assignGenre(bookId, genreId).catch(() => {
      setAssignedIds((prev) => { const next = new Set(prev); next.delete(genreId); return next; });
    });
  }

  function handleRemove(genreId: string) {
    setAssignedIds((prev) => { const next = new Set(prev); next.delete(genreId); return next; });
    api.removeGenre(bookId, genreId).catch(() => {
      setAssignedIds((prev) => new Set([...prev, genreId]));
    });
  }

  const createMutation = useMutation({
    mutationFn: () => api.createGenre(newName.trim(), newColor),
    onSuccess: (genre) => {
      setNewName("");
      setNewColor("indigo");
      setCreateError("");
      setShowCreate(false);
      // Add new genre to allGenres cache and local map immediately
      qc.setQueryData(["genres"], (old: Genre[] | undefined) =>
        old ? [...old, genre] : [genre],
      );
      setLocalGenreMap((prev) => ({ ...prev, [genre.id]: genre }));
      setAssignedIds((prev) => new Set([...prev, genre.id]));
      api.assignGenre(bookId, genre.id).then(invalidateAll);
    },
    onError: (err: Error) => {
      setCreateError(err.message.includes("409") ? "Tên thể loại đã tồn tại" : "Không thể tạo thể loại");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, name, color }: { id: string; name: string; color: string }) =>
      api.updateGenre(id, { name, color }),
    onSuccess: () => { invalidateAll(); setEditingId(null); },
  });

  const deleteGenreMutation = useMutation({
    mutationFn: (genreId: string) => api.deleteGenre(genreId),
    onMutate: (genreId) => {
      setAssignedIds((prev) => { const next = new Set(prev); next.delete(genreId); return next; });
    },
    onSuccess: invalidateAll,
  });

  // Render the assigned section from localGenreMap (always up-to-date, never affected by refetches)
  const mergedGenreMap = { ...localGenreMap, ...Object.fromEntries(allGenres.map((g) => [g.id, g])) };
  const assignedGenreObjects = [...assignedIds]
    .map((id) => mergedGenreMap[id])
    .filter(Boolean) as Genre[];

  return (
    <div className="space-y-4">
      {/* Assigned genres */}
      <div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Đã gán cho truyện này</p>
        {assignedIds.size === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 italic">Chưa gán thể loại nào</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {assignedGenreObjects.map((g) => (
              <GenreTag key={g.id} genre={g} onRemove={() => handleRemove(g.id)} />
            ))}
          </div>
        )}
      </div>

      {/* All genres — click to toggle assign; manage mode reveals edit/delete */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Tất cả thể loại</p>
          {allGenres.length > 0 && !isLoading && (
            <button
              type="button"
              onClick={() => { setIsManaging((v) => !v); setEditingId(null); }}
              className={`inline-flex items-center gap-1 text-xs font-medium cursor-pointer transition-colors ${
                isManaging
                  ? "text-indigo-600 dark:text-indigo-400 hover:text-indigo-700"
                  : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
              }`}
            >
              {isManaging ? (
                <>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Xong
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  Quản lý
                </>
              )}
            </button>
          )}
        </div>
        {isLoading ? (
          <p className="text-xs text-gray-400">Đang tải...</p>
        ) : allGenres.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 italic">Chưa có thể loại nào</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {allGenres.map((g) => {
              const isAssigned = assignedIds.has(g.id);
              const c = getColorClasses(g.color);
              if (editingId === g.id) {
                return (
                  <form
                    key={g.id}
                    className="flex flex-col gap-2 p-3 rounded-xl border border-indigo-300 dark:border-indigo-700 bg-gray-50 dark:bg-gray-900 w-full sm:w-72"
                    onSubmit={(e) => {
                      e.preventDefault();
                      updateMutation.mutate({ id: g.id, name: editName, color: editColor });
                    }}
                  >
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <ColorPicker value={editColor} onChange={setEditColor} />
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={updateMutation.isPending}
                        className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer font-medium"
                      >
                        {updateMutation.isPending ? "Đang lưu..." : "Lưu"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg cursor-pointer"
                      >
                        Hủy
                      </button>
                    </div>
                  </form>
                );
              }
              return (
                <div key={g.id} className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => !isManaging && (isAssigned ? handleRemove(g.id) : handleAssign(g.id))}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                      isManaging
                        ? "cursor-default"
                        : "cursor-pointer"
                    } ${
                      isAssigned
                        ? `${c.bg} ${c.text} border-transparent ring-2 ring-offset-1 ring-current`
                        : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500"
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.dot}`} />
                    {g.name}
                    {isAssigned && !isManaging && <span className="ml-0.5 opacity-60">✓</span>}
                  </button>
                  {isManaging && (
                    <>
                      <button
                        type="button"
                        onClick={() => { setEditingId(g.id); setEditName(g.name); setEditColor(g.color as ColorKey); }}
                        className="p-2 cursor-pointer text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 active:text-indigo-700 transition-colors rounded"
                        title="Sửa"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => { if (confirm(`Xóa thể loại "${g.name}"?`)) deleteGenreMutation.mutate(g.id); }}
                        className="p-2 cursor-pointer text-gray-400 hover:text-red-600 dark:hover:text-red-400 active:text-red-700 transition-colors rounded"
                        title="Xóa"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create new genre */}
      {showCreate ? (
        <form
          className="flex flex-col gap-2.5 p-4 rounded-xl border border-dashed border-indigo-300 dark:border-indigo-700 bg-indigo-50/30 dark:bg-indigo-950/20"
          onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }}
        >
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Thể loại mới</p>
          <input
            autoFocus
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setCreateError(""); }}
            placeholder="Tên thể loại..."
            maxLength={50}
            className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <ColorPicker value={newColor} onChange={setNewColor} />
          {createError && <p className="text-xs text-red-500">{createError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!newName.trim() || createMutation.isPending}
              className="text-sm px-4 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer font-medium"
            >
              {createMutation.isPending ? "Đang tạo..." : "Tạo & gán"}
            </button>
            <button
              type="button"
              onClick={() => { setShowCreate(false); setNewName(""); setCreateError(""); }}
              className="text-sm px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer"
            >
              Hủy
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Tạo thể loại mới
        </button>
      )}
    </div>
  );
}
