package com.truyenaudio.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.IOException;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean serviceRunning = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Initialize AudioManager for background TTS playback
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        
        WebView.setWebContentsDebuggingEnabled(true);

        getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                String path = request.getUrl().getPath();

                // For /books/{nonPlaceholder}[.ext][/subpath], rewrite BEFORE calling super.
                // This is critical: Capacitor's super returns a non-null 404 response when
                // it can't find the file, which would prevent our fallback from running.
                if (path != null
                        && (url.startsWith("https://localhost") || url.startsWith("http://localhost"))
                        && path.startsWith("/books/")) {

                    String segment = path.substring("/books/".length()); // e.g. "abc123.txt" or "abc123/listen"
                    int slashIdx = segment.indexOf('/');
                    String bookIdPart = slashIdx == -1 ? segment : segment.substring(0, slashIdx);
                    String subPath    = slashIdx == -1 ? "" : segment.substring(slashIdx); // "/listen" etc.

                    int dotIdx = bookIdPart.lastIndexOf('.');
                    String bookId  = dotIdx == -1 ? bookIdPart : bookIdPart.substring(0, dotIdx);
                    String bookExt = dotIdx == -1 ? "" : bookIdPart.substring(dotIdx); // ".txt" | ".html" | ""

                    if (!"placeholder".equals(bookId) && !bookId.isEmpty()) {
                        // Build the rewritten placeholder asset path
                        String assetPath;
                        if (subPath.isEmpty()) {
                            // /books/abc123       -> placeholder/index.html
                            // /books/abc123.txt   -> placeholder.txt (RSC payload)
                            // /books/abc123.html  -> placeholder.html
                            assetPath = bookExt.isEmpty()
                                    ? "public/books/placeholder/index.html"
                                    : "public/books/placeholder" + bookExt;
                        } else {
                            // /books/abc123/listen       -> placeholder/listen/index.html
                            // /books/abc123/listen.txt   -> placeholder/listen.txt
                            // /books/abc123/__next.*/... -> placeholder/__next.*/ ...
                            assetPath = "public/books/placeholder" + subPath;
                            if (!assetPath.contains(".")) assetPath += "/index.html";
                        }

                        try {
                            InputStream is = getAssets().open(assetPath);
                            return new WebResourceResponse(mimeFor(assetPath), "UTF-8", 200, "OK", null, is);
                        } catch (IOException e) {
                            // Asset not found even in placeholder; fall through to super
                        }
                    }
                }

                // Default: let Capacitor bridge handle the request normally
                return super.shouldInterceptRequest(view, request);
            }

            private String mimeFor(String path) {
                if (path.endsWith(".html")) return "text/html";
                if (path.endsWith(".js"))   return "application/javascript";
                if (path.endsWith(".css"))  return "text/css";
                if (path.endsWith(".json")) return "application/json";
                return "text/plain";
            }
        });
        
        // Request notification permission (required on Android 13+ for media controls)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
            }
        }

        // Expose native bridge to JS for foreground service control
        getBridge().getWebView().addJavascriptInterface(new TtsBridge(), "TtsBridge");

        // Register callback so native TTS events → JS events
        TtsPlaybackService.setCallback(new TtsPlaybackService.PlaybackCallback() {
            @Override
            public void onSkipPrev() {
                runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new Event('native-media-prev'))", null));
            }
            @Override
            public void onSkipNext() {
                runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new Event('native-media-next'))", null));
            }
            @Override
            public void onChunkStart(int index) {
                runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('native-tts-chunk',{detail:{index:" + index + "}}))", null));
            }
            @Override
            public void onPlaybackDone() {
                runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new Event('native-tts-done'))", null));
            }
            @Override
            public void onChapterAdvance(String chapterId) {
                String safeId = chapterId != null ? chapterId.replace("'", "\\'") : "";
                runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('native-tts-chapter-advance',{detail:{chapterId:'" + safeId + "'}}))", null));
            }
            @Override
            public void onStateChanged(boolean playing, int chunkIndex) {
                runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('native-tts-state',{detail:{playing:" + playing + ",index:" + chunkIndex + "}}))", null));
            }
        });
    }

    /**
     * Request audio focus so TTS can play when app is backgrounded or screen is off.
     * Critical for continuous listening experience.
     */
    private boolean pausedByFocusLoss = false;

    private final AudioManager.OnAudioFocusChangeListener audioFocusListener = focusChange -> {
        switch (focusChange) {
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                // Temporary loss (e.g. notification sound) — pause natively, no JS needed
                pausedByFocusLoss = true;
                TtsPlaybackService.pausePlayback();
                break;
            case AudioManager.AUDIOFOCUS_LOSS:
                // Permanent loss (e.g. another music app) — pause natively
                pausedByFocusLoss = false;
                TtsPlaybackService.pausePlayback();
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                // Regained focus — resume natively if we paused due to transient loss
                if (pausedByFocusLoss) {
                    pausedByFocusLoss = false;
                    TtsPlaybackService.resumePlayback();
                }
                break;
        }
    };

    private void requestAudioFocus() {
        if (audioManager == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();

            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(audioAttributes)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener(audioFocusListener)
                    .build();

            audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            audioManager.requestAudioFocus(
                    audioFocusListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
            );
        }
    }

    /**
     * Release audio focus when TTS playback ends.
     */
    private void releaseAudioFocus() {
        if (audioManager == null) return;
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
        } else {
            audioManager.abandonAudioFocus(null);
        }
    }

    /**
     * JS interface exposed as window.TtsBridge in the WebView.
     * Allows JavaScript to start/stop the foreground service + audio focus,
     * and update the notification play state.
     */
    private class TtsBridge {
        @JavascriptInterface
        public void startService() {
            if (serviceRunning) return;
            requestAudioFocus();
            Intent intent = new Intent(MainActivity.this, TtsPlaybackService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                MainActivity.this.startForegroundService(intent);
            } else {
                MainActivity.this.startService(intent);
            }
            serviceRunning = true;
        }

        @JavascriptInterface
        public void stopService() {
            if (!serviceRunning) return;
            releaseAudioFocus();
            TtsPlaybackService.stopPlayback();
            Intent intent = new Intent(MainActivity.this, TtsPlaybackService.class);
            MainActivity.this.stopService(intent);
            serviceRunning = false;
        }

        /** Send all chunks to native for uninterrupted playback (no JS callbacks needed) */
        @JavascriptInterface
        public void playChunks(String chunksJson, float rate, float pitch, int startIdx, String title) {
            playChunksWithId(chunksJson, rate, pitch, startIdx, title, null);
        }

        @JavascriptInterface
        public void playChunksWithId(String chunksJson, float rate, float pitch, int startIdx, String title, String chapterId) {
            try {
                org.json.JSONArray arr = new org.json.JSONArray(chunksJson);
                String[] chunks = new String[arr.length()];
                for (int i = 0; i < arr.length(); i++) chunks[i] = arr.getString(i);
                TtsPlaybackService.updateTitle(title);
                TtsPlaybackService.startPlayback(chunks, rate, pitch, startIdx, chapterId);
            } catch (org.json.JSONException e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void pausePlayback() {
            TtsPlaybackService.pausePlayback();
        }

        @JavascriptInterface
        public void resumePlayback() {
            TtsPlaybackService.resumePlayback();
        }

        @JavascriptInterface
        public void stopPlayback() {
            TtsPlaybackService.stopPlayback();
        }

        @JavascriptInterface
        public void setRate(float rate) {
            TtsPlaybackService.setRate(rate);
        }

        @JavascriptInterface
        public void setPitch(float pitch) {
            TtsPlaybackService.setPitch(pitch);
        }

        @JavascriptInterface
        public void updateTitle(String title) {
            TtsPlaybackService.updateTitle(title);
        }

        /** Queue a single next chapter so the service auto-advances without JS. */
        @JavascriptInterface
        public void queueNextChapter(String chunksJson, String chapterId, String title, float rate, float pitch) {
            try {
                org.json.JSONArray arr = new org.json.JSONArray(chunksJson);
                String[] chunks = new String[arr.length()];
                for (int i = 0; i < arr.length(); i++) chunks[i] = arr.getString(i);
                TtsPlaybackService.queueNextChapter(chunks, chapterId, title, rate, pitch);
            } catch (org.json.JSONException e) {
                e.printStackTrace();
            }
        }

        /**
         * Queue ALL remaining chapters at once so the service can play through
         * the entire book without any JS involvement (screen off safe).
         * chaptersJson format: [{"chunks":["...","..."],"chapterId":"abc","title":"Ch 1","rate":1.0,"pitch":1.0}, ...]
         */
        @JavascriptInterface
        public void queueAllChapters(String chaptersJson) {
            try {
                org.json.JSONArray arr = new org.json.JSONArray(chaptersJson);
                for (int i = 0; i < arr.length(); i++) {
                    org.json.JSONObject obj = arr.getJSONObject(i);
                    org.json.JSONArray chunksArr = obj.getJSONArray("chunks");
                    String[] chunks = new String[chunksArr.length()];
                    for (int j = 0; j < chunksArr.length(); j++) chunks[j] = chunksArr.getString(j);
                    String chapterId = obj.getString("chapterId");
                    String title = obj.optString("title", "Đang phát...");
                    float rate = (float) obj.optDouble("rate", 1.0);
                    float pitch = (float) obj.optDouble("pitch", 1.0);
                    TtsPlaybackService.queueNextChapter(chunks, chapterId, title, rate, pitch);
                }
            } catch (org.json.JSONException e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void clearNextChapter() {
            TtsPlaybackService.clearNextChapter();
        }

        /**
         * Set a sleep timer that fires at an absolute epoch-ms timestamp.
         * Uses a Java Handler so it fires even when the WebView is suspended (screen off).
         */
        @JavascriptInterface
        public void setSleepTimer(long expireAtMs) {
            TtsPlaybackService.setSleepTimer(expireAtMs);
        }

        /** Cancel the sleep timer without stopping playback. */
        @JavascriptInterface
        public void cancelSleepTimer() {
            TtsPlaybackService.cancelSleepTimer();
        }

        @JavascriptInterface
        public int getCurrentChunk() {
            return TtsPlaybackService.getCurrentChunk();
        }

        @JavascriptInterface
        public String getCurrentChapterId() {
            String id = TtsPlaybackService.getCurrentChapterId();
            return id != null ? id : "";
        }

        @JavascriptInterface
        public boolean isPlaying() {
            return TtsPlaybackService.isCurrentlyPlaying();
        }
    }

    /**
     * Intercept hardware media button events (earbuds, BT headsets) when the
     * Activity is in the foreground and route them to the TTS service.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN && serviceRunning) {
            int keyCode = event.getKeyCode();
            if (keyCode == KeyEvent.KEYCODE_HEADSETHOOK
                    || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
                if (TtsPlaybackService.isCurrentlyPlaying()) {
                    TtsPlaybackService.pausePlayback();
                } else {
                    TtsPlaybackService.resumePlayback();
                }
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY) {
                TtsPlaybackService.resumePlayback();
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                TtsPlaybackService.pausePlayback();
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
                // Forward to JS callback
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onDestroy() {
        releaseAudioFocus();
        if (serviceRunning) {
            stopService(new Intent(this, TtsPlaybackService.class));
            serviceRunning = false;
        }
        super.onDestroy();
    }
}
