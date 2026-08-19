"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type AdminUser } from "@/lib/api";
import { isAdmin, isAuthReady } from "@/lib/auth";
import { Spinner } from "@/components/ui/Spinner";

const STATUS_LABEL: Record<AdminUser["approval_status"], string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Từ chối",
};

const STATUS_CLASS: Record<AdminUser["approval_status"], string> = {
  pending: "bg-gold/15 dark:bg-gold/30 text-gold",
  approved: "bg-accent/15 dark:bg-accent/30 text-accent",
  rejected: "bg-vermillion/15 dark:bg-vermillion/30 text-vermillion",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("vi-VN");
}

function UserRow({
  user,
  busy,
  onDecide,
}: {
  user: AdminUser;
  busy: boolean;
  onDecide: (status: "approved" | "rejected") => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl border bg-surface dark:bg-raised border-hairline-soft dark:border-hairline/60">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text dark:text-text truncate">
          {user.email}
        </p>
        <p className="text-xs text-text-mute dark:text-text-mute mt-0.5">
          {user.display_name ? `${user.display_name} · ` : ""}
          Đăng ký {formatDate(user.created_at)}
        </p>
      </div>

      <span
        className={`text-[11px] font-medium px-2 py-1 rounded-full ${STATUS_CLASS[user.approval_status]}`}
      >
        {STATUS_LABEL[user.approval_status]}
      </span>

      <div className="flex items-center gap-2">
        {user.approval_status !== "approved" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide("approved")}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-accent dark:text-accent border border-accent/40 dark:border-accent/40 rounded-lg hover:bg-accent/15 dark:hover:bg-accent/30 disabled:opacity-60 transition-colors"
          >
            {busy && <Spinner className="w-3 h-3" />}
            Duyệt
          </button>
        )}
        {user.approval_status !== "rejected" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide("rejected")}
            className="px-3 py-1.5 text-xs font-medium text-vermillion dark:text-vermillion border border-vermillion/40 dark:border-vermillion/40 rounded-lg hover:bg-vermillion/10 dark:hover:bg-vermillion/30 disabled:opacity-60 transition-colors"
          >
            {user.approval_status === "pending" ? "Từ chối" : "Thu hồi"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function UsersClient() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const { data: users, isLoading, error } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api.listUsers(),
  });

  const decideMutation = useMutation({
    mutationFn: ({
      userId,
      status,
    }: {
      userId: string;
      status: "approved" | "rejected";
    }) => api.decideApproval(userId, status),
    onMutate: ({ userId }) => setBusyId(userId),
    onSuccess: (_data, { status }) => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setToastMsg(
        status === "approved"
          ? "Đã duyệt tài khoản"
          : "Đã thu hồi quyền truy cập",
      );
      setTimeout(() => setToastMsg(null), 2500);
    },
    onError: (err: unknown) => {
      setToastMsg(err instanceof Error ? err.message : "Không thực hiện được");
      setTimeout(() => setToastMsg(null), 4000);
    },
    onSettled: () => setBusyId(null),
  });

  const pending = (users ?? []).filter((u) => u.approval_status === "pending");
  const decided = (users ?? []).filter((u) => u.approval_status !== "pending");

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-text dark:text-text">
          Người dùng
        </h1>
        <p className="text-sm text-text-mute dark:text-text-mute mt-1">
          Tài khoản mới phải được duyệt ở đây trước khi đăng nhập và đọc/nghe
          truyện.
        </p>
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner className="w-8 h-8 text-accent" />
        </div>
      )}

      {error && (
        <p className="text-sm text-vermillion dark:text-vermillion">
          {error instanceof Error ? error.message : "Không tải được danh sách"}
        </p>
      )}

      {users && (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-text dark:text-text">
              Chờ duyệt {pending.length > 0 && `(${pending.length})`}
            </h2>
            {pending.length === 0 ? (
              <p className="text-sm text-text-mute dark:text-text-mute">
                Không có tài khoản nào đang chờ.
              </p>
            ) : (
              <div className="space-y-2">
                {pending.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    busy={busyId === u.id}
                    onDecide={(status) =>
                      decideMutation.mutate({ userId: u.id, status })
                    }
                  />
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-text dark:text-text">
              Tất cả tài khoản ({decided.length})
            </h2>
            <div className="space-y-2">
              {decided.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  busy={busyId === u.id}
                  onDecide={(status) =>
                    decideMutation.mutate({ userId: u.id, status })
                  }
                />
              ))}
            </div>
          </section>
        </>
      )}

      {toastMsg && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-ink dark:bg-surface text-sm text-text dark:text-text border border-hairline-soft dark:border-hairline shadow-lg">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
