package com.truyenaudio.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Atomic app-private storage for offline manifests, chapter text, and jobs. */
final class NativeOfflineStore {
    private final File root;

    NativeOfflineStore(Context context) {
        root = new File(context.getFilesDir(), "offline/books");
        if (!root.exists()) root.mkdirs();
    }

    synchronized String getBookState(String bookId) {
        return read(new File(bookDir(bookId), "manifest.json"));
    }

    synchronized JSONArray listBookStates() {
        JSONArray result = new JSONArray();
        File[] books = root.listFiles(File::isDirectory);
        if (books == null) return result;
        for (File book : books) {
            String raw = read(new File(book, "manifest.json"));
            if (raw.isEmpty()) continue;
            try { result.put(new JSONObject(raw)); } catch (Exception ignored) {}
        }
        return result;
    }

    synchronized boolean saveBookState(String json) {
        try {
            JSONObject state = new JSONObject(json);
            String bookId = state.getString("book_id");
            return writeAtomic(new File(bookDir(bookId), "manifest.json"), state.toString());
        } catch (Exception ignored) {
            return false;
        }
    }

    synchronized boolean saveChapter(String json) {
        try {
            JSONObject chapter = new JSONObject(json);
            File file = chapterFile(chapter.getString("book_id"), chapter.getString("id"));
            return writeAtomic(file, chapter.toString());
        } catch (Exception ignored) {
            return false;
        }
    }

    synchronized JSONObject getChapter(String bookId, String chapterId) {
        String raw = read(chapterFile(bookId, chapterId));
        if (raw.isEmpty()) return null;
        try { return new JSONObject(raw); } catch (Exception ignored) { return null; }
    }

    synchronized String getChapterText(String bookId, String chapterId) {
        JSONObject chapter = getChapter(bookId, chapterId);
        return chapter == null ? "" : chapter.optString("text_content", "");
    }

    synchronized JSONArray listChapterIds(String bookId) {
        JSONArray result = new JSONArray();
        File chapters = new File(bookDir(bookId), "chapters");
        File[] files = chapters.listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return result;
        for (File file : files) {
            String raw = read(file);
            if (raw.isEmpty()) continue;
            try {
                String chapterId = new JSONObject(raw).optString("id", "");
                if (!chapterId.isEmpty()) result.put(chapterId);
            } catch (Exception ignored) {}
        }
        return result;
    }

    synchronized boolean saveJob(String bookId, String json) {
        return writeAtomic(new File(bookDir(bookId), "download-job.json"), json);
    }

    synchronized String getJob(String bookId) {
        return read(new File(bookDir(bookId), "download-job.json"));
    }

    synchronized boolean removeBook(String bookId) {
        File target = bookDir(bookId);
        try {
            String rootPath = root.getCanonicalPath() + File.separator;
            String targetPath = target.getCanonicalPath() + File.separator;
            if (!targetPath.startsWith(rootPath)) return false;
            deleteRecursively(target);
            return !target.exists();
        } catch (Exception ignored) {
            return false;
        }
    }

    private File bookDir(String bookId) {
        File dir = new File(root, safe(bookId));
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File chapterFile(String bookId, String chapterId) {
        File chapters = new File(bookDir(bookId), "chapters");
        if (!chapters.exists()) chapters.mkdirs();
        return new File(chapters, safe(chapterId) + ".json");
    }

    private static String safe(String value) {
        return value == null ? "" : value.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static boolean writeAtomic(File target, String value) {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) return false;
        File temp = new File(parent, target.getName() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temp, false)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        } catch (Exception ignored) {
            temp.delete();
            return false;
        }
        if (target.exists() && !target.delete()) {
            temp.delete();
            return false;
        }
        return temp.renameTo(target);
    }

    private static String read(File file) {
        if (!file.exists() || file.length() > 64L * 1024L * 1024L) return "";
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count < 0) break;
                offset += count;
            }
            return new String(bytes, 0, offset, StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return "";
        }
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }
}
