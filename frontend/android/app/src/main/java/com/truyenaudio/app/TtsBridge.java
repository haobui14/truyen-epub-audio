package com.truyenaudio.app;

import android.app.DownloadManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * JavaScript interface exposed as {@code window.TtsBridge} in the WebView.
 *
 * All {@link JavascriptInterface} methods are called on a WebView-internal
 * thread, so every one of them dispatches its body to the main thread via
 * {@link Handler#post} before touching any Android API or service state.
 */
public class TtsBridge {

    private final Context    context;
    private final WebView    webView;
    private final Handler    mainHandler;

    private TtsPlaybackService service;
    private boolean            bound = false;

    // Pending play command buffered while the service is still binding.
    // If playChunksWithId is called before onServiceConnected fires, we save
    // the arguments here and replay them once the service is available.
    private List<String> pendingChunks     = null;
    private float        pendingRate       = 1.0f;
    private float        pendingPitch      = 1.0f;
    private int          pendingStartIdx   = 0;
    private String       pendingTitle      = "";
    private String       pendingChapterId  = "";

    // Pending queue / playlist data saved when service is not yet bound.
    // Replayed in onServiceConnected immediately after the play command.
    private List<TtsPlaybackService.ChapterItem> pendingMergeItems = null;
    private List<TtsPlaybackService.ChapterMeta> pendingPlaylistMeta = null;
    private String pendingPlaylistBase  = "";
    private String pendingPlaylistToken = "";

    // Cover URL saved when the service is not yet bound (updateCover fires from
    // PlayerContext as soon as the book loads, often before binding completes).
    private String pendingCoverUrl = null;

    // Book id/title saved when the service is not yet bound (setSessionInfo
    // fires from PlayerContext as soon as the track loads).
    private String pendingBookId    = null;
    private String pendingBookTitle = null;

    // Preferred device voice saved when the service is not yet bound
    // (useNativeTTSPlayer applies it as soon as the player mounts).
    private String pendingVoiceName = null;

    // ── Service connection ────────────────────────────────────────────────────

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            TtsPlaybackService.LocalBinder lb =
                    (TtsPlaybackService.LocalBinder) binder;
            service = lb.getService();
            // Replay any play command that arrived before the service was bound
            if (pendingChunks != null && service != null) {
                service.playChunks(pendingChunks, pendingRate, pendingPitch,
                        pendingStartIdx, pendingTitle, pendingChapterId);
                pendingChunks = null;
            }
            // Replay pending queue / playlist data
            if (service != null) {
                if (pendingMergeItems != null) {
                    service.mergeQueue(pendingMergeItems);
                    pendingMergeItems = null;
                }
                if (pendingPlaylistMeta != null) {
                    service.setPendingPlaylist(pendingPlaylistMeta,
                            pendingPlaylistBase, pendingPlaylistToken);
                    pendingPlaylistMeta  = null;
                    pendingPlaylistBase  = "";
                    pendingPlaylistToken = "";
                }
                if (pendingCoverUrl != null) {
                    service.updateCover(pendingCoverUrl);
                    pendingCoverUrl = null;
                }
                if (pendingBookId != null || pendingBookTitle != null) {
                    service.setSessionInfo(pendingBookId, pendingBookTitle);
                    pendingBookId    = null;
                    pendingBookTitle = null;
                }
                if (pendingVoiceName != null) {
                    service.setPreferredVoice(pendingVoiceName);
                    pendingVoiceName = null;
                }
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
            bound   = false;
        }
    };

    // ── Constructor ───────────────────────────────────────────────────────────

    public TtsBridge(Context context, WebView webView) {
        this.context     = context.getApplicationContext();
        this.webView     = webView;
        this.mainHandler = new Handler(Looper.getMainLooper());

        // Install the JS evaluator once; the service uses it even before binding
        TtsPlaybackService.setJsEvaluator(js ->
                webView.post(() -> webView.evaluateJavascript(js, null)));

        // Start and bind the service immediately so it survives screen-off
        doStartService();
        doBindService();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private void doStartService() {
        Intent intent = new Intent(context, TtsPlaybackService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    private void doBindService() {
        if (bound) return;
        Intent intent = new Intent(context, TtsPlaybackService.class);
        bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
    }

    private void ensureStarted() {
        doStartService();
        doBindService();
    }

    // ── @JavascriptInterface methods ──────────────────────────────────────────

    @JavascriptInterface
    public void startService() {
        mainHandler.post(() -> {
            ensureStarted();
        });
    }

    @JavascriptInterface
    public void stopService() {
        mainHandler.post(() -> {
            pendingChunks = null;
            if (service != null) service.stopPlayback();
            if (bound) {
                context.unbindService(connection);
                bound   = false;
                service = null;
            }
            context.stopService(new Intent(context, TtsPlaybackService.class));
        });
    }

    /**
     * Opens the system Text-to-Speech settings so the user can install or
     * select Vietnamese voice data after a LANG_UNAVAILABLE error. Falls back
     * to the Accessibility settings screen on OEMs that hide the TTS activity.
     */
    @JavascriptInterface
    public void openTtsSettings() {
        mainHandler.post(() -> {
            Intent i = new Intent("com.android.settings.TTS_SETTINGS");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(i);
            } catch (Exception e) {
                Intent fallback = new Intent(
                        android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(fallback);
                } catch (Exception ignored) {}
            }
        });
    }

    /**
     * Tears the service down and re-creates it so the TextToSpeech engine
     * re-initializes — used by the error banner's "retry" button after the
     * user installs the missing voice. The next playChunks buffers + replays
     * once the fresh service binds.
     */
    @JavascriptInterface
    public void retryTts() {
        mainHandler.post(() -> {
            if (service != null) service.stopPlayback();
            if (bound) {
                try {
                    context.unbindService(connection);
                } catch (Exception ignored) {}
                bound   = false;
                service = null;
            }
            context.stopService(new Intent(context, TtsPlaybackService.class));
            ensureStarted();
        });
    }

    @JavascriptInterface
    public void playChunks(String chunksJson, double rate, double pitch,
                           int startIdx, String title) {
        playChunksWithId(chunksJson, rate, pitch, startIdx, title, "");
    }

    @JavascriptInterface
    public void playChunksWithId(String chunksJson, double rate, double pitch,
                                 int startIdx, String title, String chapterId) {
        mainHandler.post(() -> {
            ensureStarted();
            try {
                JSONArray arr = new JSONArray(chunksJson);
                List<String> chunks = new ArrayList<>(arr.length());
                for (int i = 0; i < arr.length(); i++) chunks.add(arr.getString(i));
                if (service == null) {
                    // Service not bound yet — save for replay in onServiceConnected
                    pendingChunks    = chunks;
                    pendingRate      = (float) rate;
                    pendingPitch     = (float) pitch;
                    pendingStartIdx  = startIdx;
                    pendingTitle     = title != null ? title : "";
                    pendingChapterId = chapterId != null ? chapterId : "";
                    return;
                }
                // Clear any stale pending command now that we have a live service
                pendingChunks = null;
                service.playChunks(chunks, (float) rate, (float) pitch,
                        startIdx, title, chapterId);
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    @JavascriptInterface
    public void pausePlayback() {
        mainHandler.post(() -> {
            if (service != null) service.pausePlayback();
        });
    }

    @JavascriptInterface
    public void resumePlayback() {
        mainHandler.post(() -> {
            if (service != null) service.resumePlayback();
        });
    }

    @JavascriptInterface
    public void stopPlayback() {
        // Immediately mark the service as not playing so that bridge.isPlaying()
        // returns false right away — before the mainHandler.post below executes.
        // Without this, useNativeTTSPlayer reads isPlaying=true immediately after
        // the JS call, triggering the nativeIsAhead guard and preventing manual
        // chapter navigation from stopping native playback.
        TtsPlaybackService svc = service;
        if (svc != null) svc.isPlaying = false;

        mainHandler.post(() -> {
            pendingChunks = null;
            if (service != null) service.stopPlayback();
        });
    }

    @JavascriptInterface
    public void setRate(double rate) {
        mainHandler.post(() -> {
            if (service != null) service.setRate((float) rate);
        });
    }

    @JavascriptInterface
    public void setPitch(double pitch) {
        mainHandler.post(() -> {
            if (service != null) service.setPitch((float) pitch);
        });
    }

    /**
     * Jump to a chunk inside the currently-playing chapter WITHOUT the full
     * playChunks restart (which clears the queue and prefetch chain). While
     * paused it only moves the resume position.
     */
    @JavascriptInterface
    public void seekToChunk(int idx) {
        mainHandler.post(() -> {
            if (service != null) service.seekToChunk(idx);
        });
    }

    /**
     * JSON array of the device's installed Vietnamese voices:
     * [{name, quality, network}]. Empty until the TTS engine has initialised.
     * Volatile read — safe from the WebView thread.
     */
    @JavascriptInterface
    public String getNativeVoices() {
        TtsPlaybackService svc = service;
        return svc != null ? svc.availableVoicesJson : "[]";
    }

    /**
     * Select a device TTS voice by name (from getNativeVoices). Empty string
     * returns to the engine default for vi-VN. Buffered until the service binds.
     */
    @JavascriptInterface
    public void setNativeVoice(String name) {
        mainHandler.post(() -> {
            if (service != null) {
                service.setPreferredVoice(name);
            } else {
                pendingVoiceName = name != null ? name : "";
            }
        });
    }

    /**
     * Arm/disarm "sleep when the current chapter ends". Runs entirely in Java
     * so it fires even with the screen off. Mutually exclusive with
     * setSleepTimer.
     */
    @JavascriptInterface
    public void setSleepAtChapterEnd(boolean on) {
        mainHandler.post(() -> {
            if (service != null) service.setSleepAtChapterEnd(on);
        });
    }

    @JavascriptInterface
    public void updateTitle(String title) {
        mainHandler.post(() -> {
            if (service != null) service.updateTitle(title);
        });
    }

    @JavascriptInterface
    public void updateCover(String url) {
        mainHandler.post(() -> {
            if (service != null) {
                service.updateCover(url);
            } else {
                // Service not bound yet — apply on connect.
                pendingCoverUrl = url;
            }
        });
    }

    /**
     * Book-level session info: id keys the durable session snapshot and the
     * Java-side server progress writes; title shows on the lockscreen /
     * Bluetooth as artist. Buffered until the service binds.
     */
    @JavascriptInterface
    public void setSessionInfo(String bookId, String bookTitle) {
        mainHandler.post(() -> {
            if (service != null) {
                service.setSessionInfo(bookId, bookTitle);
            } else {
                pendingBookId    = bookId;
                pendingBookTitle = bookTitle;
            }
        });
    }

    @JavascriptInterface
    public int getCurrentChunk() {
        // Volatile read — safe from any thread
        TtsPlaybackService svc = service;
        return svc != null ? svc.currentChunkIdx : -1;
    }

    @JavascriptInterface
    public String getCurrentChapterId() {
        TtsPlaybackService svc = service;
        return svc != null ? svc.currentChapterId : "";
    }

    @JavascriptInterface
    public String getCurrentTitle() {
        TtsPlaybackService svc = service;
        return svc != null ? svc.currentTitle : "";
    }

    @JavascriptInterface
    public String getCurrentBookId() {
        TtsPlaybackService svc = service;
        return svc != null ? svc.currentBookId : "";
    }

    @JavascriptInterface
    public String getCurrentBookTitle() {
        TtsPlaybackService svc = service;
        return svc != null ? svc.currentBookTitle : "";
    }

    @JavascriptInterface
    public String getCoverUrl() {
        TtsPlaybackService svc = service;
        return svc != null ? svc.currentCoverUrl : "";
    }

    @JavascriptInterface
    public int getTotalChunks() {
        TtsPlaybackService svc = service;
        return svc != null ? svc.currentTotalChunks : 0;
    }

    /**
     * JSON array of the text chunks of the chapter native is playing, "[]"
     * when idle. Lets JS recover the chapter text on app-reopen when it has
     * no cached copy (Java self-fetched the chapter during a screen-off
     * auto-advance) and the network is unavailable.
     */
    @JavascriptInterface
    public String getCurrentChunksJson() {
        TtsPlaybackService svc = service;
        return svc != null ? svc.currentChunksJson : "[]";
    }

    /**
     * Last listening position on this device as a JSON string
     * {bookId, chapterId, chunkIdx, ts} — or "" if none. Unlike the live
     * session it survives stopPlayback / swipe-away / process death. Read
     * straight from SharedPreferences so it works even before the service
     * binds.
     */
    @JavascriptInterface
    public String getLastListenPosition() {
        try {
            return context.getSharedPreferences(
                            TtsPlaybackService.PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(TtsPlaybackService.PREFS_KEY_LAST_POSITION, "");
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean isPlaying() {
        TtsPlaybackService svc = service;
        return svc != null && svc.isPlaying;
    }

    @JavascriptInterface
    public void queueNextChapter(String chunksJson, String chapterId,
                                 String title, double rate, double pitch) {
        mainHandler.post(() -> {
            if (service == null) return;
            try {
                JSONArray arr = new JSONArray(chunksJson);
                List<String> chunks = new ArrayList<>(arr.length());
                for (int i = 0; i < arr.length(); i++) chunks.add(arr.getString(i));

                TtsPlaybackService.ChapterItem item =
                        new TtsPlaybackService.ChapterItem(
                                chunks, chapterId, title, (float) rate, (float) pitch);
                List<TtsPlaybackService.ChapterItem> list = new ArrayList<>(1);
                list.add(item);
                service.queueAllChapters(list);
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    @JavascriptInterface
    public void queueAllChapters(String chaptersJson) {
        mainHandler.post(() -> {
            if (service == null) return;
            try {
                JSONArray arr = new JSONArray(chaptersJson);
                List<TtsPlaybackService.ChapterItem> list = new ArrayList<>(arr.length());
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject obj       = arr.getJSONObject(i);
                    JSONArray  chunksArr = obj.getJSONArray("chunks");
                    List<String> chunks  = new ArrayList<>(chunksArr.length());
                    for (int j = 0; j < chunksArr.length(); j++) {
                        chunks.add(chunksArr.getString(j));
                    }
                    String chapterId = obj.optString("chapterId", "");
                    String title     = obj.optString("title", "");
                    float  rate      = (float) obj.optDouble("rate",  1.0);
                    float  pitch     = (float) obj.optDouble("pitch", 1.0);
                    list.add(new TtsPlaybackService.ChapterItem(
                            chunks, chapterId, title, rate, pitch));
                }
                service.queueAllChapters(list);
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    /**
     * Like {@link #queueAllChapters} but uses {@code mergeQueue()} internally,
     * which skips the currently-playing chapter so there is never an empty-queue
     * window. Use for every incremental queue update while playback is in progress.
     */
    @JavascriptInterface
    public void mergeQueuedChapters(String chaptersJson) {
        mainHandler.post(() -> {
            try {
                JSONArray arr = new JSONArray(chaptersJson);
                List<TtsPlaybackService.ChapterItem> list = new ArrayList<>(arr.length());
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject obj       = arr.getJSONObject(i);
                    JSONArray  chunksArr = obj.getJSONArray("chunks");
                    List<String> chunks  = new ArrayList<>(chunksArr.length());
                    for (int j = 0; j < chunksArr.length(); j++) {
                        chunks.add(chunksArr.getString(j));
                    }
                    String chapterId = obj.optString("chapterId", "");
                    String title     = obj.optString("title", "");
                    float  rate      = (float) obj.optDouble("rate",  1.0);
                    float  pitch     = (float) obj.optDouble("pitch", 1.0);
                    list.add(new TtsPlaybackService.ChapterItem(
                            chunks, chapterId, title, rate, pitch));
                }
                if (service == null) {
                    // Service not bound yet — buffer so onServiceConnected can replay
                    pendingMergeItems = list;
                    return;
                }
                service.mergeQueue(list);
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    @JavascriptInterface
    public void clearNextChapter() {
        mainHandler.post(() -> {
            if (service != null) service.clearQueue();
        });
    }

    @JavascriptInterface
    public void setSleepTimer(double expireAtMs) {
        mainHandler.post(() -> {
            if (service != null) service.setSleepTimer((long) expireAtMs);
        });
    }

    @JavascriptInterface
    public void cancelSleepTimer() {
        mainHandler.post(() -> {
            if (service != null) service.cancelSleepTimer();
        });
    }

    /**
     * Provides Java with an ordered playlist of upcoming chapter IDs so it can
     * self-fetch chapter text while the WebView is suspended (screen off).
     * This enables unlimited uninterrupted background playback regardless of
     * book length, with only one chapter held in memory at a time.
     *
     * @param chaptersMetaJson JSON array of {@code {id, title, rate, pitch}} objects
     * @param apiBase          base URL of the API (e.g. "https://api.truyenaudio.com")
     * @param token            Bearer token for authenticated requests
     */
    @JavascriptInterface
    public void setPendingChapters(String chaptersMetaJson, String apiBase, String token) {
        mainHandler.post(() -> {
            try {
                JSONArray arr = new JSONArray(chaptersMetaJson);
                List<TtsPlaybackService.ChapterMeta> list = new ArrayList<>(arr.length());
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject obj   = arr.getJSONObject(i);
                    String     id    = obj.optString("id", "");
                    String     title = obj.optString("title", "");
                    float      rate  = (float) obj.optDouble("rate",  1.0);
                    float      pitch = (float) obj.optDouble("pitch", 1.0);
                    if (!id.isEmpty()) {
                        list.add(new TtsPlaybackService.ChapterMeta(id, title, rate, pitch));
                    }
                }
                if (service == null) {
                    // Service not bound yet — buffer so onServiceConnected can replay
                    pendingPlaylistMeta  = list;
                    pendingPlaylistBase  = apiBase  != null ? apiBase  : "";
                    pendingPlaylistToken = token    != null ? token    : "";
                    return;
                }
                service.setPendingPlaylist(list, apiBase, token);
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    /**
     * Returns a JSON array of chapter IDs that were completed by native
     * auto-advance (e.g. while the screen was off) since the last call,
     * then clears the internal list.  Called by JS on screen-on to award
     * XP for chapters that finished while the WebView was throttled.
     */
    @JavascriptInterface
    public String getCompletedChapterIds() {
        TtsPlaybackService svc = service;
        if (svc == null) return "[]";
        java.util.List<String> ids = svc.getAndClearCompletedChapterIds();
        try {
            JSONArray arr = new JSONArray();
            for (String id : ids) arr.put(id);
            return arr.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    /**
     * Returns true when Android reports the device has an active network with
     * internet capability. More reliable than {@code navigator.onLine} in a
     * WebView — that flag can stay {@code true} while the network adapter is
     * connected to a router with no internet, or lag behind on Wi-Fi handover.
     */
    @JavascriptInterface
    public boolean isOnline() {
        ConnectivityManager cm =
                (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true; // assume online if we can't check
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            android.net.Network net = cm.getActiveNetwork();
            if (net == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(net);
            return caps != null
                    && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } else {
            // Pre-M: fall back to deprecated activeNetworkInfo
            @SuppressWarnings("deprecation")
            android.net.NetworkInfo info = cm.getActiveNetworkInfo();
            return info != null && info.isConnected();
        }
    }

    /**
     * True when the app is exempt from battery optimizations (Doze). When it
     * is NOT, aggressive OEMs (Samsung, Xiaomi, …) may kill the TTS foreground
     * service during long screen-off sessions — the primary cause of
     * "playback stopped in the middle of the night".
     */
    @JavascriptInterface
    public boolean isIgnoringBatteryOptimizations() {
        try {
            PowerManager pm =
                    (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            return pm == null
                    || pm.isIgnoringBatteryOptimizations(context.getPackageName());
        } catch (Exception e) {
            return true; // can't check → don't nag
        }
    }

    /**
     * Save a http(s) URL into the system Downloads folder via Android's
     * DownloadManager — the WebView itself silently drops download links and
     * cannot save blobs. Used by the book EPUB export button. Shows the
     * standard system download notification with progress; the file's type
     * comes from the server's Content-Type.
     */
    @JavascriptInterface
    public void downloadFile(String url, String fileName) {
        mainHandler.post(() -> {
            try {
                if (url == null
                        || !(url.startsWith("http://") || url.startsWith("https://"))) {
                    return; // DownloadManager can only fetch http(s)
                }
                String name = fileName == null ? "" : fileName.trim();
                name = name.replaceAll("[\\\\/:*?\"<>|]+", " ").trim();
                if (name.isEmpty()) name = "download";

                DownloadManager dm = (DownloadManager)
                        context.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) return;

                DownloadManager.Request req =
                        new DownloadManager.Request(Uri.parse(url));
                req.setTitle(name);
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS, name);
                try {
                    dm.enqueue(req);
                } catch (SecurityException se) {
                    // Android 7–9 without the legacy storage permission cannot
                    // write to public Downloads — retry into the app-scoped
                    // downloads dir, which needs no permission on any API.
                    DownloadManager.Request fallback =
                            new DownloadManager.Request(Uri.parse(url));
                    fallback.setTitle(name);
                    fallback.setNotificationVisibility(
                            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    fallback.setDestinationInExternalFilesDir(
                            context, Environment.DIRECTORY_DOWNLOADS, name);
                    dm.enqueue(fallback);
                }
                android.widget.Toast.makeText(context,
                        "Đang tải xuống — xem thông báo hệ thống",
                        android.widget.Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    /**
     * Show the system dialog asking to exempt this app from battery
     * optimizations. Falls back to the full optimization-list screen on OEMs
     * that block the direct request dialog.
     */
    @JavascriptInterface
    public void requestIgnoreBatteryOptimizations() {
        mainHandler.post(() -> {
            try {
                Intent i = new Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + context.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(i);
            } catch (Exception e) {
                try {
                    Intent fallback = new Intent(
                            android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(fallback);
                } catch (Exception ignored) {}
            }
        });
    }
}
