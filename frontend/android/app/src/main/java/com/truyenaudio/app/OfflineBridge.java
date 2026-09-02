package com.truyenaudio.app;

import android.content.Context;
import android.webkit.JavascriptInterface;

import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Data;

import org.json.JSONObject;

/** JavaScript bridge for the Android OfflineRepository adapter. */
public final class OfflineBridge {
    private final Context context;
    private final NativeOfflineStore store;

    OfflineBridge(Context context) {
        this.context = context.getApplicationContext();
        this.store = new NativeOfflineStore(this.context);
    }

    @JavascriptInterface public String getBookState(String bookId) {
        return store.getBookState(bookId);
    }

    @JavascriptInterface public String listBookStates() {
        return store.listBookStates().toString();
    }

    @JavascriptInterface public String getChapter(String bookId, String chapterId) {
        JSONObject chapter = store.getChapter(bookId, chapterId);
        return chapter == null ? "" : chapter.toString();
    }

    @JavascriptInterface public String listChapterIds(String bookId) {
        return store.listChapterIds(bookId).toString();
    }

    @JavascriptInterface public boolean saveBookState(String json) {
        return store.saveBookState(json);
    }

    @JavascriptInterface public boolean saveChapter(String json) {
        return store.saveChapter(json);
    }

    @JavascriptInterface public boolean enqueueDownload(
            String bookId, String bookTitle, String chaptersJson, String apiBase) {
        try {
            JSONObject job = new JSONObject();
            job.put("book_id", bookId);
            job.put("book_title", bookTitle);
            job.put("chapters", new org.json.JSONArray(chaptersJson));
            String version = "";
            org.json.JSONArray chapters = job.getJSONArray("chapters");
            for (int i = 0; i < chapters.length(); i++) {
                String candidate = chapters.getJSONObject(i).optString("updated_at", "");
                if (candidate.compareTo(version) > 0) version = candidate;
            }
            job.put("version", version);
            if (!store.saveJob(bookId, job.toString())) return false;
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();
            Data input = new Data.Builder()
                    .putString(OfflineDownloadWorker.KEY_BOOK_ID, bookId)
                    .putString(OfflineDownloadWorker.KEY_API_BASE, apiBase)
                    .build();
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(OfflineDownloadWorker.class)
                    .setConstraints(constraints)
                    .setInputData(input)
                    .addTag("offline-book-" + bookId)
                    .build();
            WorkManager.getInstance(context).enqueueUniqueWork(
                    "offline-book-" + bookId,
                    ExistingWorkPolicy.REPLACE,
                    request);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    @JavascriptInterface public boolean cancelDownload(String bookId) {
        WorkManager.getInstance(context).cancelUniqueWork("offline-book-" + bookId);
        try {
            String raw = store.getBookState(bookId);
            if (!raw.isEmpty()) {
                JSONObject state = new JSONObject(raw);
                state.put("status", state.optInt("completed_chapters", 0) > 0 ? "partial" : "error");
                state.put("error_code", "cancelled");
                state.put("error_message", "Đã dừng tải. Bạn có thể tiếp tục bất cứ lúc nào.");
                state.put("updated_at", System.currentTimeMillis());
                store.saveBookState(state.toString());
            }
        } catch (Exception ignored) {}
        return true;
    }

    @JavascriptInterface public boolean removeBook(String bookId) {
        WorkManager.getInstance(context).cancelUniqueWork("offline-book-" + bookId);
        return store.removeBook(bookId);
    }
}
