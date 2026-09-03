package com.truyenaudio.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
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
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaSessionService;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.util.Log;
import com.truyenaudio.app.BuildConfig;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Foreground Service that drives native Android TTS playback.
 *
 * <h2>Architecture</h2>
 * <ul>
 * <li>Bound via LocalBinder so TtsBridge gets a direct service reference.</li>
 * <li>All state mutations run on the main thread (mainHandler.post) even when
 *     called back from UtteranceProgressListener (which runs on an internal
 *     thread).</li>
 * <li>volatile fields are used for values read from the WebView JS thread
 *     without going through mainHandler: currentChapterId, currentChunkIdx,
 *     isPlaying.</li>
 * <li>JS events are sent via a static JsEvaluator callback set by TtsBridge so
 *     the service never holds a direct WebView reference.</li>
 * </ul>
 *
 * <h2>State machine (summary)</h2>
 * <pre>
 *  idle ──play──▶ playing ──pause──▶ paused
 *   ▲               │                    │
 *   │      chapter-end (queue empty)     │
 *   │               ▼                    │
 *   │        awaitingFetch ◀─────────────┤ resume
 *   │               │                    │
 *   │   playlist exhausted               │
 *   │               ▼                    │
 *   │    fire 'native-tts-done'          │
 *   └──────────── idle ◀─────────────────┘
 * </pre>
 * Full diagram, state inventory, event flow, and the numbered invariants (I1–I9)
 * referenced throughout this file live in {@code docs/android-player.md}.
 *
 * <h2>Key invariants (edit carefully)</h2>
 * <ol>
 *   <li><b>I1</b>: {@code awaitingFetch} ⇒ (the playlist-successor of
 *       {@code currentChapterId} is not in {@code chapterQueue} ∨
 *       {@code !isPlaying}). The three awaitingFetch-delivery sites
 *       ({@link #mergeQueue}, {@link #setPendingPlaylist}, the
 *       {@link #doPrefetchStep} success path) gate on {@code isPlaying} so a
 *       user pause during the awaitingFetch window isn't overridden.</li>
 *   <li><b>I9</b>: every auto-advance delivery goes through
 *       {@link #pollNextChapter()} — the queue is fed by TWO producers (the
 *       self-fetch chain in playlist order, JS merges in cache order), so the
 *       FIFO head is not necessarily the next chapter. Deliver only the
 *       {@code pendingPlaylist} successor of {@code currentChapterId}.</li>
 *   <li><b>I2</b>: {@code prefetchActive} ⇒ a fetch task is pending on
 *       ioExecutor. {@code prefetchVersion++} is the ONLY sanctioned way to
 *       invalidate an in-flight fetch.</li>
 *   <li><b>I3</b>: {@code autoAdvancing=true} only inside
 *       {@link #deliverAutoAdvance}'s call to {@link #startChapter} — suppresses
 *       playFakeSilence + MediaSession re-assertion at chapter boundaries.</li>
 *   <li><b>I7</b>: {@link #doPrefetchStep} re-derives {@code pendingHead} from
 *       the current chapter's position in {@code pendingPlaylist} every step, so
 *       a stale {@code pendingHead} (left forward by a {@code chapterQueue.clear()}
 *       or behind by a screen-off advance) can never fetch the wrong chapter. If
 *       the current chapter isn't in the playlist at all, the playlist is stale
 *       (seeded for a different position; the screen-off WebView couldn't
 *       re-seed it) and self-fetch stops rather than jumping the listener.</li>
 * </ol>
 *
 * <h2>Helpers</h2>
 * <ul>
 *   <li>{@link #deliverAutoAdvance(ChapterItem, String)} — single entry point
 *       for auto-advance chapter transitions (5 call sites).</li>
 *   <li>{@link #dispatchChapterAdvance(String, String)} — emits the JS event.</li>
 * </ul>
 */
@OptIn(markerClass = UnstableApi.class)
public class TtsPlaybackService extends MediaSessionService {

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
    public static final String ACTION_BACK_CHUNK = "com.truyenaudio.app.ACTION_BACK_CHUNK";

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

    static final class MediaChapterSnapshot {
        final String chapterId;
        final String title;
        final String bookTitle;
        final String coverUrl;
        final long durationMs;
        final boolean current;

        MediaChapterSnapshot(String chapterId, String title, String bookTitle,
                String coverUrl, long durationMs, boolean current) {
            this.chapterId = chapterId;
            this.title = title;
            this.bookTitle = bookTitle;
            this.coverUrl = coverUrl;
            this.durationMs = durationMs;
            this.current = current;
        }
    }

    /** Immutable payload captured on the main thread for serialized delivery. */
    private static final class ProgressUpdate {
        final String apiBase;
        final String accessToken;
        final String body;

        ProgressUpdate(String apiBase, String accessToken, String body) {
            this.apiBase = apiBase;
            this.accessToken = accessToken;
            this.body = body;
        }
    }

    private static final class HttpStatusException extends IOException {
        final int statusCode;

        HttpStatusException(int statusCode) {
            super("HTTP " + statusCode);
            this.statusCode = statusCode;
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
    private androidx.media3.session.MediaSession media3Session;
    private TtsMedia3Player media3Player;
    private NativeOfflineStore offlineStore;
    private SecureAuthStore secureAuthStore;
    private ExecutorService progressExecutor;
    private LatestProgressSync<ProgressUpdate> progressSync;

    // Silent MediaPlayer — plays R.raw.silence at volume 0 before each TTS chunk.
    // Android's TTS engine has its own internal MediaSession that steals earbud/
    // BT button routing from our session. Playing "real" audio (even silence)
    // via MediaPlayer makes Android consider our session as the active media
    // player and stops the TTS engine's session from hijacking button events.
    private MediaPlayer silentPlayer;

    // False once playback ends for an external reason (permanent audio-focus
    // loss, stop): the staggered re-assertions in reassertMediaSession() must
    // not re-activate a session we have deliberately relinquished. Set true in
    // requestAudioFocus() — every playback (re)start path goes through it.
    private boolean sessionWanted = false;

    // Periodic re-assertion: TTS engine keeps re-activating its session while
    // speaking. We fight back by re-asserting our session every 3 seconds.
    private static final long REASSERT_INTERVAL_MS = 3_000;
    private final Runnable reassertRunnable = new Runnable() {
        @Override public void run() {
            if (mediaSession != null && sessionWanted && isPlaying) {
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

    // User-selected device voice (one of the Vietnamese voices installed on
    // this device). Empty = engine default for vi-VN. Applied on init and
    // re-applied after watchdog engine reinits; persisted in the session
    // snapshot so it survives a process kill.
    private String preferredVoiceName = "";
    // JSON array of the installed Vietnamese voices, built once the engine is
    // ready; read by TtsBridge.getNativeVoices() from the WebView thread
    // (hence volatile).
    volatile String availableVoicesJson = "[]";

    // JSON snapshot of currentChunks, refreshed on the main thread whenever
    // currentChunks changes; read by TtsBridge.getCurrentChunksJson() from the
    // WebView thread (hence volatile — the List itself is not thread-safe).
    // Lets JS recover the playing chapter's text when it has no cached copy:
    // after a screen-off multi-chapter advance the current chapter was often
    // self-fetched by Java only, so an offline app-reopen used to show a
    // "no connection" error while that very chapter was audibly playing.
    volatile String currentChunksJson = "[]";

    // Playback state — volatile for cross-thread reads from TtsBridge
    volatile boolean      isPlaying         = false;
    volatile int          currentChunkIdx   = -1;
    volatile String       currentChapterId  = "";

    private List<String>  currentChunks;
    private float         currentRate       = 1.0f;
    private float         currentPitch      = 1.0f;
    // Read from the WebView JS thread via TtsBridge (getCurrentTitle /
    // getTotalChunks / getCurrentBookId) — volatile like the fields above.
    volatile String       currentTitle      = "TruyệnAudio";
    volatile int          currentTotalChunks = 0;
    volatile String       currentBookId     = "";
    volatile String       currentBookTitle  = "";

    // ── Estimated chapter timeline (lockscreen / notification seek bar) ──────
    // The TTS engine reports no duration, so estimate one from text length:
    // Vietnamese TTS at 1.0× speaks roughly CHARS_PER_SECOND chars/sec. All
    // values are "content time" at 1.0×; updatePlaybackState passes currentRate
    // as the playback speed so the OS extrapolates the moving position
    // correctly at any rate. Estimation error only skews the time labels —
    // seeking stays exact because onSeekTo maps the scrubbed position back to
    // a chunk index through the same table.
    private ChapterTimeline chapterTimeline = ChapterTimeline.fromChunks(null);

    // Cover art for the media notification / lockscreen. Loaded async from the
    // book's cover_url (set via updateCover) and cached by URL.
    volatile String         currentCoverUrl    = "";
    private Bitmap          currentCoverBitmap = null;
    private ExecutorService coverExecutor;
    // Jade accent (matches the web app + res/values/colors.xml colorAccent).
    private static final int NOTIF_ACCENT = 0xFF46B98E;

    // Chapter queue for seamless auto-advance
    private final Queue<ChapterItem> chapterQueue = new LinkedList<>();

    // Buffer for mergeQueue calls that arrive BEFORE playChunks runs.
    // mergeQueuedChapters (from JS) is often posted to mainHandler before
    // playChunksWithId because the chapter text loads asynchronously and
    // playChunks clears the queue. We save the items here and re-apply
    // them immediately after playChunks clears the queue.
    private List<ChapterItem> pendingMergeBuffer = null;

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
    private volatile String    selfFetchToken  = "";
    private boolean            awaitingFetch   = false;  // queue empty, waiting for fetch result
    private ExecutorService    ioExecutor;
    // Prefetch loop: kickPrefetch() starts a chain of fetch→enqueue→fetch steps.
    // Each chain carries a version number; if the version changes (new playChunks
    // or setPendingPlaylist), stale callbacks silently exit and a new chain starts.
    private int                prefetchVersion   = 0;
    private boolean            prefetchActive    = false;  // a chain step is in flight
    // Chapter IDs that self-fetch found to have no text (e.g. still converting).
    // Tracked so doPrefetchStep's pendingHead re-derivation skips past them
    // instead of re-selecting the same empty chapter forever. Cleared on stop.
    private final Set<String>  emptyChapterIds   = new HashSet<>();

    // ── Durable session persistence + background progress sync ──────────────
    // The session snapshot (book/chapter/chunk/playlist head) is written to
    // SharedPreferences on every chunk start and chapter transition so an OS
    // process kill never loses the listening position. onCreate() restores the
    // snapshot as a PAUSED session; onStartCommand() auto-resumes it when the
    // kill→restart gap is short (START_STICKY). Listening progress is also PUT
    // to the server on a throttle so other devices (and cold starts) stay in
    // sync even when the WebView has been suspended for hours.
    // Package-visible: TtsBridge reads PREFS_KEY_LAST_POSITION directly so the
    // value is available even before the service finishes binding.
    static final String PREFS_NAME              = "tts_session";
    static final String PREFS_KEY_SESSION       = "session";
    // Last listening position. Unlike the session snapshot it SURVIVES
    // stopPlayback (swipe-away, explicit stop) — it cannot resume a zombie
    // service, it only tells the UI where listening last stood on this device.
    static final String PREFS_KEY_LAST_POSITION = "last_position";
    private static final long   AUTO_RESUME_WINDOW_MS = 2 * 60_000;
    private static final int    PERSIST_PLAYLIST_CAP  = 50;
    private static final long   PROGRESS_SYNC_INTERVAL_MS = 30_000;
    private long    lastProgressSyncMs  = 0;
    private boolean restoredWasPlaying  = false;
    private long    restoredAtMs        = 0;     // wall-clock ts of the restored snapshot
    private boolean autoResumeConsumed  = false; // sticky-restart auto-resume fires once
    private boolean restoringSession    = false; // restore text-fetch in flight

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
            // Save the current chapter so initTts() replays it after reinit.
            // Without this, pendingItem is null after reinit and playback stops
            // permanently — the primary cause of screen-off chapter stall.
            if (currentChunks != null && currentChunkIdx >= 0) {
                pendingItem = new ChapterItem(
                        new ArrayList<>(currentChunks),
                        currentChapterId, currentTitle, currentRate, currentPitch);
                pendingStartIdx = currentChunkIdx;
            }
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
                        // Permanent loss — another app owns audio now. Pause,
                        // give up focus AND deactivate the MediaSession so the
                        // lockscreen/media picker stop advertising this player
                        // and earbud buttons route to the new owner.
                        // sessionWanted=false stops the staggered re-assertions
                        // scheduled by pauseInternal → reassertMediaSession from
                        // re-activating the session behind our back.
                        Log.d(TAG, "AudioFocus: LOSS (permanent), isPlaying=" + isPlaying);
                        hasFocus = false;
                        pausedByTransientLoss = false;
                        sessionWanted = false;
                        pauseInternal();
                        abandonAudioFocus();
                        if (mediaSession != null) mediaSession.setActive(false);
                        break;
                    case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                    case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                        // Transient loss — auto-resume when focus returns.
                        // Without this, a notification sound between chunks kills
                        // playback because pauseInternal() sets isPlaying=false
                        // and onChunkFinished bails on the !isPlaying guard.
                        Log.d(TAG, "AudioFocus: LOSS_TRANSIENT, isPlaying=" + isPlaying);
                        if (isPlaying) pausedByTransientLoss = true;
                        pauseInternal();
                        break;
                    case AudioManager.AUDIOFOCUS_GAIN:
                        Log.d(TAG, "AudioFocus: GAIN, pausedByTransient=" + pausedByTransientLoss);
                        hasFocus = true;
                        if (pausedByTransientLoss) {
                            pausedByTransientLoss = false;
                            resumePlayback();
                        }
                        break;
                }
            });

    // Sleep timer. detail.sleep lets JS distinguish "sleep timer stopped
    // playback mid-chapter" from "playlist exhausted" — onDone must NOT
    // auto-advance to the next chapter on a sleep stop.
    private final Runnable sleepRunnable = () -> {
        pauseInternal();
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-done'," +
                "{detail:{sleep:true}}))");
    };

    // Sleep at the NEXT chapter boundary instead of a wall-clock time.
    // Honored in onChunkFinished, entirely in Java, so it works while the
    // screen is off. One-shot: cleared when it fires, on setSleepTimer /
    // cancelSleepTimer (the two modes are exclusive), and on stopPlayback.
    private boolean sleepAtChapterEnd = false;

    // Pause when headphones unplug / Bluetooth disconnects, so audio
    // doesn't suddenly blast out of the phone speaker.
    private boolean noisyReceiverRegistered = false;
    private final BroadcastReceiver becomingNoisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null && AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                Log.d(TAG, "BECOMING_NOISY received — pausing");
                mainHandler.post(() -> { if (isPlaying) pausePlayback(); });
            }
        }
    };

    // Second, more reliable signal for "the earbuds the user was listening
    // through are gone". ACTION_AUDIO_BECOMING_NOISY (above) covers wired and
    // classic A2DP unplugs, but it does not always fire for Bluetooth / LE Audio
    // earbuds that drop their connection without a clean output-route change
    // (e.g. battery dies, taken out of range, one bud removed). onAudioDevicesRemoved
    // catches those cases so playback is always paused instead of suddenly
    // blasting out of the phone speaker.
    private boolean deviceCallbackRegistered = false;
    private final AudioDeviceCallback audioDeviceCallback = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            if (removed == null) return;
            for (AudioDeviceInfo dev : removed) {
                if (dev != null && dev.isSink() && isHeadphoneType(dev.getType())) {
                    Log.d(TAG, "audio output device removed (earbud/headphone) — pausing");
                    mainHandler.post(() -> { if (isPlaying) pausePlayback(); });
                    return;
                }
            }
        }
    };

    /** True for wired / Bluetooth / USB headphone & earbud output device types. */
    private static boolean isHeadphoneType(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_HEARING_AID:   // API 28+, constant inlined at compile time
            case AudioDeviceInfo.TYPE_BLE_HEADSET:   // API 31+, constant inlined at compile time
                return true;
            default:
                return false;
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        mainHandler   = new Handler(Looper.getMainLooper());
        offlineStore  = new NativeOfflineStore(this);
        secureAuthStore = new SecureAuthStore(this);
        progressExecutor = Executors.newSingleThreadExecutor();
        progressSync = new LatestProgressSync<>(
                progressExecutor,
                this::sendProgressUpdate,
                error -> Log.w(TAG, "progress sync failed: " + error));
        coverExecutor = Executors.newSingleThreadExecutor();
        audioManager  = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TruyenAudio::TtsPlayback");
        wakeLock.setReferenceCounted(false);
        createNotificationChannel();
        // During parity rollout both notification implementations share one ID,
        // preventing duplicate media cards while Media3 controllers are tested.
        setMediaNotificationProvider(
                new androidx.media3.session.DefaultMediaNotificationProvider.Builder(this)
                        .setChannelId(CHANNEL_ID)
                        .setNotificationId(NOTIFICATION_ID)
                        .build());
        setupMediaSession();
        media3Player = new TtsMedia3Player(this, Looper.getMainLooper());
        media3Session = new androidx.media3.session.MediaSession.Builder(this, media3Player)
                .setId("TruyenAudioTTS-Media3")
                .build();
        initTts();

        // Restore the last session snapshot (as paused). This gives the bridge
        // a valid chapter id / chunk index immediately after a process restart
        // so JS cold-start sync and "continue listening" land where playback
        // actually stopped — even if it stopped while the screen was off.
        restoreSession();

        IntentFilter noisyFilter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(becomingNoisyReceiver, noisyFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(becomingNoisyReceiver, noisyFilter);
        }
        noisyReceiverRegistered = true;

        // Reliable earbud/headphone-removal detection (covers BT / LE Audio drops
        // that ACTION_AUDIO_BECOMING_NOISY can miss). registerAudioDeviceCallback
        // is API 23+; minSdk is 24 so no version guard is needed.
        if (audioManager != null) {
            audioManager.registerAudioDeviceCallback(audioDeviceCallback, mainHandler);
            deviceCallbackRegistered = true;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Let MediaSessionService process controller and resumption intents
        // before applying the legacy bridge actions kept during parity mode.
        super.onStartCommand(intent, flags, startId);
        // Must call startForeground() promptly whenever startForegroundService()
        // was used. Do it unconditionally here so we never hit the 5-second ANR
        // window, even when the service is started before playback begins.
        startForegroundNow();

        // START_STICKY restart after the OS killed the process mid-playback:
        // intent == null only on a system restart (every app-initiated start
        // carries an intent). If the kill happened moments ago while audio was
        // playing, pick the session back up — the user perceives an
        // uninterrupted listen instead of waking up to silence.
        if (intent == null && !autoResumeConsumed) {
            autoResumeConsumed = true;
            if (restoredWasPlaying && currentChunks == null
                    && !currentChapterId.isEmpty()
                    && System.currentTimeMillis() - restoredAtMs < AUTO_RESUME_WINDOW_MS) {
                Log.d(TAG, "auto-resume after process kill: ch=" + currentChapterId);
                mainHandler.post(this::resumeFromRestoredSession);
            }
        }

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
                    case ACTION_BACK_CHUNK:
                        mainHandler.post(() -> seekToChunk(currentChunkIdx - 1));
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

    /**
     * Called when the user swipes the app away from Recents. A started
     * foreground service otherwise keeps running — so without this, audio
     * would continue after the user intentionally closed the app. Stop
     * playback and tear the service down; cold-start sync on next launch
     * will start fresh from the last saved chapter/chunk.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.d(TAG, "onTaskRemoved — user swiped app away, stopping service");
        stopPlayback();
        stopForeground(true);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (noisyReceiverRegistered) {
            try { unregisterReceiver(becomingNoisyReceiver); } catch (Exception ignored) {}
            noisyReceiverRegistered = false;
        }
        if (deviceCallbackRegistered && audioManager != null) {
            try { audioManager.unregisterAudioDeviceCallback(audioDeviceCallback); } catch (Exception ignored) {}
            deviceCallbackRegistered = false;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (ioExecutor != null) {
            ioExecutor.shutdownNow();
            ioExecutor = null;
        }
        if (coverExecutor != null) {
            coverExecutor.shutdownNow();
            coverExecutor = null;
        }
        if (progressExecutor != null) {
            progressExecutor.shutdownNow();
            progressExecutor = null;
        }
        progressSync = null;
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
        if (media3Session != null) {
            media3Session.release();
            media3Session = null;
        }
        if (media3Player != null) {
            media3Player.release();
            media3Player = null;
        }
        stopForeground(true);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        if (intent != null
                && "androidx.media3.session.MediaSessionService".equals(intent.getAction())) {
            return super.onBind(intent);
        }
        return binder;
    }

    @Nullable
    @Override
    public androidx.media3.session.MediaSession onGetSession(
            androidx.media3.session.MediaSession.ControllerInfo controllerInfo) {
        return media3Session;
    }

    // ── TTS initialisation ────────────────────────────────────────────────────

    private void initTts() {
        tts = new TextToSpeech(this, status -> mainHandler.post(() -> {
            if (status != TextToSpeech.SUCCESS) {
                dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-error'," +
                        "{detail:{code:'INIT_FAILED'," +
                        "message:'Kh\u00f4ng th\u1ec3 kh\u1edfi t\u1ea1o gi\u1ecdng \u0111\u1ecdc tr\u00ean thi\u1ebft b\u1ecb.'}}))");
                pendingItem = null;
                releaseAfterFailedInit();
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
                releaseAfterFailedInit();
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
                public void onError(String utteranceId, int errorCode) {
                    final int idx = parseChunkIndex(utteranceId);
                    mainHandler.post(() -> {
                        // onChunkFinished already no-ops when !isPlaying, so a
                        // deliberate tts.stop() (which clears isPlaying) won't
                        // auto-advance. For a genuine synthesis error we skip the
                        // bad chunk so playback keeps going instead of stalling.
                        Log.w(TAG, "TTS onError code=" + errorCode + " chunk=" + idx);
                        onChunkFinished(idx);
                    });
                }

                @Override
                public void onError(String utteranceId) {
                    // Deprecated one-arg form (API < 24) — delegate to the new one.
                    onError(utteranceId, TextToSpeech.ERROR);
                }
            });

            // Voice catalogue + user-preferred voice. Must run BEFORE the
            // pendingItem flush below so buffered playback starts with the
            // chosen voice, not the engine default.
            refreshAvailableVoices();
            applyPreferredVoice();

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

    /**
     * Releases playback resources after the TTS engine fails to initialize
     * (INIT_FAILED / LANG_UNAVAILABLE) while playChunks had already optimistically
     * acquired the wake lock and set isPlaying for a buffered (pendingItem) start.
     * Without this the wake lock leaks (battery drain) and the foreground
     * notification sticks in a phantom "playing" state with no audio.
     */
    private void releaseAfterFailedInit() {
        isPlaying = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        updatePlaybackState(false);
        updateNotification();
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
        // Screen off ⇒ skip: the WebView is paused, so these per-chunk events
        // only pile up in its internal evaluateJavascript queue (hundreds over
        // a long session) and flush as one main-thread burst when the app
        // reopens — a visible freeze. They carry no durable state: on resume,
        // useNativeTTSPlayer's visibilitychange sync reads isPlaying/chunkIdx
        // straight from the bridge. Chapter-advance/done/error events are NOT
        // skipped — they drive navigation, lock release, and error UI.
        if (isScreenOn()) {
            final int i = idx;
            mainHandler.post(() -> {
                dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-chunk'," +
                        "{detail:{index:" + i + "}}))");
                dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                        "{detail:{playing:true,index:" + i + "}}))");
            });
        }
        // Keep the lockscreen seek bar in sync — the position advances chunk by
        // chunk; the OS extrapolates within a chunk using the playback speed.
        updatePlaybackState(true);
        // Keep the durable snapshot + server progress fresh while the screen is
        // off and JS can't do it. Both are cheap: one async prefs commit, and a
        // throttled (30 s) PUT on the io executor.
        persistSession();
        maybeSyncProgressToServer(false);
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
                    + " awaiting=" + awaitingFetch
                    + " selfFetchBase=" + (selfFetchBase.isEmpty() ? "EMPTY" : "set")
                    + " prefetchVer=" + prefetchVersion);
            if (sleepAtChapterEnd) {
                // Chapter-boundary sleep: stop here instead of advancing. The
                // chapter DID complete, so credit it for the XP drain (unlike
                // the mid-chapter timed sleep, which deliberately credits
                // nothing). awaitingFetch=true parks the boundary so a later
                // resume delivers the NEXT chapter instead of replaying this
                // chapter's final sentence — I1 holds because pauseInternal
                // already set isPlaying=false.
                sleepAtChapterEnd = false;
                if (currentChapterId != null && !currentChapterId.isEmpty()) {
                    synchronized (completedChapterIds) {
                        completedChapterIds.add(currentChapterId);
                    }
                }
                pauseInternal();
                awaitingFetch = true;
                dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-done'," +
                        "{detail:{sleep:true}}))");
                return;
            }
            ChapterItem nextChapter = pollNextChapter(); // I9: playlist order, not FIFO
            if (nextChapter != null) {
                Log.d(TAG, "→ advance to " + nextChapter.chapterId);
                deliverAutoAdvance(nextChapter, currentChapterId);
            } else if (prefetchActive || pendingHead < pendingPlaylist.size()) {
                // A fetch is in flight or more chapters can be fetched — wait for it.
                // The prefetch callback will call startChapter when it has a result.
                Log.d(TAG, "→ awaitingFetch (prefetch=" + prefetchActive + " pending=" + pendingHead + "/" + pendingPlaylist.size() + ")");
                // I1 entry: pollNextChapter returned null — the playlist
                // successor is NOT in the queue (the queue may still hold
                // out-of-order later chapters; they must not play early).
                awaitingFetch = true;
                // Kick prefetch in case it's not already running
                kickPrefetch();
            } else {
                // FAILSAFE: queue empty, prefetch idle, and pendingHead is past the
                // playlist end — but the playlist may still hold un-queued chapters
                // (a prefetchVersion bump from setPendingPlaylist racing playChunks
                // killed the previous chain). kickPrefetch → doPrefetchStep re-derives
                // pendingHead from the current chapter's position, so a stale-high
                // pendingHead can't hide remaining chapters; its exhausted/stale
                // branches fire done if nothing valid is left. See invariant I7.
                Log.d(TAG, "→ FAILSAFE: retrying prefetch from ch=" + currentChapterId
                        + " (playlist=" + pendingPlaylist.size() + ")");
                awaitingFetch = true;
                prefetchActive = false; // force kickPrefetch to start
                kickPrefetch();
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
        // Also skip when the screen is off — creating a MediaPlayer every chunk
        // while backgrounded can interfere with TTS AudioSession on some devices.
        if (!autoAdvancing && isScreenOn()) {
            playFakeSilence();
        }
        // Re-assert our session immediately + with delays to beat TTS engine's
        // async session activation, and kick off the periodic loop.
        // Only do this when screen is on — when backgrounded, the TTS engine's
        // session management doesn't matter and the constant re-assertion loop
        // (every 3s) wastes CPU and can interfere with audio focus.
        if (isScreenOn()) {
            reassertMediaSession();
        }

        Bundle params = new Bundle();
        // Use utterance id "chunk_N" so the progress listener can echo index back
        int result = tts.speak(currentChunks.get(idx), TextToSpeech.QUEUE_FLUSH, params, "chunk_" + idx);
        if (result != TextToSpeech.SUCCESS) {
            Log.e(TAG, "tts.speak() FAILED result=" + result + " chunk=" + idx + " ch=" + currentChapterId);
            // Fast retry: don't wait the full WATCHDOG_MS — kick the watchdog
            // immediately (1 s grace) so a failing TTS engine recovers quickly
            // rather than leaving an 8-second silence on each retry attempt.
            mainHandler.removeCallbacks(watchdogRunnable);
            mainHandler.postDelayed(watchdogRunnable, 1_000);
            return;
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
        // sessionWanted=false (permanent focus loss / stop) — never re-activate
        // a session we deliberately gave up. The staggered lambdas below check
        // again at fire time because the flag can flip while they are queued.
        if (!sessionWanted) return;
        // Immediate + staggered re-assertions to win the race against TTS engine
        mediaSession.setActive(true);
        updatePlaybackState(isPlaying);
        mainHandler.postDelayed(() -> {
            if (mediaSession != null && sessionWanted) { mediaSession.setActive(true); updatePlaybackState(isPlaying); }
        }, 300);
        mainHandler.postDelayed(() -> {
            if (mediaSession != null && sessionWanted) { mediaSession.setActive(true); updatePlaybackState(isPlaying); }
        }, 1_000);
        mainHandler.postDelayed(() -> {
            if (mediaSession != null && sessionWanted) { mediaSession.setActive(true); updatePlaybackState(isPlaying); }
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
                + " prefetchActive=" + prefetchActive
                + " selfFetchBase=" + (selfFetchBase.isEmpty() ? "EMPTY" : "set")
                + " prefetchVer=" + prefetchVersion);
        currentChunks    = chunks;
        updateCurrentChunksSnapshot();
        currentRate      = rate;
        currentPitch     = pitch;
        currentTitle     = (title != null && !title.isEmpty()) ? title : currentTitle;
        currentChapterId = (chapterId != null) ? chapterId : "";
        currentTotalChunks = (chunks != null) ? chunks.size() : 0;
        recomputeChunkTimings();
        chapterQueue.clear();

        // Cancel any in-flight prefetch chain (new version = stale callbacks ignored)
        prefetchVersion++;
        prefetchActive = false;
        awaitingFetch  = false;
        // DON'T reset pendingHead to 0 here — setPendingPlaylist (which
        // runs AFTER this on the mainHandler due to JS effect ordering)
        // will set the proper pendingHead. Resetting here would cause the
        // prefetch chain started below to re-fetch chapters that were
        // already queued, only to have setPendingPlaylist kill the chain
        // and start over anyway.
        // pendingHead = 0;  (removed — was causing version bump wars)

        // Drain the buffer of any mergeQueue calls that arrived before this
        // playChunks call (i.e. before the chapter text finished loading in JS).
        // We apply AFTER the prefetch reset so mergeQueue's awaitingFetch path
        // cannot accidentally trigger startChapter while we're in playChunks.
        if (pendingMergeBuffer != null) {
            List<ChapterItem> buf = pendingMergeBuffer;
            pendingMergeBuffer = null;
            Log.d(TAG, "playChunks: draining pendingMergeBuffer size=" + buf.size());
            // currentChunks != null now so mergeQueue won't re-buffer
            mergeQueue(buf);
        }

        setMetadata(currentTitle);
        if (mediaSession != null) mediaSession.setActive(true);
        persistSession();
        maybeSyncProgressToServer(true);

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
        // Cold resume after a process kill: the persisted session was restored
        // (chapter id + chunk index) but the chunk text died with the process.
        // Re-fetch the chapter text and continue from the saved chunk.
        if (currentChunks == null && !currentChapterId.isEmpty()
                && (!selfFetchBase.isEmpty()
                    || !offlineStore.getChapterText(currentBookId, currentChapterId).isEmpty())) {
            resumeFromRestoredSession();
            return;
        }
        if (currentChunks == null || currentChunkIdx < 0) return;
        isPlaying = true;
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        if (mediaSession != null) mediaSession.setActive(true);
        requestAudioFocus();
        updatePlaybackState(true);
        updateNotification();
        // Paused during the between-chapter gap (awaitingFetch): currentChunkIdx
        // still points at the FINISHED chapter's last chunk — re-speaking it
        // would duplicate the final sentence. Deliver the queued next chapter
        // instead, or restart the prefetch chain and let it deliver.
        // I1 holds in the kickPrefetch branch: the playlist successor is not
        // queued while waiting (later out-of-order chapters may be).
        if (awaitingFetch) {
            ChapterItem next = pollNextChapter(); // I9: playlist order, not FIFO
            if (next != null) {
                awaitingFetch = false;
                deliverAutoAdvance(next, currentChapterId);
            } else {
                kickPrefetch();
                dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                        "{detail:{playing:true,index:" + currentChunkIdx + "}}))");
            }
            persistSession();
            return;
        }
        speakChunk(currentChunkIdx);
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                "{detail:{playing:true,index:" + currentChunkIdx + "}}))");
        persistSession();
    }

    public void stopPlayback() {
        Log.d(TAG, "stopPlayback called, ch=" + currentChapterId
                + " queue=" + chapterQueue.size()
                + " isPlaying=" + isPlaying);
        // Log stack trace so we can see WHO called stopPlayback
        Log.d(TAG, "stopPlayback stacktrace: " + android.util.Log.getStackTraceString(new Throwable()));
        mainHandler.removeCallbacks(sleepRunnable);
        mainHandler.removeCallbacks(reassertRunnable);
        mainHandler.removeCallbacks(watchdogRunnable);
        watchdogRetries = 0;
        pausedByTransientLoss = false;
        isPlaying        = false;
        sessionWanted    = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        currentChunks    = null;
        updateCurrentChunksSnapshot();
        currentChunkIdx  = -1;
        currentTotalChunks = 0;
        currentChapterId = "";
        recomputeChunkTimings();
        sleepAtChapterEnd = false;
        pendingItem      = null;
        pendingMergeBuffer = null;
        chapterQueue.clear();
        // A stop is an explicit end of the session — a later service start must
        // not restore (or auto-resume) it.
        clearPersistedSession();
        // Cancel prefetch chain but KEEP pendingPlaylist so playChunks → kickPrefetch
        // can re-use it immediately.
        prefetchVersion++;
        prefetchActive  = false;
        pendingHead     = 0;
        awaitingFetch   = false;
        emptyChapterIds.clear();
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

        ChapterItem next = pollNextChapter(); // I9: playlist order, not FIFO
        if (next != null) {
            deliverAutoAdvance(next, currentChapterId);
        } else if (prefetchActive || pendingHead < pendingPlaylist.size()) {
            String completedId = currentChapterId;
            synchronized (completedChapterIds) {
                completedChapterIds.add(completedId);
            }
            awaitingFetch = true;
            kickPrefetch();
        } else {
            // FAILSAFE (mirrors onChunkFinished): pendingHead may sit stale-high
            // while the playlist still holds the real successor un-queued. Let
            // doPrefetchStep re-derive from the current chapter; its
            // exhausted/stale branches call fireDone() — which releases the
            // wake lock, records the chapter for the XP drain, and downgrades
            // the MediaSession — when nothing is truly left.
            awaitingFetch = true;
            prefetchActive = false;
            kickPrefetch();
        }
    }

    /**
     * Restart the current chapter from the beginning.
     * Works entirely in Java — no JS round-trip.
     */
    public void restartCurrentChapter() {
        if (currentChunks == null || currentChunks.isEmpty()) return;
        if (tts != null) tts.stop();
        // Deliberately back inside this chapter — a lingering awaitingFetch
        // (paused at a chapter boundary) would let the next mergeQueue /
        // prefetch delivery hijack playback to the next chapter mid-restart.
        awaitingFetch = false;
        if (!isPlaying) {
            isPlaying = true;
            // Re-acquire the CPU lock released by pauseInternal — without it
            // a restart from the paused notification stalls at the next
            // screen-off chunk boundary.
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
            requestAudioFocus();
            if (mediaSession != null) mediaSession.setActive(true);
        }
        speakChunk(0);
        updatePlaybackState(true);
        updateNotification();
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                "{detail:{playing:true,index:0}}))");
        persistSession();
    }

    /**
     * Jump to a chunk inside the CURRENT chapter. Backs the lockscreen
     * seek-bar scrubs (onSeekTo), the notification back-one-chunk button,
     * BT rewind/fast-forward, and the in-app seek fast path
     * (bridge.seekToChunk). Unlike a playChunks restart it leaves the queue,
     * pending playlist and prefetch chain untouched. While paused it only
     * moves the resume position — it never starts audio.
     */
    public void seekToChunk(int idx) {
        List<String> chunks = currentChunks;
        if (chunks == null || chunks.isEmpty()) return;
        int clamped = Math.max(0, Math.min(idx, chunks.size() - 1));
        // Back inside this chapter — clear a lingering boundary wait (see
        // restartCurrentChapter above for the hijack this prevents).
        awaitingFetch = false;
        currentChunkIdx = clamped;
        if (isPlaying) {
            mainHandler.removeCallbacks(watchdogRunnable);
            watchdogRetries = 0;
            if (tts != null) tts.stop();
            speakChunk(clamped);
        } else {
            updatePlaybackState(false);
            updateNotification();
            dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                    "{detail:{playing:false,index:" + clamped + "}}))");
        }
        persistSession();
        maybeSyncProgressToServer(true);
    }

    public void setRate(float rate) {
        currentRate = rate;
        if (tts != null) tts.setSpeechRate(rate);
        syncMedia3();
    }

    public void setPitch(float pitch) {
        currentPitch = pitch;
        if (tts != null) tts.setPitch(pitch);
        syncMedia3();
    }

    /**
     * Select a device TTS voice by its {@link android.speech.tts.Voice#getName()}.
     * Empty string returns to the engine default for vi-VN. Takes effect on
     * the next utterance (JS restarts the current chunk right after calling
     * this, so the switch is heard immediately).
     */
    public void setPreferredVoice(String name) {
        String newName = name != null ? name : "";
        if (newName.equals(preferredVoiceName)) return;
        preferredVoiceName = newName;
        if (ttsReady && tts != null) {
            if (newName.isEmpty()) {
                // Back to the engine default for Vietnamese.
                try { tts.setLanguage(new Locale("vi", "VN")); } catch (Exception ignored) {}
            } else {
                applyPreferredVoice();
            }
        }
        persistSession();
    }

    /**
     * Build the JSON catalogue of installed Vietnamese voices for the JS
     * voice picker: [{name, quality, network}]. Called once the engine is
     * ready (and again after watchdog reinits).
     */
    private void refreshAvailableVoices() {
        try {
            JSONArray arr = new JSONArray();
            Set<android.speech.tts.Voice> voices = tts != null ? tts.getVoices() : null;
            if (voices != null) {
                for (android.speech.tts.Voice v : voices) {
                    if (v == null || v.getLocale() == null) continue;
                    if (!"vi".equalsIgnoreCase(v.getLocale().getLanguage())) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", v.getName());
                    o.put("quality", v.getQuality());
                    o.put("network", v.isNetworkConnectionRequired());
                    arr.put(o);
                }
            }
            availableVoicesJson = arr.toString();
        } catch (Exception e) {
            // Some engines throw from getVoices() — leave the previous list.
            Log.w(TAG, "refreshAvailableVoices failed", e);
        }
    }

    /** Apply {@link #preferredVoiceName} to the engine if it is installed. */
    private void applyPreferredVoice() {
        if (tts == null || !ttsReady || preferredVoiceName.isEmpty()) return;
        try {
            Set<android.speech.tts.Voice> voices = tts.getVoices();
            if (voices == null) return;
            for (android.speech.tts.Voice v : voices) {
                if (v != null && preferredVoiceName.equals(v.getName())) {
                    tts.setVoice(v);
                    return;
                }
            }
            // Voice was uninstalled — keep the vi-VN default set by initTts.
            Log.w(TAG, "preferred voice not installed: " + preferredVoiceName);
        } catch (Exception e) {
            Log.w(TAG, "applyPreferredVoice failed", e);
        }
    }

    public void updateTitle(String title) {
        if (title != null && !title.isEmpty()) {
            currentTitle = title;
            setMetadata(title);
            updateNotification();
        }
    }

    /**
     * Set the book cover shown on the media notification + lockscreen. Loads the
     * bitmap asynchronously from the cover URL and re-posts the notification and
     * MediaSession metadata once ready. Cached by URL — repeat calls for the same
     * book are no-ops.
     */
    public void updateCover(String url) {
        if (url == null) url = "";
        if (url.equals(currentCoverUrl)) return;   // same cover (or both empty)
        currentCoverUrl = url;
        currentCoverBitmap = null;                 // drop stale art right away
        setMetadata(currentTitle);
        updateNotification();
        if (url.isEmpty() || coverExecutor == null) return;
        final String fUrl = url;
        coverExecutor.execute(() -> {
            Bitmap bmp = loadBitmap(fUrl);
            if (bmp == null) return;
            mainHandler.post(() -> {
                // Ignore if the cover changed again while we were loading.
                if (!fUrl.equals(currentCoverUrl)) return;
                currentCoverBitmap = bmp;
                setMetadata(currentTitle);
                updateNotification();
            });
        });
    }

    /** Download + decode a cover image, downscaled to cap memory. Null on failure. */
    private Bitmap loadBitmap(String urlStr) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(8_000);
            conn.setReadTimeout(12_000);
            conn.setInstanceFollowRedirects(true);
            if (conn.getResponseCode() != 200) return null;
            InputStream is = new BufferedInputStream(conn.getInputStream());
            Bitmap bmp = BitmapFactory.decodeStream(is);
            is.close();
            if (bmp == null) return null;
            final int MAX = 512;  // lockscreen art never needs more than this
            if (bmp.getWidth() > MAX || bmp.getHeight() > MAX) {
                float s = Math.min((float) MAX / bmp.getWidth(), (float) MAX / bmp.getHeight());
                Bitmap scaled = Bitmap.createScaledBitmap(
                        bmp, Math.round(bmp.getWidth() * s), Math.round(bmp.getHeight() * s), true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }
            return bmp;
        } catch (Exception e) {
            Log.w(TAG, "cover load failed for " + urlStr + ": " + e);
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Book-level session info from JS. The book id keys the durable session
     * snapshot, the server progress writes, and the "continue listening"
     * lookup; the book title shows as the artist/album line on the lockscreen
     * and Bluetooth displays.
     */
    public void setSessionInfo(String bookId, String bookTitle) {
        if (bookId != null && !bookId.isEmpty()) currentBookId = bookId;
        if (bookTitle != null && !bookTitle.isEmpty() && !bookTitle.equals(currentBookTitle)) {
            currentBookTitle = bookTitle;
            setMetadata(currentTitle);
            updateNotification();
        }
        persistSession();
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
     *
     * <p>Race-condition safety: if called before {@link #playChunks} has run for the
     * current chapter (i.e. the chapter text was still loading when the 50 ms JS
     * timer fired), the items are buffered in {@code pendingMergeBuffer}.
     * {@link #playChunks} drains the buffer immediately after clearing the queue so
     * the chapters are never lost.</p>
     */
    public void mergeQueue(List<ChapterItem> chapters) {
        // If playChunks hasn't been called yet (no current chapter), buffer the
        // items. playChunks() will drain this buffer right after clearing the queue,
        // so the chapters survive the clear even when mergeQueue arrives first.
        if (currentChunks == null && !isPlaying) {
            Log.d(TAG, "mergeQueue: buffering " + chapters.size()
                    + " items (playChunks not yet called)");
            if (pendingMergeBuffer == null) {
                pendingMergeBuffer = new ArrayList<>(chapters);
            } else {
                // Accumulate — JS may call us multiple times as preload texts arrive
                pendingMergeBuffer.addAll(chapters);
            }
            return;
        }

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
        // Log details of what was added and what was skipped for diagnostics
        StringBuilder addedIds = new StringBuilder();
        for (ChapterItem item : chapters) {
            String id = item.chapterId != null ? item.chapterId : "";
            if (addedIds.length() > 0) addedIds.append(",");
            addedIds.append(id.length() > 8 ? id.substring(0, 8) : id);
        }
        Log.d(TAG, "mergeQueue: added=" + added + " total=" + chapterQueue.size()
                + " awaitingFetch=" + awaitingFetch
                + " offered=" + chapters.size() + " ids=" + addedIds);
        // See invariant I1: deliver iff awaitingFetch && successor queued && isPlaying.
        // !isPlaying means user paused during the awaitingFetch window — leave the
        // item queued; resumePlayback → chunk-finish path picks it up naturally.
        if (added > 0 && awaitingFetch && isPlaying) {
            ChapterItem next = pollNextChapter(); // I9: only the playlist successor
            if (next != null) {
                awaitingFetch = false;
                deliverAutoAdvance(next, currentChapterId);
            }
            // null: this merge didn't include the successor — stay awaiting;
            // the prefetch chain is fetching it.
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
        List<String> copy;
        synchronized (completedChapterIds) {
            copy = new ArrayList<>(completedChapterIds);
            completedChapterIds.clear();
        }
        // Persist the now-empty list so a later restore can't re-credit
        // already-drained chapters. (Called from the JS thread — persist on
        // the main thread where the rest of the snapshot state lives.)
        mainHandler.post(this::persistSession);
        return copy;
    }

    public void setSleepTimer(long expireAtMs) {
        mainHandler.removeCallbacks(sleepRunnable);
        sleepAtChapterEnd = false; // timed mode replaces chapter-end mode
        long delay = expireAtMs - System.currentTimeMillis();
        if (delay <= 0) {
            mainHandler.post(sleepRunnable);
        } else {
            mainHandler.postDelayed(sleepRunnable, delay);
        }
    }

    public void cancelSleepTimer() {
        mainHandler.removeCallbacks(sleepRunnable);
        sleepAtChapterEnd = false;
    }

    /**
     * Arm (or disarm) the "sleep when the current chapter ends" mode.
     * Mutually exclusive with the wall-clock timer above.
     */
    public void setSleepAtChapterEnd(boolean on) {
        sleepAtChapterEnd = on;
        if (on) mainHandler.removeCallbacks(sleepRunnable);
    }

    /**
     * Provides the service with an ordered list of upcoming chapters and API
     * credentials. Java will self-fetch each chapter's text just before it is
     * needed so the native queue never exhausts even while the screen is off.
     * Safe to call at any time — resets the pending playlist atomically.
     */
    public void setPendingPlaylist(List<ChapterMeta> playlist, String apiBase, String token) {
        Log.d(TAG, "setPendingPlaylist: size=" + (playlist != null ? playlist.size() : 0)
                + " queue=" + chapterQueue.size() + " awaitingFetch=" + awaitingFetch
                + " apiBase=" + (apiBase != null && !apiBase.isEmpty() ? apiBase.substring(0, Math.min(30, apiBase.length())) : "EMPTY")
                + " hasToken=" + (token != null && !token.isEmpty())
                + " prefetchVer=" + prefetchVersion);
        pendingPlaylist = playlist != null ? playlist : Collections.emptyList();
        pendingHead     = 0;
        // Fresh JS view of the upcoming chapters → give chapters that were empty
        // earlier (e.g. text not yet parsed when first self-fetched) another
        // chance; they may have gained text since. Safe: the new prefetch chain
        // re-adds any that are still empty, so the re-selection loop can't return.
        emptyChapterIds.clear();
        selfFetchBase   = apiBase != null ? apiBase : "";
        selfFetchToken  = token  != null ? token  : "";
        if (ioExecutor == null || ioExecutor.isShutdown()) {
            ioExecutor = Executors.newCachedThreadPool();
        }
        // Cancel any stale prefetch chain and start fresh
        prefetchVersion++;
        prefetchActive = false;
        kickPrefetch();

        // See invariant I1: deliver iff awaitingFetch && successor queued && isPlaying.
        if (awaitingFetch && isPlaying) {
            ChapterItem next = pollNextChapter(); // I9: only the playlist successor
            if (next != null) {
                awaitingFetch = false;
                deliverAutoAdvance(next, currentChapterId);
            }
            // null: successor not queued — the kickPrefetch above is fetching it.
        }
        // Refresh the durable snapshot's upcoming-playlist section.
        persistSession();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private void pauseInternal() {
        Log.d(TAG, "pauseInternal called, isPlaying=" + isPlaying
                + " pausedByTransient=" + pausedByTransientLoss
                + " ch=" + currentChapterId);
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
        persistSession();
        maybeSyncProgressToServer(true);
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
        // I2: prefetchActive ⇒ ioExecutor has a pending task. doPrefetchStep
        // will exit and flip prefetchActive=false if ioExecutor is null/shutdown.
        assertInvariant("I2 (kickPrefetch: ioExecutor alive)",
                ioExecutor != null && !ioExecutor.isShutdown());
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

        // ── Align pendingHead to the genuine next chapter (invariant I7) ──────
        // setPendingChapters seeds the playlist INCLUSIVE of the current chapter,
        // so locate it and only ever fetch what comes AFTER it. If the current
        // chapter isn't in the playlist, this playlist was seeded for a DIFFERENT
        // position and JS hasn't re-seeded it (screen off → listen-page effects
        // suspended). Self-fetching from it is exactly what jumped the listener
        // back to a stale chapter — e.g. picking ch.75 while at ch.100, then a
        // few chapters later leaping to ~100/101 (the leftover playlist). Stop
        // instead; JS re-seeds on screen-on and the chain resumes correctly.
        if (!currentChapterId.isEmpty()) {
            int curPos = -1;
            for (int i = 0; i < pendingPlaylist.size(); i++) {
                if (currentChapterId.equals(pendingPlaylist.get(i).chapterId)) {
                    curPos = i;
                    break;
                }
            }
            if (curPos < 0) {
                Log.d(TAG, "doPrefetchStep: current ch " + currentChapterId
                        + " not in playlist (size=" + pendingPlaylist.size()
                        + ") — stale playlist, not self-fetching");
                prefetchActive = false;
                if (awaitingFetch) {
                    // Nothing valid to advance into. End cleanly (releases the
                    // wake lock, credits XP) rather than leaving a silent
                    // playing-but-stuck state; JS onDone navigates to the real
                    // next chapter once the screen comes back on.
                    awaitingFetch = false;
                    fireDone();
                }
                return;
            }
            // Re-derive (not just clamp) from the current chapter's position so a
            // stale-HIGH pendingHead — left forward when playChunks cleared the
            // queue — can't skip past un-queued chapters either. The skip-loop
            // below then advances past anything already queued/empty.
            pendingHead = curPos + 1;
        }

        // Skip chapters already queued, currently playing, or known to be empty.
        // (Known-empty must be skipped here too, otherwise re-deriving pendingHead
        // would re-select the same empty chapter every step → infinite loop.)
        while (pendingHead < pendingPlaylist.size()) {
            String id = pendingPlaylist.get(pendingHead).chapterId;
            if (!isAlreadyQueued(id) && !emptyChapterIds.contains(id)) break;
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

        final String  id      = meta.chapterId;
        final String  title   = meta.title;
        final float   fRate   = meta.rate;
        final float   fPitch  = meta.pitch;
        final String  base    = selfFetchBase;
        final String  tok     = selfFetchToken;
        // Capture urgency at schedule time so the lambda uses the right value
        // even if awaitingFetch changes before the IO thread runs.
        final boolean urgent  = awaitingFetch;

        Log.d(TAG, "doPrefetchStep: fetching ch=" + id + " ver=" + version + " urgent=" + urgent);

        ioExecutor.execute(() -> {
            try {
                // The UI downloader and TTS service share the same app-private
                // repository. Network is only a fallback when this chapter is
                // not available locally.
                String text = offlineStore.getChapterText(currentBookId, id);
                if (text.isEmpty()) {
                    String url  = base + "/api/chapters/" + id + "/text";
                    String body = doHttpGet(url, tok, urgent);
                    JSONObject json = new JSONObject(body);
                    text = json.optString("text_content", "");
                }
                List<String> chunks = splitChunksJava(text, 20, 4000);

                mainHandler.post(() -> {
                    if (version != prefetchVersion) {
                        Log.d(TAG, "doPrefetchStep: stale ver=" + version + " cur=" + prefetchVersion);
                        // Don't touch prefetchActive — a newer chain owns it.
                        return;
                    }

                    if (chunks.isEmpty()) {
                        Log.d(TAG, "doPrefetchStep: empty chapter " + id + ", skipping");
                        emptyChapterIds.add(id); // so the re-derive loop won't re-pick it
                        doPrefetchStep(version); // skip and continue
                        return;
                    }

                    ChapterItem item = new ChapterItem(chunks, id, title, fRate, fPitch);

                    if (awaitingFetch && isPlaying) {
                        // See invariant I1: deliver iff awaitingFetch && isPlaying.
                        // !isPlaying means user paused — queue the item
                        // and continue the prefetch chain normally.
                        //
                        // I9: queue the fetched item, then deliver STRICTLY the
                        // playlist successor. The fetch that just landed is
                        // usually it — but a mergeQueue delivery may have moved
                        // playback while this fetch was in flight, making
                        // `item` a stale non-successor that must not play now.
                        if (!isAlreadyQueued(id)) {
                            chapterQueue.add(item);
                        }
                        ChapterItem next = pollNextChapter();
                        if (next != null) {
                            // Reset prefetchActive BEFORE delivering so the
                            // startChapter → kickPrefetch can start a fresh chain.
                            awaitingFetch = false;
                            prefetchActive = false;
                            Log.d(TAG, "doPrefetchStep: delivering ch=" + next.chapterId
                                    + " to awaiting player (fetched ch=" + id + ")");
                            deliverAutoAdvance(next, currentChapterId);
                            // startChapter (inside deliverAutoAdvance) calls kickPrefetch,
                            // which will continue the chain.
                        } else {
                            doPrefetchStep(version); // successor still missing — keep chain
                        }
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
                        // Player is stalled waiting for this chapter.
                        // Retry very quickly so each Railway cold-start attempt
                        // fails fast (12 s read timeout) and retries immediately.
                        // Railway typically warms up in 20-40 s total, so with
                        // ~13 s per cycle (12 s timeout + 500 ms wait) we recover
                        // in 2-3 attempts (26-39 s) instead of 2 × 33 s = 66 s.
                        Log.d(TAG, "doPrefetchStep: retrying ch=" + id + " in 500ms (awaiting)");
                        pendingHead--; // re-try same chapter
                        mainHandler.postDelayed(() -> {
                            if (version != prefetchVersion) {
                                return;
                            }
                            doPrefetchStep(version);
                        }, 500);
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

    /**
     * Ordered replacement for {@code chapterQueue.poll()} at every auto-advance
     * delivery site — see invariant I9 in docs/android-player.md.
     *
     * <p>The queue has TWO independent producers: the self-fetch prefetch chain
     * (strict playlist order) and JS {@code mergeQueuedChapters} (whatever
     * texts happen to be cached — including leftovers persisted around an
     * EARLIER listening position). Arrival order is therefore NOT playback
     * order. Blind FIFO delivery after the user jumped back a few chapters is
     * what leaped playback to the old position: at ch.5 the stale cached block
     * 10..16 merged mid-chain, giving 5→6→7→8→10→11.</p>
     *
     * <p>Returns (and removes) the queued item for the chapter that FOLLOWS
     * {@code currentChapterId} in {@code pendingPlaylist}, skipping known-empty
     * chapters — mirroring doPrefetchStep's skip rule. Returns null when that
     * successor isn't queued yet: the caller must keep waiting for the prefetch
     * chain, which re-derives its cursor from {@code currentChapterId} and so
     * fetches exactly the missing successor. Falls back to plain FIFO when the
     * playlist can't order us (no playlist, or current chapter not in it —
     * the legacy {@code queueAllChapters} path).</p>
     */
    private ChapterItem pollNextChapter() {
        List<String> playlist = new ArrayList<>(pendingPlaylist.size());
        for (ChapterMeta meta : pendingPlaylist) playlist.add(meta.chapterId);
        return ChapterQueueController.pollNext(
                chapterQueue,
                playlist,
                currentChapterId,
                emptyChapterIds,
                item -> item.chapterId);
    }

    /**
     * Refresh the volatile JSON snapshot of {@code currentChunks} for
     * {@code TtsBridge.getCurrentChunksJson()}. Must be called (main thread)
     * at every {@code currentChunks} assignment.
     */
    private void updateCurrentChunksSnapshot() {
        if (currentChunks == null || currentChunks.isEmpty()) {
            currentChunksJson = "[]";
            return;
        }
        currentChunksJson = new JSONArray(currentChunks).toString();
    }

    /** Returns true if the device screen is interactively on. */
    private boolean isScreenOn() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isInteractive();
    }

    /**
     * Terminal "playback over" path (always on the main thread): playlist
     * exhausted naturally, or hardware-next pressed on the last chapter.
     */
    private void fireDone() {
        Log.d(TAG, "fireDone: ch=" + currentChapterId
                + " queue=" + chapterQueue.size()
                + " pendingPlaylist=" + pendingPlaylist.size()
                + " pendingHead=" + pendingHead
                + " selfFetchBase=" + (selfFetchBase.isEmpty() ? "EMPTY" : "set")
                + " prefetchActive=" + prefetchActive
                + " prefetchVer=" + prefetchVersion);
        // Record the just-finished chapter so the screen-on XP drain
        // (getCompletedChapterIds) credits the FINAL chapter too. The last
        // chapter ends here via done rather than a chapter-advance, so without
        // this it would never land in completedChapterIds and its listen XP
        // would be skipped. The JS drain + backend both dedupe, so a repeat add
        // is harmless.
        if (currentChapterId != null && !currentChapterId.isEmpty()) {
            synchronized (completedChapterIds) {
                completedChapterIds.add(currentChapterId);
            }
        }
        isPlaying = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        updatePlaybackState(false);
        dispatchJs("window.dispatchEvent(new Event('native-tts-done'))");
        dispatchJs("window.dispatchEvent(new CustomEvent('native-tts-state'," +
                "{detail:{playing:false,index:" + currentChunkIdx + "}}))");
        updateNotification();
        abandonAudioFocus();
        persistSession();
        maybeSyncProgressToServer(true);
    }

    /**
     * @param urgent true when the player is waiting for this result (awaitingFetch).
     *               Use shorter timeouts so we fail fast and retry rather than
     *               stalling 30+ seconds per attempt on a cold Railway server.
     */
    private String doHttpGet(String urlStr, String token, boolean urgent) throws IOException {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        // Urgent (chapter needed now): short timeout → fast retry loop
        // Non-urgent (prefetching ahead): longer timeout is fine
        conn.setConnectTimeout(urgent ? 8_000 : 15_000);
        conn.setReadTimeout(urgent ? 12_000 : 30_000);
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

    // ── Durable session persistence + background progress sync ───────────────

    /**
     * Write the resume snapshot to SharedPreferences. Cheap: one JSON string,
     * async commit. Always called on the main thread (the only thread that
     * mutates the snapshotted state).
     */
    private void persistSession() {
        if (currentChapterId == null || currentChapterId.isEmpty()) return;
        try {
            JSONObject o = new JSONObject();
            o.put("bookId", currentBookId);
            o.put("bookTitle", currentBookTitle);
            o.put("chapterId", currentChapterId);
            o.put("title", currentTitle);
            o.put("chunkIdx", Math.max(currentChunkIdx, 0));
            o.put("totalChunks", currentTotalChunks);
            o.put("rate", currentRate);
            o.put("pitch", currentPitch);
            o.put("voiceName", preferredVoiceName);
            o.put("playing", isPlaying);
            // Auth is deliberately NOT copied into this ordinary preferences
            // snapshot. Background progress recovers it separately from the
            // Keystore-encrypted SecureAuthStore after process death.
            o.put("apiBase", selfFetchBase);
            o.put("coverUrl", currentCoverUrl);
            o.put("ts", System.currentTimeMillis());
            // Upcoming chapters, current chapter INCLUSIVE, so auto-advance also
            // survives a process kill. doPrefetchStep aligns by locating the
            // current chapter inside the (restored) playlist, so it MUST be
            // present. Chunk text is NOT persisted — it is re-fetched on demand.
            int from = -1;
            for (int i = 0; i < pendingPlaylist.size(); i++) {
                if (pendingPlaylist.get(i).chapterId.equals(currentChapterId)) {
                    from = i;
                    break;
                }
            }
            // Only persist the playlist when it actually contains the current
            // chapter. If it doesn't, the playlist is stale relative to where
            // playback is (a brief window before JS re-seeds) — persisting it
            // would let a process-kill restore self-fetch into the wrong
            // chapters. An empty playlist makes restore wait for JS instead.
            JSONArray pl = new JSONArray();
            if (from >= 0) {
                for (int i = from; i < pendingPlaylist.size()
                        && pl.length() < PERSIST_PLAYLIST_CAP; i++) {
                    ChapterMeta m = pendingPlaylist.get(i);
                    JSONObject mo = new JSONObject();
                    mo.put("id", m.chapterId);
                    mo.put("title", m.title);
                    mo.put("rate", m.rate);
                    mo.put("pitch", m.pitch);
                    pl.put(mo);
                }
            }
            o.put("playlist", pl);
            JSONArray completed = new JSONArray();
            synchronized (completedChapterIds) {
                for (String id : completedChapterIds) completed.put(id);
            }
            o.put("completed", completed);
            SharedPreferences.Editor ed =
                    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                            .putString(PREFS_KEY_SESSION, o.toString());
            // Durable "where listening last stood" pointer for the UI
            // (BookDetail continue-listening, app-open reconciler). Survives
            // stopPlayback. Only written once the book id is known so a brand
            // new play can't blank out the previous book's pointer.
            if (!currentBookId.isEmpty()) {
                JSONObject last = new JSONObject();
                last.put("bookId", currentBookId);
                last.put("chapterId", currentChapterId);
                last.put("chunkIdx", Math.max(currentChunkIdx, 0));
                last.put("ts", System.currentTimeMillis());
                ed.putString(PREFS_KEY_LAST_POSITION, last.toString());
            }
            ed.apply();
        } catch (Exception e) {
            Log.w(TAG, "persistSession failed", e);
        }
    }

    private void clearPersistedSession() {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .remove(PREFS_KEY_SESSION).apply();
    }

    /**
     * Restore the snapshot written by {@link #persistSession} as a PAUSED
     * session (onCreate). The bridge then reports a valid chapter/chunk/book to
     * JS even though the process was killed, so cold-start sync, "continue
     * listening", and the notification Play button all land on the position
     * where playback actually stopped. {@link #resumeFromRestoredSession}
     * re-fetches the chapter text when playback is actually requested.
     */
    private void restoreSession() {
        try {
            String raw = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .getString(PREFS_KEY_SESSION, null);
            if (raw == null) return;
            JSONObject o = new JSONObject(raw);
            String chId = o.optString("chapterId", "");
            if (chId.isEmpty()) return;
            currentBookId      = o.optString("bookId", "");
            currentBookTitle   = o.optString("bookTitle", "");
            currentChapterId   = chId;
            currentTitle       = o.optString("title", currentTitle);
            currentChunkIdx    = o.optInt("chunkIdx", 0);
            currentTotalChunks = o.optInt("totalChunks", 0);
            currentRate        = (float) o.optDouble("rate", 1.0);
            currentPitch       = (float) o.optDouble("pitch", 1.0);
            // Restored BEFORE the async initTts callback fires (onCreate calls
            // initTts then restoreSession synchronously), so applyPreferredVoice
            // inside that callback picks this up.
            preferredVoiceName = o.optString("voiceName", "");
            selfFetchBase      = o.optString("apiBase", "");
            restoredWasPlaying = o.optBoolean("playing", false);
            restoredAtMs       = o.optLong("ts", 0);
            JSONArray pl = o.optJSONArray("playlist");
            if (pl != null) {
                List<ChapterMeta> list = new ArrayList<>(pl.length());
                for (int i = 0; i < pl.length(); i++) {
                    JSONObject mo = pl.optJSONObject(i);
                    if (mo == null) continue;
                    String id = mo.optString("id", "");
                    if (id.isEmpty()) continue;
                    list.add(new ChapterMeta(id, mo.optString("title", ""),
                            (float) mo.optDouble("rate", 1.0),
                            (float) mo.optDouble("pitch", 1.0)));
                }
                // doPrefetchStep aligns by locating the current chapter in the
                // playlist, so it must head the list. New snapshots persist it
                // inclusive; snapshots written before that change (or any that
                // start past the current chapter) get it prepended here.
                if (!list.isEmpty() && !chId.equals(list.get(0).chapterId)) {
                    list.add(0, new ChapterMeta(chId, currentTitle,
                            currentRate, currentPitch));
                }
                if (!list.isEmpty()) {
                    pendingPlaylist = list;
                    pendingHead     = 0;
                }
            }
            JSONArray completed = o.optJSONArray("completed");
            if (completed != null) {
                synchronized (completedChapterIds) {
                    for (int i = 0; i < completed.length(); i++) {
                        String id = completed.optString(i, "");
                        if (!id.isEmpty() && !completedChapterIds.contains(id)) {
                            completedChapterIds.add(id);
                        }
                    }
                }
            }
            isPlaying = false;
            String cover = o.optString("coverUrl", "");
            if (!cover.isEmpty()) updateCover(cover);
            setMetadata(currentTitle);
            // Repair a stale server pointer as soon as the service is rebound.
            // This works without chapter text because totalChunks is part of
            // the durable snapshot and auth is recovered from encrypted native
            // storage by maybeSyncProgressToServer.
            maybeSyncProgressToServer(true);
            Log.d(TAG, "restoreSession: ch=" + chId + " chunk=" + currentChunkIdx
                    + " wasPlaying=" + restoredWasPlaying
                    + " playlist=" + pendingPlaylist.size());
        } catch (Exception e) {
            Log.w(TAG, "restoreSession failed", e);
        }
    }

    /**
     * Re-fetch the restored chapter's text and resume speaking from the
     * persisted chunk. Used by the START_STICKY auto-resume (process killed
     * mid-playback moments ago) and by {@link #resumePlayback} when the user
     * hits Play on a restored-but-cold session (notification or JS toggle).
     */
    private void resumeFromRestoredSession() {
        if (restoringSession) return;
        if (currentChapterId == null || currentChapterId.isEmpty()) return;
        final String offlineText = offlineStore.getChapterText(currentBookId, currentChapterId);
        if (offlineText.isEmpty() && selfFetchBase.isEmpty()) return;
        if (currentChunks != null) {
            resumePlayback();
            return;
        }
        restoringSession = true;
        if (ioExecutor == null || ioExecutor.isShutdown()) {
            ioExecutor = Executors.newCachedThreadPool();
        }
        // Claim "playing" right away so the notification reflects intent and a
        // pause during the fetch is honored by the validity check below.
        isPlaying = true;
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        updatePlaybackState(true);
        updateNotification();
        final String id       = currentChapterId;
        final String base     = selfFetchBase;
        final String tok      = selfFetchToken;
        final String title    = currentTitle;
        final float  rate     = currentRate;
        final float  pitch    = currentPitch;
        final int    startIdx = Math.max(currentChunkIdx, 0);
        Log.d(TAG, "resumeFromRestoredSession: ch=" + id + " chunk=" + startIdx);
        ioExecutor.execute(() -> {
            List<String> chunks = null;
            try {
                String text = offlineText;
                if (text.isEmpty()) {
                    String body = doHttpGet(base + "/api/chapters/" + id + "/text", tok, true);
                    text = new JSONObject(body).optString("text_content", "");
                }
                chunks = splitChunksJava(text, 20, 4000);
            } catch (Exception e) {
                Log.w(TAG, "resumeFromRestoredSession fetch failed", e);
            }
            final List<String> fChunks = chunks;
            mainHandler.post(() -> {
                restoringSession = false;
                // Abandon if the world changed while fetching: a fresh play
                // started (currentChunks set), the session was stopped, or the
                // user paused the pending resume.
                if (currentChunks != null || !id.equals(currentChapterId) || !isPlaying) return;
                if (fChunks == null || fChunks.isEmpty()) {
                    isPlaying = false;
                    if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                    updatePlaybackState(false);
                    updateNotification();
                    return;
                }
                int idx = Math.min(startIdx, fChunks.size() - 1);
                ChapterItem item = new ChapterItem(fChunks, id, title, rate, pitch);
                if (!ttsReady) {
                    // Fresh process: the TTS engine may still be initialising
                    // (initTts callback hasn't fired). startChapter→speakChunk
                    // would silently drop the chunk — buffer it like playChunks
                    // does; initTts's pendingItem flush starts it when ready.
                    pendingItem     = item;
                    pendingStartIdx = idx;
                    return;
                }
                startChapter(item, idx);
            });
        });
    }

    /**
     * PUT the current listening position to the server so progress stays fresh
     * even when the WebView has been suspended for hours. Throttled to one
     * write per {@link #PROGRESS_SYNC_INTERVAL_MS} unless {@code force} (chapter
     * boundaries, pause, done). The book/API context comes from JS, while an
     * expired access token is refreshed from Keystore-backed native auth so
     * screen-off sessions do not stop saving after one hour.
     */
    private void maybeSyncProgressToServer(boolean force) {
        if (currentBookId.isEmpty() || selfFetchBase.isEmpty()) return;
        if (currentChapterId == null || currentChapterId.isEmpty()) return;
        List<String> chunks = currentChunks;
        int totalChunks = chunks != null && !chunks.isEmpty()
                ? chunks.size() : currentTotalChunks;
        if (totalChunks <= 0) return;
        String token = selfFetchToken;
        if (token.isEmpty()) {
            token = loadStoredAccessToken();
            if (!token.isEmpty()) selfFetchToken = token;
        }
        if (token.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (!force && now - lastProgressSyncMs < PROGRESS_SYNC_INTERVAL_MS) return;
        lastProgressSyncMs = now;
        try {
            JSONObject o = new JSONObject();
            o.put("book_id", currentBookId);
            o.put("chapter_id", currentChapterId);
            o.put("progress_value", Math.max(currentChunkIdx, 0));
            o.put("total_value", totalChunks);
            LatestProgressSync<ProgressUpdate> sync = progressSync;
            if (sync != null) {
                sync.submit(new ProgressUpdate(selfFetchBase, token, o.toString()));
            }
        } catch (Exception ignored) {
        }
    }

    /**
     * Send one coalesced progress update. A 401 first retries a newer access
     * token already saved by the WebView, then refreshes natively using the
     * encrypted refresh token. This keeps profile progress moving during long
     * screen-off sessions where WebView timers cannot rotate the one-hour JWT.
     */
    private void sendProgressUpdate(ProgressUpdate update) throws Exception {
        String token = update.accessToken;
        try {
            doHttpPut(update.apiBase + "/api/progress", token, update.body);
            return;
        } catch (HttpStatusException error) {
            if (error.statusCode != 401) throw error;
        }

        String storedToken = loadStoredAccessToken();
        if (!storedToken.isEmpty() && !storedToken.equals(token)) {
            try {
                doHttpPut(update.apiBase + "/api/progress", storedToken, update.body);
                selfFetchToken = storedToken;
                return;
            } catch (HttpStatusException error) {
                if (error.statusCode != 401) throw error;
            }
        }

        String refreshedToken = refreshStoredAuth(update.apiBase);
        if (refreshedToken.isEmpty()) throw new IOException("auth refresh failed");
        selfFetchToken = refreshedToken;
        doHttpPut(update.apiBase + "/api/progress", refreshedToken, update.body);
        dispatchJs("window.dispatchEvent(new Event('native-auth-updated'))");
    }

    private String loadStoredAccessToken() {
        try {
            String raw = secureAuthStore != null ? secureAuthStore.load() : "";
            return raw.isEmpty() ? "" : new JSONObject(raw).optString("token", "");
        } catch (Exception ignored) {
            return "";
        }
    }

    /** Refresh and atomically persist the complete native auth blob. */
    private String refreshStoredAuth(String apiBase) throws Exception {
        if (secureAuthStore == null) return "";
        String raw = secureAuthStore.load();
        if (raw.isEmpty()) return "";
        JSONObject stored = new JSONObject(raw);
        String refreshToken = stored.optString("refreshToken", "");
        if (refreshToken.isEmpty()) return "";

        JSONObject request = new JSONObject();
        request.put("refresh_token", refreshToken);
        JSONObject response = doHttpPostJson(
                apiBase + "/api/auth/refresh", request.toString());
        String accessToken = response.optString("access_token", "");
        if (accessToken.isEmpty()) return "";

        stored.put("token", accessToken);
        stored.put("refreshToken",
                response.optString("refresh_token", refreshToken));
        JSONObject user;
        Object existingUser = stored.opt("user");
        if (existingUser instanceof JSONObject) {
            user = (JSONObject) existingUser;
        } else {
            try {
                user = new JSONObject(existingUser instanceof String
                        ? (String) existingUser : "{}");
            } catch (Exception ignored) {
                user = new JSONObject();
            }
        }
        if (response.has("user_id")) user.put("user_id", response.optString("user_id", ""));
        if (response.has("email")) user.put("email", response.optString("email", ""));
        if (response.has("role")) user.put("role", response.optString("role", ""));
        if (response.has("display_name")) user.put("display_name", response.opt("display_name"));
        if (response.has("avatar_base64")) user.put("avatar_base64", response.opt("avatar_base64"));
        stored.put("user", user);
        if (!secureAuthStore.save(stored.toString())) {
            throw new IOException("secure auth write failed");
        }
        return accessToken;
    }

    private void doHttpPut(String urlStr, String token, String jsonBody) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        try {
            conn.setRequestMethod("PUT");
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(15_000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            byte[] payload = jsonBody.getBytes("UTF-8");
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new HttpStatusException(code);
            try (InputStream ignored = conn.getInputStream()) {
                // Consume/close so the HTTP connection can be reused.
            }
        } finally {
            conn.disconnect();
        }
    }

    private JSONObject doHttpPostJson(String urlStr, String jsonBody) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(20_000);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Accept", "application/json");
            conn.setDoOutput(true);
            byte[] payload = jsonBody.getBytes("UTF-8");
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
            int code = conn.getResponseCode();
            InputStream stream = code >= 200 && code < 300
                    ? conn.getInputStream() : conn.getErrorStream();
            StringBuilder body = new StringBuilder();
            if (stream != null) {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(stream, "UTF-8"))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }
            }
            if (code < 200 || code >= 300) throw new HttpStatusException(code);
            return new JSONObject(body.toString());
        } finally {
            conn.disconnect();
        }
    }

    // Mirror of the JS regex in frontend/lib/textChunks.ts: /[^.!?\n]+[.!?\n]*/g.
    // MUST stay byte-identical in behavior to the TS splitter — Java's chunk
    // array indexes the progress JS reads back, but JS divides by ITS own chunk
    // count, so any tokenization drift skews the progress bar after a screen-off
    // auto-advance.
    private static final Pattern SENTENCE_PATTERN = Pattern.compile("[^.!?\\n]+[.!?\\n]*");

    /** Java port of frontend/lib/textChunks.ts splitIntoChunks. */
    private List<String> splitChunksJava(String text, int targetCount, int hardMaxLen) {
        if (text == null || text.isEmpty()) return Collections.emptyList();
        // text.match(/[^.!?\n]+[.!?\n]*/g) ?? [text] — groups trailing delimiters
        // with the sentence and never yields delimiter-only tokens (unlike the
        // old lookbehind split, which produced one token per delimiter).
        List<String> sentences = new ArrayList<>();
        Matcher m = SENTENCE_PATTERN.matcher(text);
        while (m.find()) sentences.add(m.group());
        if (sentences.isEmpty()) sentences.add(text);
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

    /**
     * Consume one queued/fetched chapter as an auto-advance transition.
     * Records {@code completedId} in {@code completedChapterIds}, wraps
     * {@code startChapter} in {@code autoAdvancing=true} (suppresses
     * playFakeSilence + MediaSession re-assertion at chapter boundaries),
     * and posts a deferred {@code native-tts-chapter-advance} event to JS.
     *
     * <p>Callers (see docs/android-player.md for full nav map):
     * <ul>
     *  <li>{@code onChunkFinished} chapter-done — normal auto-advance from queue</li>
     *  <li>{@code mergeQueue} / {@code setPendingPlaylist} / {@code doPrefetchStep}
     *      awaitingFetch branches — delivery when player is waiting</li>
     *  <li>{@code skipToNextChapter} — user hardware skip</li>
     * </ul>
     *
     * <p>See invariant I3 in docs/android-player.md: {@code autoAdvancing=true}
     * is only legitimate inside this helper's call to {@code startChapter}.
     */
    private void deliverAutoAdvance(ChapterItem next, String completedId) {
        // I3: autoAdvancing must start false here — enforces single-caller entry.
        assertInvariant("I3 (deliverAutoAdvance: not already auto-advancing)",
                !autoAdvancing);
        String safeCompletedId = completedId != null ? completedId : "";
        String safeNewId = next.chapterId != null ? next.chapterId : "";
        synchronized (completedChapterIds) {
            completedChapterIds.add(safeCompletedId);
        }
        autoAdvancing = true;
        startChapter(next, 0);
        autoAdvancing = false;
        // Deferred JS notification — fire-and-forget. dispatchJs uses
        // webView.evaluateJavascript which can stall/defer when WebView is
        // paused (screen off). Posting after startChapter ensures TTS is
        // already speaking before any WebView interaction.
        mainHandler.post(() -> dispatchChapterAdvance(safeCompletedId, safeNewId));
    }

    /**
     * Fire {@code native-tts-chapter-advance} to JS. Single source of truth
     * for the event payload format; all callers go through here.
     */
    private void dispatchChapterAdvance(String completedChapterId, String newChapterId) {
        dispatchJs(
                "window.dispatchEvent(new CustomEvent('native-tts-chapter-advance'," +
                "{detail:{completedChapterId:'" + completedChapterId +
                "',newChapterId:'" + newChapterId + "'}}))");
    }

    /**
     * Debug-only runtime check for an invariant documented in
     * docs/android-player.md. Logs a loud error with a stack trace if the
     * invariant is violated — catches future edits that silently break
     * assumptions. No-op in release builds.
     */
    private void assertInvariant(String name, boolean condition) {
        if (BuildConfig.DEBUG && !condition) {
            Log.wtf(TAG, "Invariant violated: " + name,
                    new RuntimeException("invariant-stack"));
        }
    }

    private void startChapter(ChapterItem item, int startIdx) {
        Log.d(TAG, "startChapter ch=" + (item.chapterId != null ? item.chapterId : "null")
                + " chunks=" + (item.chunks != null ? item.chunks.size() : 0)
                + " queue=" + chapterQueue.size()
                + " pendingHead=" + pendingHead + "/" + pendingPlaylist.size()
                + " prefetchVer=" + prefetchVersion);
        currentChunks    = item.chunks;
        updateCurrentChunksSnapshot();
        currentRate      = item.rate;
        currentPitch     = item.pitch;
        currentChapterId = (item.chapterId != null) ? item.chapterId : "";
        currentTotalChunks = (item.chunks != null) ? item.chunks.size() : 0;
        if (item.title != null && !item.title.isEmpty()) currentTitle = item.title;
        recomputeChunkTimings();

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
        persistSession();
        maybeSyncProgressToServer(true);
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
        // Every playback (re)start path requests focus — the natural single
        // point to declare that we want the MediaSession active again.
        sessionWanted = true;
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

        // Restart-chapter action
        PendingIntent prevPi = buildActionIntent(ACTION_PREV, 10);
        // Play/Pause toggle action
        PendingIntent playPausePi = buildActionIntent(ACTION_PLAY_PAUSE, 11);
        // Next-chapter action
        PendingIntent nextPi = buildActionIntent(ACTION_NEXT, 12);
        // Stop action
        PendingIntent stopPi = buildActionIntent(ACTION_STOP, 13);
        // Back-one-chunk action (≈ one sentence group — the audiobook "wait,
        // what did it just say?" button)
        PendingIntent backChunkPi = buildActionIntent(ACTION_BACK_CHUNK, 14);

        int toggleIcon  = isPlaying ? android.R.drawable.ic_media_pause
                                    : android.R.drawable.ic_media_play;
        String toggleLabel = isPlaying ? "Tạm dừng" : "Phát";

        // Chapter title is the prominent line; book title (when known) is the
        // subtitle — the standard audiobook/podcast pattern.
        String primary = (currentTitle != null && !currentTitle.isEmpty())
                ? currentTitle : "TruyệnAudio";
        String subtitle = !currentBookTitle.isEmpty() ? currentBookTitle : "TruyệnAudio";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(primary)
                .setContentText(subtitle)
                .setSmallIcon(R.drawable.ic_stat_headset)
                .setColor(NOTIF_ACCENT)
                .setContentIntent(contentIntent)
                .setOngoing(isPlaying)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                // Compact view (lockscreen pre-13 / collapsed) shows indices
                // 0,2,3 → back-chunk, play/pause, next-chapter. The expanded
                // card shows all five.
                .addAction(android.R.drawable.ic_media_rew, "Lùi đoạn", backChunkPi)
                .addAction(android.R.drawable.ic_media_previous, "Đầu chương", prevPi)
                .addAction(toggleIcon, toggleLabel, playPausePi)
                .addAction(android.R.drawable.ic_media_next, "Chương tiếp", nextPi)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dừng", stopPi)
                .setStyle(new MediaStyle()
                        .setMediaSession(mediaSession != null ? mediaSession.getSessionToken() : null)
                        .setShowActionsInCompactView(0, 2, 3));

        // Book cover as the notification large icon / lockscreen art (once loaded).
        if (currentCoverBitmap != null) {
            builder.setLargeIcon(currentCoverBitmap);
        }

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
            @Override public void onSeekTo(long pos) {
                // Lockscreen / notification seek-bar scrub → chunk jump.
                mainHandler.post(() -> seekToChunk(chunkIndexForPositionMs(pos)));
            }
            @Override public void onRewind() {
                mainHandler.post(() -> seekToChunk(currentChunkIdx - 1));
            }
            @Override public void onFastForward() {
                mainHandler.post(() -> seekToChunk(currentChunkIdx + 1));
            }
        });

        setMetadata(currentTitle);
        updatePlaybackState(false);
    }

    // ── Estimated timeline helpers (lockscreen seek bar) ─────────────────────

    /** Rebuild the immutable content-time mapping from currentChunks. */
    private void recomputeChunkTimings() {
        chapterTimeline = ChapterTimeline.fromChunks(currentChunks);
    }

    /** Estimated content-time position (1.0× ms) of the current chunk start. */
    private long estimatedPositionMs() {
        return chapterTimeline.positionForChunk(currentChunkIdx);
    }

    /** Map a scrubbed content-time position back to a chunk index. */
    private int chunkIndexForPositionMs(long posMs) {
        return chapterTimeline.chunkForPosition(posMs);
    }

    private void updatePlaybackState(boolean playing) {
        if (mediaSession == null) return;
        long actions = PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SEEK_TO
                | PlaybackStateCompat.ACTION_REWIND
                | PlaybackStateCompat.ACTION_FAST_FORWARD
                | PlaybackStateCompat.ACTION_STOP;
        int state = playing ? PlaybackStateCompat.STATE_PLAYING
                            : PlaybackStateCompat.STATE_PAUSED;
        // Real position + speed drive the lockscreen/notification seek bar:
        // the OS extrapolates the position at `speed` while STATE_PLAYING and
        // onSeekTo maps a scrubbed position back to a chunk. Duration lives in
        // the MediaMetadata (see setMetadata).
        float speed = playing ? currentRate : 0f;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(state, estimatedPositionMs(), speed)
                .build());
        syncMedia3();
    }

    private void setMetadata(String title) {
        if (mediaSession == null) return;
        // Book title as artist/album \u2014 what Bluetooth car displays, Android
        // Auto, and the lockscreen show under the chapter title.
        String artist = !currentBookTitle.isEmpty() ? currentBookTitle : "Truy\u1ec7nAudio";
        MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM,  artist);
        // Estimated chapter duration → the OS renders a seek bar on the
        // lockscreen / media notification. Omitted (unknown) when no chapter
        // text is loaded, e.g. a restored-but-cold session.
        if (chapterTimeline.durationMs() > 0) {
            b.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, chapterTimeline.durationMs());
        }
        // Cover art for the lockscreen media card, Android Auto, and BT displays.
        if (currentCoverBitmap != null) {
            b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, currentCoverBitmap);
        }
        mediaSession.setMetadata(b.build());
        syncMedia3();
    }

    List<MediaChapterSnapshot> getMediaChapterSnapshots() {
        List<MediaChapterSnapshot> result = new ArrayList<>();
        boolean includedCurrent = false;
        for (ChapterMeta meta : pendingPlaylist) {
            if (meta.chapterId == null || meta.chapterId.isEmpty()) continue;
            boolean current = meta.chapterId.equals(currentChapterId);
            includedCurrent |= current;
            result.add(new MediaChapterSnapshot(
                    meta.chapterId,
                    meta.title == null || meta.title.isEmpty() ? currentTitle : meta.title,
                    currentBookTitle,
                    currentCoverUrl,
                    current ? chapterTimeline.durationMs() : 0,
                    current));
        }
        if (!includedCurrent && currentChapterId != null && !currentChapterId.isEmpty()) {
            result.add(0, new MediaChapterSnapshot(
                    currentChapterId, currentTitle, currentBookTitle, currentCoverUrl,
                    chapterTimeline.durationMs(), true));
        }
        return result;
    }

    long getEstimatedPositionMs() {
        return estimatedPositionMs();
    }

    float getCurrentRate() {
        return currentRate;
    }

    float getCurrentPitch() {
        return currentPitch;
    }

    void seekToEstimatedPosition(long positionMs) {
        seekToChunk(chunkIndexForPositionMs(positionMs));
    }

    private void syncMedia3() {
        if (media3Player != null) media3Player.syncFromService();
    }
}
