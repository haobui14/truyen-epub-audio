package com.truyenaudio.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.KeyEvent;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Foreground Service that drives native Android TTS playback.
 *
 * Architecture
 * ────────────
 * • Bound via LocalBinder so TtsBridge gets a direct service reference.
 * • All state mutations run on the main thread (mainHandler.post) even when
 *   called back from UtteranceProgressListener (which runs on an internal thread).
 * • volatile fields are used for values read from the WebView JS thread without
 *   going through mainHandler: currentChapterId, currentChunkIdx, isPlaying.
 * • JS events are sent via a static JsEvaluator callback set by TtsBridge so
 *   the service never holds a direct WebView reference.
 */
public class TtsPlaybackService extends Service {

    private static final String TAG = "TtsPlayback";

    // ── Notification ──────────────────────────────────────────────────────────

    private static final String CHANNEL_ID       = "tts_ch";
    private static final String CHANNEL_NAME     = "TruyệnAudio";
    private static final int    NOTIFICATION_ID  = 1;

    // ── Intent actions (from notification buttons) ────────────────────────────

    public static final String ACTION_PLAY_PAUSE = "com.truyenaudio.app.ACTION_PLAY_PAUSE";
    public static final String ACTION_PREV       = "com.truyenaudio.app.ACTION_PREV";
    public static final String ACTION_NEXT       = "com.truyenaudio.app.ACTION_NEXT";
    public static final String ACTION_STOP       = "com.truyenaudio.app.ACTION_STOP";

    // ── Inner types ───────────────────────────────────────────────────────────

    /** A single chapter entry held in the playback queue. */
    public static class ChapterItem {
        List<String> chunks;
        String chapterId;
        String title;
        float rate;
        float pitch;

        ChapterItem(List<String> chunks, String chapterId, String title, float rate, float pitch) {
            this.chunks    = chunks;
            this.chapterId = chapterId;
            this.title     = title;
            this.rate      = rate;
            this.pitch     = pitch;
        }
    }

    /** Lightweight chapter descriptor used for the self-fetch pending playlist. */
    public static class ChapterMeta {
        String chapterId;
        String title;
        float  rate;
        float  pitch;

        ChapterMeta(String chapterId, String title, float rate, float pitch) {
            this.chapterId = chapterId;
            this.title     = title;
            this.rate      = rate;
            this.pitch     = pitch;
        }
    }

    /** Functional interface for dispatching JS to the WebView. */
    public interface JsEvaluator {
        void eval(String js);
    }

    /** LocalBinder giving TtsBridge direct access to the service instance. */
    public class LocalBinder extends Binder {
        public TtsPlaybackService getService() {
            return TtsPlaybackService.this;
        }
    }

    // ── Static JS evaluator (set by TtsBridge) ────────────────────────────────

    private static JsEvaluator sJsEvaluator;

    public static void setJsEvaluator(JsEvaluator evaluator) {
        sJsEvaluator = evaluator;
    }

    // ── Instance state ────────────────────────────────────────────────────────

    private final IBinder binder      = new LocalBinder();
    private Handler       mainHandler;
    private MediaSessionCompat mediaSession;

    // Silent MediaPlayer — plays R.raw.silence at volume 0 before each TTS chunk.
    // Android's TTS engine has its own internal MediaSession that steals earbud/
    // BT button routing from our session. Playing "real" audio (even silence)
    // via MediaPlayer makes Android consider our session as the active media
    // player and stops the TTS engine's session from hijacking button events.
    private MediaPlayer silentPlayer;

    // Periodic re-assertion: TTS engine keeps re-activating its session while
    // speaking. We fight back by re-asserting our session every 3 seconds.
    private static final long REASSERT_INTERVAL_MS = 3_000;
    private final Runnable reassertRunnable = new Runnable() {
        @Override public void run() {
            if (mediaSession != null && isPlaying) {
                mediaSession.setActive(true);
                updatePlaybackState(true);
                mainHandler.postDelayed(this, REASSERT_INTERVAL_MS);
            }
        }
    };

    // CPU wake lock — held while isPlaying is true so the CPU stays awake
    // at chapter boundaries when the TTS engine has released its internal lock.
    private PowerManager.WakeLock wakeLock;

    // TTS engine
    private TextToSpeech  tts;
    private boolean       ttsReady   = false;

    // Playback state — volatile for cross-thread reads from TtsBridge
    volatile boolean      isPlaying         = false;
    volatile int          currentChunkIdx   = -1;
    volatile String       currentChapterId  = "";

    private List<String>  currentChunks;
    private float         currentRate       = 1.0f;
    private float         currentPitch      = 1.0f;
    private String        currentTitle      = "TruyệnAudio";

    // Chapter queue for seamless auto-advance
    private final Queue<ChapterItem> chapterQueue = new LinkedList<>();

    // Chapter IDs that were completed by native auto-advance (screen-off XP recovery).
    // Guarded by its own lock so the @JavascriptInterface thread can read/clear safely.
    private final List<String> completedChapterIds = new ArrayList<>();

    // Self-fetch: Java fetches upcoming chapter text while screen is off so the
    // native queue never empties regardless of book length.
    // pendingPlaylist is set by setPendingPlaylist(); pendingHead tracks next to fetch.
    // All fields guarded by main thread (ioExecutor callbacks post back via mainHandler).
    private List<ChapterMeta>  pendingPlaylist = Collections.emptyList();
    private int                pendingHead     = 0;
    private String             selfFetchBase   = "";
    private String             selfFetchToken  = "";
    private boolean            awaitingFetch   = false;  // queue empty, waiting for fetch result
    private ExecutorService    ioExecutor;
    // Prefetch loop: kickPrefetch() starts a chain of fetch→enqueue→fetch steps.
    // Each chain carries a version number; if the version changes (new playChunks
    // or setPendingPlaylist), stale callbacks silently exit and a new chain starts.
    private int                prefetchVersion   = 0;
    private boolean            prefetchActive    = false;  // a chain step is in flight

    // Watchdog: if onStart doesn't fire within WATCHDOG_MS after tts.speak(),
    // something went wrong (TTS engine stalled, output error, etc.) — retry.
    private static final long WATCHDOG_MS = 8_000;
    private int  watchdogRetries      = 0;
    private static final int MAX_WATCHDOG_RETRIES = 3;
    private final Runnable watchdogRunnable = () -> {
        Log.w(TAG, "WATCHDOG: onStart not received within " + WATCHDOG_MS + "ms"
                + " chunk=" + currentChunkIdx + " ch=" + currentChapterId
                + " retries=" + watchdogRetries);
        if (!isPlaying || currentChunks == null) return;
        watchdogRetries++;
        if (watchdogRetries > MAX_WATCHDOG_RETRIES) {
            Log.e(TAG, "WATCHDOG: max retries exceeded, reinitialising TTS");
            watchdogRetries = 0;
            if (tts != null) { tts.stop(); tts.shutdown(); tts = null; ttsReady = false; }
            initTts();
            return;
        }
        // Retry the speak
        speakChunk(currentChunkIdx);
    };

    // Set to true during auto-advance chapter transitions (chapter→chapter)
    // so playFakeSilence is skipped to avoid MediaPlayer/AudioSession interference
    // at chapter boundaries when screen is off.
    private boolean autoAdvancing = false;

    // Pending playback buffered while TTS engine is still initialising
    private ChapterItem   pendingItem;
    private int           pendingStartIdx;

    // AudioFocus
    private AudioManager         audioManager;
    private AudioFocusRequest    audioFocusRequest; // API 26+
    private boolean              hasFocus          = false;
    private boolean              pausedByTransientLoss = false;

    private final AudioManager.OnAudioFocusChangeListener focusListener =
            focusChange -> mainHandler.post(() -> {
                switch (focusChange) {
                    case AudioManager.AUDIOFOCUS_LOSS:
                        // Permanent loss — pause and give up focus
                        hasFocus = false;
                        pausedByTransientLoss = false;
                        pauseInternal();
                        break;
                    case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                    case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                        // Transient loss — auto-resume when focus returns.
                        // Without this, a notification sound between chunks kills
                        // playback because pauseInternal() sets isPlaying=false
                        // and onChunkFinished bails on the !isPlaying guard.
                        if (isPlaying) pausedByTransientLoss = true;
                        pauseInternal();
                        break;
                    case AudioManager.AUDIOFOCUS_GAIN:
                        hasFocus = true;
                        if (pausedByTransientLoss) {
                            pausedByTransientLoss = false;
                            resumePlayback();
                        }
                        break;
                }
            });

    // Sleep timer
    private final Runnable sleepRunnable = () -> {
        pauseInternal();
        dispatchJs("window.dispatchEvent(new Event('native-tts-done'))");
    };

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        mainHandler   = new Handler(Looper.getMainLooper());
        audioManager  = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TruyenAudio::TtsPlayback");
        wakeLock.setReferenceCounted(false);
        createNotificationChannel();
        setupMediaSession();
        initTts();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Must call startForeground() promptly whenever startForegroundService()
        // was used. Do it unconditionally here so we never hit the 5-second ANR
        // window, even when the service is started before playback begins.
        startForegroundNow();

        // Route media button intents (earbuds / BT) to the MediaSession
        if (mediaSession != null && intent != null) {
            MediaButtonReceiver.handleIntent(mediaSession, intent);
        }

        if (intent != null) {
            String action = intent.getAction();
            if (action != null) {
                switch (action) {
                    case ACTION_PLAY_PAUSE:
                        mainHandler.post(() -> {
                            if (isPlaying) pausePlayback();
                            else           resumePlayback();
                        });
                        break;
                    case ACTION_PREV:
                        mainHandler.post(this::restartCurrentChapter);
                        break;
                    case ACTION_NEXT:
                        mainHandler.post(this::skipToNextChapter);
                        break;
                    case ACTION_STOP:
                        mainHandler.post(this::stopPlayback);
                        break;
                }
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (ioExecutor != null) {
            ioExecutor.shutdownNow();
            ioExecutor = null;
        }
        mainHandler.removeCallbacksAndMessages(null);
        abandonAudioFocus();
        if (silentPlayer != null) {
            silentPlayer.release();
            silentPlayer = null;
        }
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        stopForeground(true);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    // ── TTS initialisation ────────────────────────────────────────────────────

    private void initTts() {
        tts = new TextToSpeech(this, status -> mainHandler.post(() -> {
            if (status != TextToSpeech.SUCCESS) {
                dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-error'," +
                        "{detail:{code:'INIT_FAILED'," +
                        "message:'Kh\u00f4ng th\u1ec3 kh\u1edfi t\u1ea1o gi\u1ecdng \u0111\u1ecdc tr\u00ean thi\u1ebft b\u1ecb.'}}))");
                pendingItem = null;
                return;
            }

            int langResult = tts.setLanguage(new Locale("vi", "VN"));
            if (langResult == TextToSpeech.LANG_MISSING_DATA ||
                    langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-error'," +
                        "{detail:{code:'LANG_UNAVAILABLE'," +
                        "message:'Thi\u1ebft b\u1ecb ch\u01b0a c\u00f3 d\u1eef li\u1ec7u gi\u1ecdng \u0111\u1ecdc ti\u1ebfng Vi\u1ec7t. " +
                        "V\u00e0o C\u00e0i \u0111\u1eb7t \u2192 Tr\u1ee3 n\u0103ng \u2192 Chuy\u1ec3n v\u0103n b\u1ea3n th\u00e0nh gi\u1ecdng n\u00f3i \u0111\u1ec3 c\u00e0i \u0111\u1eb7t.'}}))");
                pendingItem = null;
                return;
            }

            ttsReady = true;
            tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    // Extract index from utterance id "chunk_N"
                    int idx = parseChunkIndex(utteranceId);
                    mainHandler.post(() -> {
                        // Cancel watchdog — TTS engine is alive
                        mainHandler.removeCallbacks(watchdogRunnable);
                        watchdogRetries = 0;
                        onChunkStarted(idx);
                    });
                }

                @Override
                public void onDone(String utteranceId) {
                    int idx = parseChunkIndex(utteranceId);
                    mainHandler.post(() -> onChunkFinished(idx));
                }

                @Override
                public void onError(String utteranceId) {
                    int idx = parseChunkIndex(utteranceId);
                    mainHandler.post(() -> onChunkFinished(idx));
                }
            });

            // Flush any playback that was requested before TTS was ready
            if (pendingItem != null) {
                ChapterItem item = pendingItem;
                int          idx  = pendingStartIdx;
                pendingItem    = null;
                pendingStartIdx = 0;
                startChapter(item, idx);
            }
        }));
    }

    private static int parseChunkIndex(String utteranceId) {
        if (utteranceId != null && utteranceId.startsWith("chunk_")) {
            try { return Integer.parseInt(utteranceId.substring(6)); }
            catch (NumberFormatException ignored) {}
        }
        return -1;
    }

    // ── Chunk lifecycle (always runs on main thread) ──────────────────────────

    private void onChunkStarted(int idx) {
        // currentChunkIdx is already set in speakChunk; just emit the event.
        // Defer JS dispatch so it never interferes with TTS engine operations.
        final int i = idx;
        mainHandler.post(() -> {
            dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-chunk'," +
                    "{detail:{index:" + i + "}}))");
            dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                    "{detail:{playing:true,index:" + i + "}}))");
        });
    }

    private void onChunkFinished(int idx) {
        if (!isPlaying) {
            Log.d(TAG, "onChunkFinished: skipped — isPlaying=false idx=" + idx);
            return;
        }
        if (currentChunks == null) return;

        int next = idx + 1;

        if (next < currentChunks.size()) {
            // Still more chunks in this chapter
            speakChunk(next);
        } else {
            // Chapter finished — try to advance to next queued chapter
            Log.d(TAG, "chapterDone ch=" + currentChapterId
                    + " queue=" + chapterQueue.size()
                    + " prefetchActive=" + prefetchActive
                    + " pendingHead=" + pendingHead + "/" + pendingPlaylist.size()
                    + " awaiting=" + awaitingFetch);
            ChapterItem nextChapter = chapterQueue.poll();
            if (nextChapter != null) {
                Log.d(TAG, "→ advance to " + nextChapter.chapterId);
                String completedId = currentChapterId;
                String newId = nextChapter.chapterId != null ? nextChapter.chapterId : "";
                synchronized (completedChapterIds) {
                    completedChapterIds.add(completedId);
                }
                // Start playing FIRST, then notify JS — dispatchJs uses
                // webView.evaluateJavascript which can stall/defer when WebView is
                // paused (screen off). Doing it after startChapter ensures TTS
                // is already speaking before any WebView interaction.
                autoAdvancing = true;
                startChapter(nextChapter, 0);
                autoAdvancing = false;
                // Deferred JS notification — fire-and-forget
                final String cId = completedId;
                final String nId = newId;
                mainHandler.post(() -> dispatchJs(
                        "window.dispatchEvent(new CustomEvent('native-tts-chapter-advance'," +
                        "{detail:{completedChapterId:'" + cId + "',newChapterId:'" + nId + "}}))"));
            } else if (prefetchActive || pendingHead < pendingPlaylist.size()) {
                // A fetch is in flight or more chapters can be fetched — wait for it.
                // The prefetch callback will call startChapter when it has a result.
                Log.d(TAG, "→ awaitingFetch (prefetch=" + prefetchActive + " pending=" + pendingHead + "/" + pendingPlaylist.size() + ")");
                awaitingFetch = true;
                // Kick prefetch in case it's not already running
                kickPrefetch();
            } else {
                // Nothing left to play — fire done
                Log.d(TAG, "→ fireDone (nothing left)");
                fireDone();
            }
        }
    }

    // ── Speak helpers (always called on main thread) ──────────────────────────

    private void speakChunk(int idx) {
        if (tts == null || !ttsReady || currentChunks == null) return;
        if (idx < 0 || idx >= currentChunks.size()) return;

        currentChunkIdx = idx;
        tts.setSpeechRate(currentRate);
        tts.setPitch(currentPitch);

        // Skip playFakeSilence during auto-advance chapter transitions.
        // Creating/releasing a MediaPlayer at chapter boundaries when the screen
        // is off can cause AudioSession interference, delaying or preventing
        // the TTS engine from starting. Only use it for user-initiated plays.
        if (!autoAdvancing) {
            playFakeSilence();
        }
        // Re-assert our session immediately + with delays to beat TTS engine's
        // async session activation, and kick off the periodic loop.
        reassertMediaSession();

        Bundle params = new Bundle();
        // Use utterance id "chunk_N" so the progress listener can echo index back
        int result = tts.speak(currentChunks.get(idx), TextToSpeech.QUEUE_FLUSH, params, "chunk_" + idx);
        if (result != TextToSpeech.SUCCESS) {
            Log.e(TAG, "tts.speak() FAILED result=" + result + " chunk=" + idx + " ch=" + currentChapterId);
        }
        // Watchdog: if onStart doesn't fire within WATCHDOG_MS, retry
        mainHandler.removeCallbacks(watchdogRunnable);
        mainHandler.postDelayed(watchdogRunnable, WATCHDOG_MS);
    }

    /**
     * Play R.raw.silence at volume 0 via MediaPlayer so Android treats our
     * MediaSession as the active media-playing session. TTS alone does not
     * register as real playback — the TTS engine activates its own internal
     * MediaSession which would otherwise steal earbud button routing.
     */
    private void playFakeSilence() {
        try {
            if (silentPlayer != null) {
                silentPlayer.release();
                silentPlayer = null;
            }
            silentPlayer = MediaPlayer.create(this, R.raw.silence);
            if (silentPlayer != null) {
                silentPlayer.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                silentPlayer.setVolume(0f, 0f);
                silentPlayer.setOnCompletionListener(mp -> {
                    // Use `mp` (the specific completed instance), not the field,
                    // to avoid releasing a newer player created for the next chunk.
                    try { mp.release(); } catch (Exception ignored) {}
                    if (silentPlayer == mp) silentPlayer = null;
                });
                silentPlayer.start();
            }
        } catch (Exception ignored) {
            // Best-effort: don't crash if the resource is unavailable
        }
    }

    /**
     * Force our MediaSession to be the active one.
     * Called after tts.speak() and tts.stop() because the TTS engine's
     * internal MediaSession competes with ours asynchronously.
     * We assert immediately and with short delays to cover the race window.
     */
    private void reassertMediaSession() {
        if (mediaSession == null) return;
        mainHandler.removeCallbacks(reassertRunnable);
        // Immediate + staggered re-assertions to win the race against TTS engine
        mediaSession.setActive(true);
        updatePlaybackState(isPlaying);
        mainHandler.postDelayed(() -> {
            if (mediaSession != null) { mediaSession.setActive(true); updatePlaybackState(isPlaying); }
        }, 300);
        mainHandler.postDelayed(() -> {
            if (mediaSession != null) { mediaSession.setActive(true); updatePlaybackState(isPlaying); }
        }, 1_000);
        mainHandler.postDelayed(() -> {
            if (mediaSession != null) { mediaSession.setActive(true); updatePlaybackState(isPlaying); }
        }, 2_500);
        // Start the periodic loop to keep re-asserting while playing
        if (isPlaying) mainHandler.postDelayed(reassertRunnable, REASSERT_INTERVAL_MS);
    }

    // ── Public API (called by TtsBridge, always on main thread via mainHandler.post) ──

    /**
     * Start playing a new list of chunks.  Calls startForeground so the
     * service is promoted to a foreground service the moment playback begins.
     */
    public void playChunks(List<String> chunks, float rate, float pitch,
                           int startIdx, String title, String chapterId) {
        Log.d(TAG, "playChunks ch=" + chapterId + " chunks=" + (chunks != null ? chunks.size() : 0)
                + " start=" + startIdx + " pendingPlaylist=" + pendingPlaylist.size()
                + " prefetchActive=" + prefetchActive);
        currentChunks    = chunks;
        currentRate      = rate;
        currentPitch     = pitch;
        currentTitle     = (title != null && !title.isEmpty()) ? title : currentTitle;
        currentChapterId = (chapterId != null) ? chapterId : "";
        chapterQueue.clear();

        // Cancel any in-flight prefetch chain (new version = stale callbacks ignored)
        prefetchVersion++;
        prefetchActive = false;
        awaitingFetch  = false;
        pendingHead    = 0;

        setMetadata(currentTitle);
        if (mediaSession != null) mediaSession.setActive(true);

        if (!ttsReady) {
            ChapterItem item = new ChapterItem(chunks, chapterId, title, rate, pitch);
            pendingItem     = item;
            pendingStartIdx = startIdx;
            isPlaying       = true;
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
            updatePlaybackState(true);
            updateNotification();
            return;
        }

        isPlaying = true;
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        requestAudioFocus();
        updatePlaybackState(true);
        updateNotification();
        speakChunk(startIdx);
        // Start prefetching next chapters — pendingPlaylist may already be set
        // by setPendingPlaylist (which runs before playChunks on the mainHandler).
        kickPrefetch();
    }

    public void pausePlayback() {
        pausedByTransientLoss = false; // explicit pause — don't auto-resume
        pauseInternal();
    }

    public void resumePlayback() {
        if (currentChunks == null || currentChunkIdx < 0) return;
        isPlaying = true;
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        if (mediaSession != null) mediaSession.setActive(true);
        requestAudioFocus();
        updatePlaybackState(true);
        updateNotification();
        speakChunk(currentChunkIdx);
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                "{detail:{playing:true,index:" + currentChunkIdx + "}}))");
    }

    public void stopPlayback() {
        mainHandler.removeCallbacks(sleepRunnable);
        mainHandler.removeCallbacks(reassertRunnable);
        mainHandler.removeCallbacks(watchdogRunnable);
        watchdogRetries = 0;
        pausedByTransientLoss = false;
        isPlaying        = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        currentChunks    = null;
        currentChunkIdx  = -1;
        currentChapterId = "";
        pendingItem      = null;
        chapterQueue.clear();
        // Cancel prefetch chain but KEEP pendingPlaylist so playChunks → kickPrefetch
        // can re-use it immediately.
        prefetchVersion++;
        prefetchActive  = false;
        pendingHead     = 0;
        awaitingFetch   = false;
        if (tts != null) tts.stop();
        updatePlaybackState(false);
        if (mediaSession != null) mediaSession.setActive(false);
        abandonAudioFocus();
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                "{detail:{playing:false,index:-1}}))");
        updateNotification();
    }

    /**
     * Skip to the next chapter in the queue. Works even when the screen is off
     * because it runs entirely in Java — no JS round-trip required.
     * If no queued chapter is available, kicks off a self-fetch; if that's also
     * exhausted, fires native-tts-done.
     */
    public void skipToNextChapter() {
        if (tts != null) tts.stop();
        mainHandler.removeCallbacks(watchdogRunnable);

        ChapterItem next = chapterQueue.poll();
        if (next != null) {
            String completedId = currentChapterId;
            String newId = next.chapterId != null ? next.chapterId : "";
            synchronized (completedChapterIds) {
                completedChapterIds.add(completedId);
            }
            // Start playing FIRST, then notify JS (deferred)
            autoAdvancing = true;
            startChapter(next, 0);
            autoAdvancing = false;
            final String cId = completedId;
            final String nId = newId;
            mainHandler.post(() -> dispatchJs(
                    "window.dispatchEvent(new CustomEvent('native-tts-chapter-advance'," +
                    "{detail:{completedChapterId:'" + cId + "',newChapterId:'" + nId + "'}}))"));
        } else if (prefetchActive || pendingHead < pendingPlaylist.size()) {
            String completedId = currentChapterId;
            synchronized (completedChapterIds) {
                completedChapterIds.add(completedId);
            }
            awaitingFetch = true;
            kickPrefetch();
        } else {
            isPlaying = false;
            dispatchJs("window.dispatchEvent(new Event('native-tts-done'))");
            dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                    "{detail:{playing:false,index:" + currentChunkIdx + "}}))");
            updateNotification();
            abandonAudioFocus();
        }
    }

    /**
     * Restart the current chapter from the beginning.
     * Works entirely in Java — no JS round-trip.
     */
    public void restartCurrentChapter() {
        if (currentChunks == null || currentChunks.isEmpty()) return;
        if (tts != null) tts.stop();
        if (!isPlaying) {
            isPlaying = true;
            requestAudioFocus();
        }
        speakChunk(0);
        updatePlaybackState(true);
        updateNotification();
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                "{detail:{playing:true,index:0}}))");
    }

    public void setRate(float rate) {
        currentRate = rate;
        if (tts != null) tts.setSpeechRate(rate);
    }

    public void setPitch(float pitch) {
        currentPitch = pitch;
        if (tts != null) tts.setPitch(pitch);
    }

    public void updateTitle(String title) {
        if (title != null && !title.isEmpty()) {
            currentTitle = title;
            setMetadata(title);
            updateNotification();
        }
    }

    public void queueAllChapters(List<ChapterItem> chapters) {
        chapterQueue.clear();
        chapterQueue.addAll(chapters);
    }

    /**
     * Atomically rebuilds the upcoming chapter queue from {@code chapters},
     * skipping the chapter that is currently being spoken and ignoring duplicates.
     * Unlike {@link #queueAllChapters}, this never re-queues the in-flight chapter,
     * so it is safe to call at any time — including while native is mid-chapter.
     */
    public void mergeQueue(List<ChapterItem> chapters) {
        // Build set of IDs already in the queue + currently playing
        Set<String> existing = new HashSet<>();
        existing.add(currentChapterId != null ? currentChapterId : "");
        existing.add(""); // exclude chapters with no ID
        for (ChapterItem item : chapterQueue) {
            String id = item.chapterId != null ? item.chapterId : "";
            existing.add(id);
        }
        // Only ADD items not already queued — never clear self-fetched chapters
        int added = 0;
        for (ChapterItem item : chapters) {
            String id = item.chapterId != null ? item.chapterId : "";
            if (!id.isEmpty() && existing.add(id)) {
                chapterQueue.add(item);
                added++;
            }
        }
        Log.d(TAG, "mergeQueue: added=" + added + " total=" + chapterQueue.size()
                + " awaitingFetch=" + awaitingFetch);
        if (added > 0 && awaitingFetch && !chapterQueue.isEmpty()) {
            // Chapter finished with empty queue — deliver the first merged chapter now
            awaitingFetch = false;
            ChapterItem next = chapterQueue.poll();
            if (next != null) {
                String completedId = currentChapterId;
                synchronized (completedChapterIds) {
                    completedChapterIds.add(completedId);
                }
                // Start playing FIRST, then notify JS (deferred)
                autoAdvancing = true;
                startChapter(next, 0);
                autoAdvancing = false;
                final String cId = completedId;
                final String nId = next.chapterId;
                mainHandler.post(() -> dispatchJs(
                        "window.dispatchEvent(new CustomEvent('native-tts-chapter-advance'," +
                        "{detail:{completedChapterId:'" + cId +
                        "',newChapterId:'" + nId + "'}}))"));
            }
        }
    }

    public void clearQueue() {
        chapterQueue.clear();
    }

    /**
     * Returns chapter IDs that completed via native auto-advance since the last call,
     * then clears the internal list. Thread-safe for @JavascriptInterface callers.
     */
    public List<String> getAndClearCompletedChapterIds() {
        synchronized (completedChapterIds) {
            List<String> copy = new ArrayList<>(completedChapterIds);
            completedChapterIds.clear();
            return copy;
        }
    }

    public void setSleepTimer(long expireAtMs) {
        mainHandler.removeCallbacks(sleepRunnable);
        long delay = expireAtMs - System.currentTimeMillis();
        if (delay <= 0) {
            mainHandler.post(sleepRunnable);
        } else {
            mainHandler.postDelayed(sleepRunnable, delay);
        }
    }

    public void cancelSleepTimer() {
        mainHandler.removeCallbacks(sleepRunnable);
    }

    /**
     * Provides the service with an ordered list of upcoming chapters and API
     * credentials. Java will self-fetch each chapter's text just before it is
     * needed so the native queue never exhausts even while the screen is off.
     * Safe to call at any time — resets the pending playlist atomically.
     */
    public void setPendingPlaylist(List<ChapterMeta> playlist, String apiBase, String token) {
        Log.d(TAG, "setPendingPlaylist: size=" + (playlist != null ? playlist.size() : 0)
                + " queue=" + chapterQueue.size() + " awaitingFetch=" + awaitingFetch);
        pendingPlaylist = playlist != null ? playlist : Collections.emptyList();
        pendingHead     = 0;
        selfFetchBase   = apiBase != null ? apiBase : "";
        selfFetchToken  = token  != null ? token  : "";
        if (ioExecutor == null || ioExecutor.isShutdown()) {
            ioExecutor = Executors.newCachedThreadPool();
        }
        // Cancel any stale prefetch chain and start fresh
        prefetchVersion++;
        prefetchActive = false;
        kickPrefetch();

        // If chapter ended while waiting for playlist, deliver now
        if (awaitingFetch && !chapterQueue.isEmpty()) {
            awaitingFetch = false;
            ChapterItem next = chapterQueue.poll();
            if (next != null) {
                String completedId = currentChapterId;
                synchronized (completedChapterIds) {
                    completedChapterIds.add(completedId);
                }
                autoAdvancing = true;
                startChapter(next, 0);
                autoAdvancing = false;
                final String cId = completedId;
                final String nId = next.chapterId;
                mainHandler.post(() -> dispatchJs(
                        "window.dispatchEvent(new CustomEvent('native-tts-chapter-advance'," +
                        "{detail:{completedChapterId:'" + cId +
                        "',newChapterId:'" + nId + "'}}))"));
            }
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private void pauseInternal() {
        if (!isPlaying) return;
        isPlaying = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        mainHandler.removeCallbacks(reassertRunnable);
        mainHandler.removeCallbacks(watchdogRunnable);
        watchdogRetries = 0;
        if (tts != null) tts.stop();
        // Re-assert after tts.stop() because stopping TTS may activate its
        // internal session, which would steal earbud resume button routing.
        reassertMediaSession();
        updatePlaybackState(false);
        updateNotification();
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                "{detail:{playing:false,index:" + currentChunkIdx + "}}))");
    }

    // ── Self-fetch helpers (always on main thread except ioExecutor lambda) ──

    /**
     * Cancel any stale prefetch chain and start a fresh one.
     * Safe to call multiple times — only one chain runs at a time.
     */
    private void kickPrefetch() {
        if (prefetchActive) {
            // Already running with the current version — schedule a re-check
            // so the loop picks up any new state (e.g. queue emptied).
            return;
        }
        prefetchActive = true;
        int ver = prefetchVersion; // capture
        Log.d(TAG, "kickPrefetch: ver=" + ver + " queue=" + chapterQueue.size()
                + " pendingHead=" + pendingHead + "/" + pendingPlaylist.size());
        doPrefetchStep(ver);
    }

    /**
     * One step of the prefetch chain. Fetches the next chapter from the pending
     * playlist on the IO thread, posts result to main thread, then recurses.
     * Stops when queue is full, playlist exhausted, or version is stale.
     */
    private void doPrefetchStep(int version) {
        if (version != prefetchVersion) {
            prefetchActive = false;
            return;
        }
        if (ioExecutor == null || ioExecutor.isShutdown()) {
            prefetchActive = false;
            return;
        }

        // Skip chapters already queued or currently playing
        while (pendingHead < pendingPlaylist.size()) {
            String id = pendingPlaylist.get(pendingHead).chapterId;
            if (!isAlreadyQueued(id)) break;
            pendingHead++;
        }

        if (chapterQueue.size() >= 50) {
            prefetchActive = false;
            Log.d(TAG, "doPrefetchStep: queue full (" + chapterQueue.size() + "), stopping");
            return;
        }
        if (pendingHead >= pendingPlaylist.size()) {
            prefetchActive = false;
            Log.d(TAG, "doPrefetchStep: playlist exhausted, stopping");
            // If we were waiting for a fetch but there's nothing left, fire done
            if (awaitingFetch) {
                awaitingFetch = false;
                fireDone();
            }
            return;
        }

        ChapterMeta meta = pendingPlaylist.get(pendingHead);
        pendingHead++;

        final String id    = meta.chapterId;
        final String title = meta.title;
        final float  fRate  = meta.rate;
        final float  fPitch = meta.pitch;
        final String base  = selfFetchBase;
        final String tok   = selfFetchToken;

        Log.d(TAG, "doPrefetchStep: fetching ch=" + id + " ver=" + version);

        ioExecutor.execute(() -> {
            try {
                String url  = base + "/api/chapters/" + id + "/text";
                String body = doHttpGet(url, tok);
                JSONObject json = new JSONObject(body);
                String text = json.optString("text_content", "");
                List<String> chunks = splitChunksJava(text, 20, 4000);

                mainHandler.post(() -> {
                    if (version != prefetchVersion) {
                        Log.d(TAG, "doPrefetchStep: stale ver=" + version + " cur=" + prefetchVersion);
                        // Don't touch prefetchActive — a newer chain owns it.
                        return;
                    }

                    if (chunks.isEmpty()) {
                        Log.d(TAG, "doPrefetchStep: empty chapter " + id + ", skipping");
                        doPrefetchStep(version); // skip and continue
                        return;
                    }

                    ChapterItem item = new ChapterItem(chunks, id, title, fRate, fPitch);

                    if (awaitingFetch) {
                        // Chapter ended and queue was empty — play this immediately.
                        // Reset prefetchActive BEFORE startChapter so that
                        // startChapter → kickPrefetch() can start a fresh chain.
                        awaitingFetch = false;
                        prefetchActive = false;
                        Log.d(TAG, "doPrefetchStep: delivering ch=" + id + " to awaiting player");
                        String completedId = currentChapterId;
                        synchronized (completedChapterIds) {
                            completedChapterIds.add(completedId);
                        }
                        // Start playing FIRST, then notify JS (deferred)
                        autoAdvancing = true;
                        startChapter(item, 0);
                        autoAdvancing = false;
                        final String cId = completedId;
                        mainHandler.post(() -> dispatchJs(
                                "window.dispatchEvent(new CustomEvent('native-tts-chapter-advance'," +
                                "{detail:{completedChapterId:'" + cId +
                                "',newChapterId:'" + id + "'}}))"));
                        // startChapter calls kickPrefetch, which will continue the chain
                    } else {
                        if (!isAlreadyQueued(id)) {
                            chapterQueue.add(item);
                            Log.d(TAG, "doPrefetchStep: queued ch=" + id
                                    + " total=" + chapterQueue.size());
                        }
                        doPrefetchStep(version); // continue chain
                    }
                });
            } catch (Exception e) {
                Log.w(TAG, "doPrefetchStep: fetch error ch=" + id, e);
                mainHandler.post(() -> {
                    if (version != prefetchVersion) {
                        // Don't touch prefetchActive — a newer chain owns it now.
                        return;
                    }
                    if (awaitingFetch) {
                        // Retry after 3 seconds — chapter is needed urgently
                        Log.d(TAG, "doPrefetchStep: retrying ch=" + id + " in 3s (awaiting)");
                        pendingHead--; // re-try same chapter
                        mainHandler.postDelayed(() -> {
                            if (version != prefetchVersion) {
                                return;
                            }
                            doPrefetchStep(version);
                        }, 3_000);
                    } else {
                        // Non-urgent failure — retry after 5s so the queue keeps
                        // filling even when a single fetch hiccups (e.g. transient
                        // network glitch). Without this, a single failure silently
                        // kills the prefetch chain and the queue runs dry.
                        Log.d(TAG, "doPrefetchStep: non-urgent err, retrying in 5s ch=" + id);
                        pendingHead--; // re-try same chapter
                        mainHandler.postDelayed(() -> {
                            if (version != prefetchVersion) {
                                return;
                            }
                            doPrefetchStep(version);
                        }, 5_000);
                    }
                });
            }
        });
    }

    private boolean isAlreadyQueued(String id) {
        if (id == null || id.isEmpty()) return true;
        if (id.equals(currentChapterId)) return true;
        for (ChapterItem item : chapterQueue) {
            if (id.equals(item.chapterId)) return true;
        }
        return false;
    }

    /** Called on ioExecutor thread; posts result back to main thread. */
    private void fireDone() {
        Log.d(TAG, "fireDone: ch=" + currentChapterId);
        isPlaying = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        dispatchJs("window.dispatchEvent(new Event('native-tts-done'))");
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                "{detail:{playing:false,index:" + currentChunkIdx + "}}))");
        updateNotification();
        abandonAudioFocus();
    }

    private String doHttpGet(String urlStr, String token) throws IOException {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(30_000);
        if (token != null && !token.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }
        conn.setRequestProperty("Accept", "application/json");
        int code = conn.getResponseCode();
        if (code != 200) throw new IOException("HTTP " + code);
        BufferedReader reader = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);
        reader.close();
        return sb.toString();
    }

    /** Java port of frontend/lib/textChunks.ts splitIntoChunks. */
    private List<String> splitChunksJava(String text, int targetCount, int hardMaxLen) {
        if (text == null || text.isEmpty()) return Collections.emptyList();
        String[] sentences = text.split("(?<=[.!?\\n])");
        int softMaxLen = Math.max((int) Math.ceil((double) text.length() / targetCount), 50);
        int maxLen = Math.min(softMaxLen, hardMaxLen);
        List<String> chunks  = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (String s : sentences) {
            if (cur.length() + s.length() > maxLen && cur.length() > 0) {
                String trimmed = cur.toString().trim();
                if (!trimmed.isEmpty()) chunks.add(trimmed);
                cur = new StringBuilder(s);
            } else {
                cur.append(s);
            }
        }
        String last = cur.toString().trim();
        if (!last.isEmpty()) chunks.add(last);
        return chunks;
    }

    private void startChapter(ChapterItem item, int startIdx) {
        currentChunks    = item.chunks;
        currentRate      = item.rate;
        currentPitch     = item.pitch;
        currentChapterId = (item.chapterId != null) ? item.chapterId : "";
        if (item.title != null && !item.title.isEmpty()) currentTitle = item.title;

        awaitingFetch = false;

        isPlaying = true;
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        pausedByTransientLoss = false;
        requestAudioFocus();

        setMetadata(currentTitle);
        if (mediaSession != null) mediaSession.setActive(true);
        updatePlaybackState(true);
        updateNotification();
        speakChunk(startIdx);
        kickPrefetch();
    }

    private void startForegroundNow() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void dispatchJs(String js) {
        JsEvaluator evaluator = sJsEvaluator;
        if (evaluator != null) {
            evaluator.eval(js);
        }
    }

    // ── AudioFocus ────────────────────────────────────────────────────────────

    private void requestAudioFocus() {
        if (hasFocus || audioManager == null) return;
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(focusListener, mainHandler)
                    .build();
            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            //noinspection deprecation
            result = audioManager.requestAudioFocus(
                    focusListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN);
        }
        hasFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
            audioFocusRequest = null;
        } else {
            //noinspection deprecation
            audioManager.abandonAudioFocus(focusListener);
        }
        hasFocus = false;
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Phát TTS nền");
            channel.setShowBadge(false);
            channel.enableVibration(false);
            channel.setSound(null, null);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        // Tap notification → open app
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // Prev chunk action
        PendingIntent prevPi = buildActionIntent(ACTION_PREV, 10);
        // Play/Pause toggle action
        PendingIntent playPausePi = buildActionIntent(ACTION_PLAY_PAUSE, 11);
        // Next chunk action
        PendingIntent nextPi = buildActionIntent(ACTION_NEXT, 12);
        // Stop action
        PendingIntent stopPi = buildActionIntent(ACTION_STOP, 13);

        int toggleIcon  = isPlaying ? android.R.drawable.ic_media_pause
                                    : android.R.drawable.ic_media_play;
        String toggleLabel = isPlaying ? "Tạm dừng" : "Phát";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("TruyệnAudio")
                .setContentText(currentTitle)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(contentIntent)
                .setOngoing(isPlaying)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .addAction(android.R.drawable.ic_media_previous, "Trước", prevPi)
                .addAction(toggleIcon, toggleLabel, playPausePi)
                .addAction(android.R.drawable.ic_media_next, "Tiếp", nextPi)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dừng", stopPi)
                .setStyle(new MediaStyle()
                        .setMediaSession(mediaSession != null ? mediaSession.getSessionToken() : null)
                        .setShowActionsInCompactView(0, 1, 2));

        return builder.build();
    }

    private PendingIntent buildActionIntent(String action, int requestCode) {
        Intent intent = new Intent(this, TtsPlaybackService.class);
        intent.setAction(action);
        return PendingIntent.getService(
                this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void updateNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
    }

    // ── MediaSession ──────────────────────────────────────────────────────────

    @SuppressWarnings("deprecation")
    private void setupMediaSession() {
        mediaSession = new MediaSessionCompat(this, "TruyenAudioTTS");
        mediaSession.setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent sessionActivity = PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        mediaSession.setSessionActivity(sessionActivity);

        // Route media button intents from earbuds/BT to this MediaSession
        android.content.ComponentName mbr =
                new android.content.ComponentName(this, TtsPlaybackService.class);
        Intent mediaButtonIntent = new Intent(Intent.ACTION_MEDIA_BUTTON);
        mediaButtonIntent.setComponent(mbr);
        PendingIntent mbrPending = PendingIntent.getService(
                this, 0, mediaButtonIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        mediaSession.setMediaButtonReceiver(mbrPending);

        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public boolean onMediaButtonEvent(Intent mediaButtonEvent) {
                KeyEvent event = mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (event != null && event.getAction() == KeyEvent.ACTION_DOWN) {
                    int keyCode = event.getKeyCode();
                    if (keyCode == KeyEvent.KEYCODE_HEADSETHOOK
                            || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
                        mainHandler.post(() -> { if (isPlaying) pausePlayback(); else resumePlayback(); });
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY) {
                        mainHandler.post(TtsPlaybackService.this::resumePlayback);
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                        mainHandler.post(TtsPlaybackService.this::pausePlayback);
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_STOP) {
                        mainHandler.post(TtsPlaybackService.this::stopPlayback);
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
                        mainHandler.post(TtsPlaybackService.this::skipToNextChapter);
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
                        mainHandler.post(TtsPlaybackService.this::restartCurrentChapter);
                        return true;
                    }
                }
                return super.onMediaButtonEvent(mediaButtonEvent);
            }

            @Override public void onPlay()  { mainHandler.post(TtsPlaybackService.this::resumePlayback); }
            @Override public void onPause() { mainHandler.post(TtsPlaybackService.this::pausePlayback); }
            @Override public void onStop()  { mainHandler.post(TtsPlaybackService.this::stopPlayback); }
            @Override public void onSkipToPrevious() {
                mainHandler.post(TtsPlaybackService.this::restartCurrentChapter);
            }
            @Override public void onSkipToNext() {
                mainHandler.post(TtsPlaybackService.this::skipToNextChapter);
            }
        });

        setMetadata(currentTitle);
        updatePlaybackState(false);
    }

    private void updatePlaybackState(boolean playing) {
        if (mediaSession == null) return;
        long actions = PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_STOP;
        int state = playing ? PlaybackStateCompat.STATE_PLAYING
                            : PlaybackStateCompat.STATE_PAUSED;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());
    }

    private void setMetadata(String title) {
        if (mediaSession == null) return;
        mediaSession.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "Truy\u1ec7nAudio")
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM,  "Truy\u1ec7nAudio")
                .build());
    }
}
