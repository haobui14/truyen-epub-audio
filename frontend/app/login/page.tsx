"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { setAuth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);
    try {
      // Signing up no longer signs you in: the account is created pending an
      // admin decision, so there is no session to store yet.
      if (mode === "signup") {
        const pending = await api.signup(email, password);
        setNotice(pending.message);
        setPassword("");
        setMode("login");
        return;
      }
      const result = await api.login(email, password);
      await setAuth(
        result.access_token,
        {
          user_id: result.user_id,
          email: result.email,
          role: result.role,
        },
        result.refresh_token,
      );
      router.push("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Đã xảy ra lỗi");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto py-12">
      <div className="text-center mb-8">
        <div className="w-14 h-14 bg-linear-to-br from-accent to-accent-dim rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
          <svg
            className="w-7 h-7 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-text dark:text-text">
          {mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}
        </h1>
        <p className="text-sm text-text-mute dark:text-text-mute mt-1">
          {mode === "login"
            ? "Đăng nhập để đọc và nghe truyện"
            : "Tài khoản mới cần quản trị viên duyệt trước khi đăng nhập"}
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-surface dark:bg-surface rounded-2xl border border-hairline-soft dark:border-hairline p-6 space-y-4 shadow-sm"
      >
        <div>
          <label className="block text-sm font-medium text-text-dim dark:text-text-faint mb-1.5">
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl border border-hairline-soft dark:border-hairline bg-ink dark:bg-raised text-text dark:text-text text-base focus:ring-2 focus:ring-accent focus:border-accent outline-none transition-colors"
            placeholder="email@example.com"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-dim dark:text-text-faint mb-1.5">
            Mật khẩu
          </label>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl border border-hairline-soft dark:border-hairline bg-ink dark:bg-raised text-text dark:text-text text-base focus:ring-2 focus:ring-accent focus:border-accent outline-none transition-colors"
            placeholder="Ít nhất 6 ký tự"
          />
        </div>

        {error && (
          <div className="text-sm text-vermillion dark:text-vermillion bg-vermillion/10 dark:bg-vermillion/30 px-3.5 py-2.5 rounded-xl">
            {error}
          </div>
        )}

        {notice && (
          <div className="text-sm text-accent dark:text-accent bg-accent/10 dark:bg-accent/20 px-3.5 py-2.5 rounded-xl">
            {notice}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="min-h-11 w-full py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-dim active:scale-[0.96] disabled:opacity-50 transition-[transform,background-color,box-shadow,opacity] shadow-sm"
        >
          {loading
            ? "Đang xử lý..."
            : mode === "login"
              ? "Đăng nhập"
              : "Tạo tài khoản"}
        </button>

        <div className="text-center text-sm text-text-mute dark:text-text-mute">
          {mode === "login" ? (
            <>
              Chưa có tài khoản?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
                className="text-accent dark:text-accent font-medium hover:underline"
              >
                Đăng ký
              </button>
            </>
          ) : (
            <>
              Đã có tài khoản?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className="text-accent dark:text-accent font-medium hover:underline"
              >
                Đăng nhập
              </button>
            </>
          )}
        </div>
      </form>

      <div className="text-center mt-6">
        <Link
          href="/"
          className="text-sm text-text-mute hover:text-text-dim dark:hover:text-text-faint transition-colors"
        >
          Quay lại trang chủ
        </Link>
      </div>
    </div>
  );
}
