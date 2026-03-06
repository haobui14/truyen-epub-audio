"use client";
import { useState, useRef, useEffect } from "react";
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

/** Small pill tag for displaying a genre */
export function GenreTag({ genre, onRemove }: { genre: Pick<Genre, "name" | "color">; onRemove?: () => void }) {
  const c = getColorClasses(genre.color);
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      {genre.name}
      {onRemove && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
          className="ml-0.5 hover:opacity-70 transition-opacity leading-none"
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
  assignedGenres: Genre[];
}

export function GenreManager({ bookId, assignedGenres }: GenreManagerProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<ColorKey>("indigo");
  const [createError, setCreateError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState<ColorKey>("indigo");
  const panelRef = useRef<HTMLDivElement>(null);

  const { data: allGenres = [], isLoading } = useQuery({
    queryKey: ["genres"],
    queryFn: api.listGenres,
    enabled: open,
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["book", bookId] });
    qc.invalidateQueries({ queryKey: ["books"] });
    qc.invalidateQueries({ queryKey: ["genres"] });
  };

  const assignMutation = useMutation({
    mutationFn: (genreId: string) => api.assignGenre(bookId, genreId),
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: (genreId: string) => api.removeGenre(bookId, genreId),
    onSuccess: invalidate,
  });

  const createMutation = useMutation({
    mutationFn: () => api.createGenre(newName.trim(), newColor),
    onSuccess: (genre) => {
      invalidate();
      setNewName("");
      setNewColor("indigo");
      setCreateError("");
      setShowCreate(false);
      // Immediately assign the new genre to this book
      assignMutation.mutate(genre.id);
    },
    onError: (err: Error) => {
      setCreateError(err.message.includes("409") ? "Tên thể loại đã tồn tại" : "Không thể tạo thể loại");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, name, color }: { id: string; name: string; color: string }) =>
      api.updateGenre(id, { name, color }),
    onSuccess: () => { invalidate(); setEditingId(null); },
  });

  const deleteGenreMutation = useMutation({
    mutationFn: (genreId: string) => api.deleteGenre(genreId),
    onSuccess: invalidate,
  });

  const assignedIds = new Set(assignedGenres.map((g) => g.id));
  const unassigned = allGenres.filter((g) => !assignedIds.has(g.id));

  return (
    <div className="relative" ref={panelRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
        Thể loại
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-72 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Quản lý thể loại</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-0.5">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Assigned genres */}
          {assignedGenres.length > 0 && (
            <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
              <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1.5">Đã gán</p>
              <div className="flex flex-wrap gap-1.5">
                {assignedGenres.map((g) => (
                  <GenreTag
                    key={g.id}
                    genre={g}
                    onRemove={() => removeMutation.mutate(g.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Available (unassigned) genres */}
          <div className="px-3 py-2 max-h-52 overflow-y-auto">
            {isLoading ? (
              <p className="text-xs text-gray-400 py-2 text-center">Đang tải...</p>
            ) : unassigned.length === 0 && !showCreate ? (
              <p className="text-xs text-gray-400 py-2 text-center">Chưa có thể loại nào</p>
            ) : (
              <div className="space-y-0.5">
                {unassigned.map((g) => (
                  <div key={g.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    {editingId === g.id ? (
                      <form
                        className="flex-1 flex flex-col gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          updateMutation.mutate({ id: g.id, name: editName, color: editColor });
                        }}
                      >
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full text-xs px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <ColorPicker value={editColor} onChange={setEditColor} />
                        <div className="flex gap-1 mt-0.5">
                          <button type="submit" className="text-xs px-2 py-0.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700">Lưu</button>
                          <button type="button" onClick={() => setEditingId(null)} className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-md">Hủy</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <button
                          onClick={() => assignMutation.mutate(g.id)}
                          className="flex-1 flex items-center gap-2 text-left"
                        >
                          <span className={`w-2 h-2 rounded-full shrink-0 ${getColorClasses(g.color).dot}`} />
                          <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{g.name}</span>
                        </button>
                        <div className="hidden group-hover:flex items-center gap-0.5">
                          <button
                            onClick={() => { setEditingId(g.id); setEditName(g.name); setEditColor(g.color as ColorKey); }}
                            className="p-1 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 rounded"
                            title="Sửa"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => deleteGenreMutation.mutate(g.id)}
                            className="p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded"
                            title="Xóa thể loại"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Create new genre form */}
          <div className="px-3 pb-3 pt-1 border-t border-gray-100 dark:border-gray-700">
            {showCreate ? (
              <form
                className="space-y-2"
                onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }}
              >
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setCreateError(""); }}
                  placeholder="Tên thể loại..."
                  maxLength={50}
                  className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <ColorPicker value={newColor} onChange={setNewColor} />
                {createError && <p className="text-xs text-red-500">{createError}</p>}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={!newName.trim() || createMutation.isPending}
                    className="flex-1 text-sm py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium"
                  >
                    {createMutation.isPending ? "Đang tạo..." : "Tạo & gán"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setNewName(""); setCreateError(""); }}
                    className="text-sm px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
                  >
                    Hủy
                  </button>
                </div>
              </form>
            ) : (
              <button
                onClick={() => setShowCreate(true)}
                className="w-full flex items-center justify-center gap-1.5 text-sm text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 py-1.5 rounded-lg transition-colors font-medium"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Tạo thể loại mới
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: ColorKey; onChange: (c: ColorKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_OPTIONS.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.key)}
          className={`w-5 h-5 rounded-full ${c.dot} transition-transform ${value === c.key ? "ring-2 ring-offset-1 ring-gray-400 scale-110" : "hover:scale-110"}`}
          title={c.key}
        />
      ))}
    </div>
  );
}
