"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isAdmin, isAuthReady } from "@/lib/auth";
import { Spinner } from "@/components/ui/Spinner";
import type { Book } from "@/types";

// Preset label options for the spotlight badge
const LABEL_PRESETS = [
  { value: "Weekly Star", label: "⭐ Weekly Star" },
  { value: "Hot", label: "🔥 Hot" },
  { value: "Mới", label: "🆕 Mới" },
  { value: "Đề xuất", label: "👍 Đề xuất" },
  { value: "Nổi bật", label: "✨ Nổi bật" },
];

function BookRow({
  book,
  onFeature,
}: {
  book: Book;
  onFeature: (b: Book) => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 sm:gap-4 px-4 py-3 rounded-xl border transition-colors ${
        book.is_featured
          ? "bg-gold/10 dark:bg-gold/30 border-gold/30 dark:border-gold/30"
          : "bg-surface dark:bg-raised border-hairline-soft dark:border-hairline/60"
      }`}
    >
      {/* Cover thumbnail */}
      <div className="flex-none w-10 h-14 rounded-lg overflow-hidden bg-accent/15 dark:bg-accent/40 relative">
        {book.cover_url ? (
          <Image
            src={book.cover_url}
            alt={book.title}
            fill
            className="object-cover"
            sizes="40px"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg
              className="w-5 h-5 text-accent"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
              />
            </svg>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-text dark:text-text truncate max-w-45 sm:max-w-xs">
            {book.title}
          </span>
          {book.is_featured && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gold/15 dark:bg-amber-900/50 text-gold dark:text-gold flex-none">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              {book.featured_label ?? "Nổi bật"}
            </span>
          )}
        </div>
        <p className="text-xs text-text-mute dark:text-text-mute truncate mt-0.5">
          {book.author ?? "—"} · {book.total_chapters} chương
        </p>
        {book.status === "error" && (
          <Link
            href={`/admin/edit-book?id=${book.id}`}
            className="inline-flex items-center gap-1 mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-vermillion/10 dark:bg-vermillion/20 text-vermillion hover:bg-vermillion/20 transition-colors"
            title={book.error_message ?? "Phân tích thất bại"}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            Lỗi · sửa
          </Link>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-none">
        <Link
          href={`/admin/edit-book?id=${book.id}`}
          className="p-1.5 rounded-lg text-text-mute hover:text-accent dark:hover:text-accent hover:bg-accent/15 dark:hover:bg-accent/40 transition-colors"
          title="Chỉnh sửa"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        </Link>
        <button
          onClick={() => onFeature(book)}
          className={`p-1.5 rounded-lg transition-colors ${
            book.is_featured
              ? "text-gold bg-gold/15 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/60"
              : "text-text-mute hover:text-gold hover:bg-gold/10 dark:hover:bg-gold/30"
          }`}
          title={book.is_featured ? "Bỏ spotlight" : "Đặt làm spotlight"}
        >
          <svg
            className="w-4 h-4"
            fill={book.is_featured ? "currentColor" : "none"}
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

// Modal for picking spotlight label
function FeatureModal({
  book,
  onConfirm,
  onClose,
}: {
  book: Book;
  onConfirm: (label: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(book.featured_label ?? "Weekly Star");
  const [custom, setCustom] = useState(
    !LABEL_PRESETS.some(
      (p) => p.value === (book.featured_label ?? "Weekly Star"),
    ),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full sm:max-w-sm mx-auto bg-surface dark:bg-surface rounded-t-2xl sm:rounded-2xl shadow-2xl px-5 py-6 animate-in">
        <h3 className="text-base font-semibold text-text dark:text-text mb-1">
          Đặt spotlight
        </h3>
        <p className="text-sm text-text-mute dark:text-text-mute mb-4 line-clamp-1">
          {book.title}
        </p>

        {/* Preset chips */}
        <div className="flex flex-wrap gap-2 mb-4">
          {LABEL_PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => {
                setLabel(p.value);
                setCustom(false);
              }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                !custom && label === p.value
                  ? "bg-gold text-white border-amber-500"
                  : "border-hairline-soft dark:border-hairline text-text-dim dark:text-text-mute hover:border-amber-400 hover:text-gold"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setCustom(true)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
              custom
                ? "bg-accent text-white border-accent"
                : "border-hairline-soft dark:border-hairline text-text-dim dark:text-text-mute hover:border-accent/40 hover:text-accent"
            }`}
          >
            Tùy chỉnh…
          </button>
        </div>

        {/* Custom label input */}
        {custom && (
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Nhập nhãn tùy chỉnh…"
            maxLength={30}
            className="w-full mb-4 px-3.5 py-2.5 text-sm rounded-xl border border-hairline-soft dark:border-hairline bg-surface dark:bg-raised text-text dark:text-text placeholder-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition"
          />
        )}

        <div className="flex gap-3">
          <button
            onClick={() => onConfirm(label.trim() || "Nổi bật")}
            className="flex-1 bg-gold hover:bg-amber-400 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
          >
            Xác nhận
          </button>
          <button
            onClick={onClose}
            className="flex-1 border border-hairline-soft dark:border-hairline text-text-dim dark:text-text-faint font-medium py-2.5 rounded-xl text-sm hover:bg-ink dark:hover:bg-raised transition-colors"
          >
            Hủy
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ManageBooksClient() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [featureTarget, setFeatureTarget] = useState<Book | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Android-safe admin guard
  useEffect(() => {
    const checkAdmin = () => {
      if (!isAdmin()) router.replace("/");
    };
    if (isAuthReady()) {
      checkAdmin();
    } else {
      window.addEventListener("auth-change", checkAdmin, { once: true });
      return () => window.removeEventListener("auth-change", checkAdmin);
    }
  }, [router]);

  const { data: books, isLoading } = useQuery({
    queryKey: ["books"],
    queryFn: () => api.listBooks(),
  });

  const featureMutation = useMutation({
    mutationFn: ({
      id,
      is_featured,
      featured_label,
    }: {
      id: string;
      is_featured: boolean;
      featured_label?: string | null;
    }) => api.featureBook(id, is_featured, featured_label),
    onSuccess: (updated) => {
      queryClient.setQueryData<Book[]>(["books"], (old) =>
        (old ?? []).map((b) =>
          b.id === updated.id
            ? updated
            : updated.is_featured
              ? { ...b, is_featured: false, featured_label: null }
              : b,
        ),
      );
      showToast(
        updated.is_featured
          ? `"${updated.title}" đã được đặt làm spotlight`
          : `Đã bỏ spotlight`,
      );
    },
  });

  function showToast(msg: string) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  }

  function handleFeatureClick(book: Book) {
    if (book.is_featured) {
      // Just un-feature immediately — no modal needed
      featureMutation.mutate({ id: book.id, is_featured: false });
    } else {
      setFeatureTarget(book);
    }
  }

  function handleFeatureConfirm(label: string) {
    if (!featureTarget) return;
    featureMutation.mutate({
      id: featureTarget.id,
      is_featured: true,
      featured_label: label,
    });
    setFeatureTarget(null);
  }

  const filtered = (books ?? []).filter((b) => {
    const q = search.trim().toLowerCase();
    return (
      !q ||
      b.title.toLowerCase().includes(q) ||
      (b.author ?? "").toLowerCase().includes(q)
    );
  });

  const featured = (books ?? []).find((b) => b.is_featured);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-text-mute dark:text-text-mute mb-6">
        <Link
          href="/"
          className="hover:text-accent dark:hover:text-accent transition-colors"
        >
          Thư viện
        </Link>
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
        <span className="text-text-dim dark:text-text-dim font-medium">
          Quản lý truyện
        </span>
      </nav>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text dark:text-text">
            Quản lý truyện
          </h1>
          <p className="text-sm text-text-mute dark:text-text-mute mt-0.5">
            Đặt spotlight, chỉnh sửa và sắp xếp thư viện
          </p>
        </div>
        {books && (
          <span className="text-xs font-medium text-text-mute dark:text-text-mute bg-raised dark:bg-raised px-3 py-1.5 rounded-full tabular-nums">
            {books.length} truyện
          </span>
        )}
      </div>

      {/* Current spotlight info banner */}
      {featured && (
        <div className="flex items-center gap-3 bg-gold/10 dark:bg-gold/30 border border-gold/30 dark:border-gold/30 rounded-xl px-4 py-3 mb-5">
          <svg
            className="w-5 h-5 text-gold flex-none"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-gold dark:text-gold mb-0.5">
              Đang spotlight · {featured.featured_label ?? "Nổi bật"}
            </p>
            <p className="text-sm text-amber-800 dark:text-amber-200 truncate font-medium">
              {featured.title}
            </p>
          </div>
          <button
            onClick={() =>
              featureMutation.mutate({ id: featured.id, is_featured: false })
            }
            className="text-xs text-gold dark:text-gold hover:underline flex-none"
          >
            Bỏ
          </button>
        </div>
      )}

      {/* Search */}
      <div className="relative mb-4">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-mute pointer-events-none"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="search"
          placeholder="Tìm theo tên hoặc tác giả…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 text-sm rounded-xl border border-hairline-soft dark:border-hairline bg-surface dark:bg-raised text-text dark:text-text placeholder-text-faint dark:placeholder-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-mute hover:text-text-dim dark:hover:text-text-dim transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Legend */}
      <p className="text-xs text-text-mute dark:text-text-mute mb-3">
        Nhấn{" "}
        <svg
          className="inline w-3.5 h-3.5 mb-0.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
          />
        </svg>{" "}
        để đặt một truyện làm spotlight trên trang chủ. Chỉ một truyện được
        spotlight tại một thời điểm.
      </p>

      {/* Book list */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner className="w-8 h-8 text-accent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-text-mute dark:text-text-mute">
          {search ? `Không tìm thấy "${search}"` : "Chưa có truyện nào"}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((book) => (
            <BookRow key={book.id} book={book} onFeature={handleFeatureClick} />
          ))}
        </div>
      )}

      {/* Feature modal */}
      {featureTarget && (
        <FeatureModal
          book={featureTarget}
          onConfirm={handleFeatureConfirm}
          onClose={() => setFeatureTarget(null)}
        />
      )}

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-surface dark:bg-raised text-white dark:text-text text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg animate-in whitespace-nowrap">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
