package com.truyenaudio.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Data;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Resumable whole-book downloader. Each chapter is committed atomically. */
public final class OfflineDownloadWorker extends Worker {
    public static final String KEY_BOOK_ID = "book_id";
    public static final String KEY_API_BASE = "api_base";

    private final NativeOfflineStore store;
    private final SecureAuthStore authStore;

    public OfflineDownloadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
        store = new NativeOfflineStore(context);
        authStore = new SecureAuthStore(context);
    }

    @NonNull
    @Override
    public Result doWork() {
        String bookId = getInputData().getString(KEY_BOOK_ID);
        String apiBase = getInputData().getString(KEY_API_BASE);
        if (bookId == null || bookId.isEmpty() || apiBase == null || apiBase.isEmpty()) {
            return Result.failure();
        }
        try {
            JSONObject job = new JSONObject(store.getJob(bookId));
            JSONArray chapters = job.getJSONArray("chapters");
            JSONObject state = stateFor(bookId, job, chapters.length());
            // Rebuild the manifest from the current job on every attempt. Files
            // already committed by a killed worker are discovered below, while
            // chapters removed from a newer job cannot linger in the manifest.
            Set<String> completedIds = new HashSet<>();
            JSONArray failedIds = new JSONArray();
            int completed = 0;
            int stale = 0;
            long bytes = 0;
            String failureCode = null;
            String token = tokenFromSecureBlob();

            state.put("status", "downloading");
            state.remove("error_code");
            state.remove("error_message");
            persist(state);

            for (int index = 0; index < chapters.length(); index++) {
                if (isStopped()) return stoppedResult(bookId);
                JSONObject meta = chapters.getJSONObject(index);
                String chapterId = meta.getString("id");
                String serverVersion = meta.optString("updated_at", "");
                JSONObject existing = store.getChapter(bookId, chapterId);
                boolean fresh = existing != null
                        && serverVersion.equals(existing.optString("server_updated_at", ""));
                try {
                    JSONObject chapter;
                    if (fresh) {
                        chapter = existing;
                    } else {
                        String body = get(apiBase + "/api/chapters/" + chapterId + "/text", token);
                        if (isStopped()) return stoppedResult(bookId);
                        JSONObject response = new JSONObject(body);
                        String text = response.optString("text_content", "");
                        if (text.isEmpty()) throw new IllegalStateException("empty chapter");
                        chapter = new JSONObject();
                        chapter.put("id", chapterId);
                        chapter.put("book_id", bookId);
                        chapter.put("text_content", text);
                        chapter.put("cached_at", System.currentTimeMillis());
                        chapter.put("server_updated_at", response.optString("updated_at", serverVersion));
                        chapter.put("bytes", text.getBytes(StandardCharsets.UTF_8).length);
                        if (!store.saveChapter(chapter.toString())) {
                            throw new java.io.IOException("storage write failed");
                        }
                        if (isStopped()) return stoppedResult(bookId);
                    }
                    completedIds.add(chapterId);
                    completed++;
                    bytes += chapter.optLong("bytes",
                            chapter.optString("text_content", "").getBytes(StandardCharsets.UTF_8).length);
                } catch (Exception chapterError) {
                    failedIds.put(chapterId);
                    if (existing != null && !fresh) stale++;
                    String message = String.valueOf(chapterError.getMessage())
                            .toLowerCase(Locale.ROOT);
                    if (message.contains("storage") || message.contains("space")) {
                        failureCode = "storage-full";
                    } else if (message.contains("401") || message.contains("403")) {
                        failureCode = "unauthorized";
                    } else if (failureCode == null) {
                        failureCode = "network";
                    }
                }

                state.put("completed_chapters", completed);
                state.put("failed_chapters", failedIds.length());
                state.put("stale_chapters", stale);
                state.put("bytes_total", bytes);
                state.put("chapter_ids", new JSONArray(completedIds));
                state.put("failed_chapter_ids", failedIds);
                state.put("updated_at", System.currentTimeMillis());
                persist(state);
                setProgressAsync(new Data.Builder()
                        .putInt("completed", completed)
                        .putInt("failed", failedIds.length())
                        .putInt("total", chapters.length())
                        .build());
            }

            if (failedIds.length() == 0) {
                state.put("status", "ready");
                state.put("stale_chapters", 0);
                state.put("last_successful_sync", System.currentTimeMillis());
                state.remove("error_code");
                state.remove("error_message");
            } else {
                state.put("status", completed > 0 ? "partial" : "error");
                state.put("error_code", failureCode == null ? "network" : failureCode);
                state.put("error_message", "storage-full".equals(failureCode)
                        ? "Không đủ dung lượng. Hãy xóa bớt truyện đã tải rồi thử lại."
                        : failedIds.length() + " chương chưa tải được. Nhấn để thử lại.");
            }
            state.put("updated_at", System.currentTimeMillis());
            persist(state);
            return Result.success();
        } catch (Exception fatal) {
            if (isStopped()) return stoppedResult(bookId);
            markFatal(bookId, fatal);
            return getRunAttemptCount() < 4 ? Result.retry() : Result.failure();
        }
    }

    private JSONObject stateFor(String bookId, JSONObject job, int total) throws Exception {
        String raw = store.getBookState(bookId);
        JSONObject state = raw.isEmpty() ? new JSONObject() : new JSONObject(raw);
        state.put("book_id", bookId);
        state.put("book_title", job.optString("book_title", ""));
        state.put("total_chapters", total);
        if (!state.has("completed_chapters")) state.put("completed_chapters", 0);
        if (!state.has("failed_chapters")) state.put("failed_chapters", 0);
        if (!state.has("stale_chapters")) state.put("stale_chapters", 0);
        if (!state.has("bytes_total")) state.put("bytes_total", 0);
        if (!state.has("chapter_ids")) state.put("chapter_ids", new JSONArray());
        if (!state.has("failed_chapter_ids")) state.put("failed_chapter_ids", new JSONArray());
        if (!state.has("last_successful_sync")) state.put("last_successful_sync", JSONObject.NULL);
        state.put("version", job.optString("version", ""));
        return state;
    }

    private String tokenFromSecureBlob() {
        try { return new JSONObject(authStore.load()).optString("token", ""); }
        catch (Exception ignored) { return ""; }
    }

    private void persist(JSONObject state) throws Exception {
        if (!store.saveBookState(state.toString())) throw new java.io.IOException("storage full");
    }

    private void markFatal(String bookId, Exception error) {
        if (bookId == null || bookId.isEmpty()) return;
        try {
            String raw = store.getBookState(bookId);
            JSONObject state = raw.isEmpty() ? new JSONObject() : new JSONObject(raw);
            state.put("book_id", bookId);
            state.put("status", state.optInt("completed_chapters", 0) > 0 ? "partial" : "error");
            boolean storage = String.valueOf(error.getMessage())
                    .toLowerCase(Locale.ROOT).contains("storage");
            state.put("error_code", storage ? "storage-full" : "network");
            state.put("error_message", storage
                    ? "Không đủ dung lượng. Hãy xóa bớt truyện đã tải rồi thử lại."
                    : "Mất kết nối. Tiến trình đã lưu và sẽ tiếp tục.");
            state.put("updated_at", System.currentTimeMillis());
            store.saveBookState(state.toString());
        } catch (Exception ignored) {}
    }

    private Result stoppedResult(String bookId) {
        try {
            String raw = store.getBookState(bookId);
            if (!raw.isEmpty()
                    && "cancelled".equals(new JSONObject(raw).optString("error_code", ""))) {
                return Result.failure();
            }
        } catch (Exception ignored) {}
        return Result.retry();
    }

    private static String get(String urlString, String token) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(urlString).openConnection();
        connection.setConnectTimeout(12_000);
        connection.setReadTimeout(30_000);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null && !token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300
                ? connection.getInputStream() : connection.getErrorStream();
        if (stream == null) throw new java.io.IOException("HTTP " + status);
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
        StringBuilder body = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) body.append(line);
        reader.close();
        connection.disconnect();
        if (status < 200 || status >= 300) throw new java.io.IOException("HTTP " + status);
        return body.toString();
    }
}
