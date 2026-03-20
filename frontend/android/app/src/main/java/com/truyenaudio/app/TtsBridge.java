package com.truyenaudio.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
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

    @JavascriptInterface
    public void updateTitle(String title) {
        mainHandler.post(() -> {
            if (service != null) service.updateTitle(title);
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
}
