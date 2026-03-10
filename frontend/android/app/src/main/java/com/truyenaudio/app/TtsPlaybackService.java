package com.truyenaudio.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.view.KeyEvent;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;
import java.util.LinkedList;
import java.util.Locale;
import java.util.Queue;
import android.os.Handler;
import android.os.Looper;

/**
 * Foreground service with native TTS engine.
 * Plays text chunks entirely in Java — no JS callbacks between chunks,
 * so playback continues even when the WebView is suspended (screen off).
 */
public class TtsPlaybackService extends Service {

    private static final String CHANNEL_ID   = "tts_playback_channel";
    private static final int    NOTIFICATION_ID = 1001;
    public  static final String ACTION_TOGGLE    = "com.truyenaudio.app.ACTION_TOGGLE";
    public  static final String ACTION_PREV      = "com.truyenaudio.app.ACTION_PREV";
    public  static final String ACTION_NEXT      = "com.truyenaudio.app.ACTION_NEXT";

    private PowerManager.WakeLock   wakeLock;
    private MediaSessionCompat      mediaSession;
    private BroadcastReceiver       toggleReceiver;
    private BroadcastReceiver       noisyReceiver;
    private Handler                 mainHandler;
    private boolean                 currentlyPlaying = false;
    private String                  currentTitle     = "Đang phát TTS...";

    /* ── Fake silent MediaPlayer to make Android treat our MediaSession as truly active.
     *    Android's TTS engine doesn't count as "real" media playback, so without this
     *    the OS routes earbud/BT button events to the TTS engine's internal session. ── */
    private MediaPlayer             silentPlayer;

    /* ── Sleep timer (absolute epoch-ms; -1 = not active) ── */
    private long sleepExpireAtMs = -1;
    private final Runnable sleepExpireRunnable = new Runnable() {
        @Override public void run() {
            if (currentlyPlaying) pausePlayback();
            sleepExpireAtMs = -1;
        }
    };

    /* ── Periodic re-assertion of MediaSession while playing ── */
    private static final long REASSERT_INTERVAL_MS = 3000;
    private final Runnable reassertRunnable = new Runnable() {
        @Override public void run() {
            if (mediaSession != null && currentlyPlaying) {
                mediaSession.setActive(true);
                updatePlaybackState(true);
                mainHandler.postDelayed(this, REASSERT_INTERVAL_MS);
            }
        }
    };

    /* ── Native TTS engine ── */
    private TextToSpeech ttsEngine;
    private boolean      ttsReady = false;
    private String[]     chunks;
    private int          currentChunkIdx = -1;
    private float        ttsRate  = 1f;
    private float        ttsPitch = 1f;
    private String       currentChapterId = null;

    /* ── Pending playback (buffered when TTS engine is still initialising) ── */
    private String[]     pendingChunks;
    private float        pendingRate;
    private float        pendingPitch;
    private int          pendingStartIdx;
    private boolean      hasPendingPlayback = false;

    /* ── Chapter queue (for seamless background chapter transitions through ALL chapters) ── */
    private static class QueuedChapter {
        final String[] chunks;
        final String chapterId;
        final String title;
        final float rate;
        final float pitch;
        QueuedChapter(String[] chunks, String chapterId, String title, float rate, float pitch) {
            this.chunks = chunks;
            this.chapterId = chapterId;
            this.title = title;
            this.rate = rate;
            this.pitch = pitch;
        }
    }
    private final Queue<QueuedChapter> chapterQueue = new LinkedList<>();

    /* ── Callback: service → WebView ── */
    public interface PlaybackCallback {
        default void onSkipPrev() {}
        default void onSkipNext() {}
        default void onChunkStart(int index) {}
        default void onPlaybackDone() {}
        default void onStateChanged(boolean playing, int chunkIndex) {}
        /** Fired when the service auto-advances to a queued next chapter. */
        default void onChapterAdvance(String chapterId) {}
    }
    private static PlaybackCallback sCallback;
    public static void setCallback(PlaybackCallback cb) { sCallback = cb; }

    /* ── Static accessor ── */
    private static TtsPlaybackService sInstance;

    /* ── Static pending: survives before the service instance is created ── */
    private static String[]  sPreStartChunks;
    private static float     sPreStartRate;
    private static float     sPreStartPitch;
    private static int       sPreStartIdx;
    private static String    sPreStartTitle;
    private static String    sPreStartChapterId;
    private static boolean   sHasPreStart = false;

    public static void updateTitle(String title) {
        if (sInstance != null && title != null && !title.isEmpty()) {
            sInstance.currentTitle = title;
            sInstance.setMetadata(title);
            sInstance.updateNotification();
        } else if (title != null && !title.isEmpty()) {
            sPreStartTitle = title;
        }
    }

    /* ═══════════════════════════════ lifecycle ══════════════════════════════ */

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        mainHandler = new Handler(Looper.getMainLooper());
        createNotificationChannel();
        setupMediaSession();
        registerToggleReceiver();
        registerNoisyReceiver();

        // Apply any title that was set before the service was created
        if (sPreStartTitle != null) {
            currentTitle = sPreStartTitle;
            sPreStartTitle = null;
        }

        initTtsEngine();

        // Pick up any playback request that arrived before the service was created.
        // startPlayback handles the case where TTS engine isn't ready yet (buffers it).
        if (sHasPreStart) {
            sHasPreStart = false;
            startPlayback(sPreStartChunks, sPreStartRate, sPreStartPitch, sPreStartIdx, sPreStartChapterId);
            sPreStartChunks = null;
            sPreStartChapterId = null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Route media button intents (from earbuds/BT) to the MediaSession
        if (mediaSession != null && intent != null) {
            MediaButtonReceiver.handleIntent(mediaSession, intent);
        }

        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        acquireWakeLock();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (mainHandler != null) {
            mainHandler.removeCallbacks(reassertRunnable);
            mainHandler.removeCallbacksAndMessages(null);
        }
        unregisterToggleReceiver();
        unregisterNoisyReceiver();
        if (silentPlayer != null) {
            silentPlayer.release();
            silentPlayer = null;
        }
        if (ttsEngine != null) {
            ttsEngine.stop();
            ttsEngine.shutdown();
            ttsEngine = null;
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        releaseWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        sInstance = null;
        super.onDestroy();
    }

    @Nullable @Override
    public IBinder onBind(Intent intent) { return null; }

    /* ═══════════════════════════════ Native TTS ═══════════════════════════ */

    private void initTtsEngine() {
        ttsEngine = new TextToSpeech(this, status -> {
            ttsReady = (status == TextToSpeech.SUCCESS);
            if (ttsReady) {
                ttsEngine.setLanguage(new Locale("vi", "VN"));
                // Set AudioAttributes to USAGE_MEDIA so the TTS engine shares the
                // same audio stream as our silent MediaPlayer, reducing session conflicts.
                ttsEngine.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                ttsEngine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id)  { onChunkFinished(); }
                    @Override public void onError(String id) { onChunkFinished(); }
                });
                // Execute any playback request that arrived before the engine was ready
                if (hasPendingPlayback) {
                    hasPendingPlayback = false;
                    startPlayback(pendingChunks, pendingRate, pendingPitch, pendingStartIdx);
                    pendingChunks = null;
                }
            }
        });
    }

    private void onChunkFinished() {
        if (chunks == null || !currentlyPlaying) return;
        currentChunkIdx++;
        if (currentChunkIdx < chunks.length) {
            if (sCallback != null) sCallback.onChunkStart(currentChunkIdx);
            speakCurrentChunk();
        } else if (!chapterQueue.isEmpty()) {
            // Auto-advance to next queued chapter — no JS round-trip needed
            QueuedChapter next = chapterQueue.poll();
            String advancedId = next.chapterId;
            currentChapterId = advancedId;
            chunks = next.chunks;
            currentChunkIdx = 0;
            ttsRate = next.rate;
            ttsPitch = next.pitch;
            if (next.title != null) currentTitle = next.title;

            updatePlaybackState(true);
            updateNotification();
            if (sCallback != null) {
                sCallback.onChapterAdvance(advancedId);
                sCallback.onChunkStart(0);
            }
            speakCurrentChunk();
        } else {
            // All chunks done, no more chapters queued
            currentlyPlaying = false;
            updatePlaybackState(false);
            updateNotification();
            if (sCallback != null) sCallback.onPlaybackDone();
        }
    }

    private void speakCurrentChunk() {
        if (!ttsReady || chunks == null || currentChunkIdx < 0 || currentChunkIdx >= chunks.length) return;
        ttsEngine.setSpeechRate(ttsRate);
        ttsEngine.setPitch(ttsPitch);
        // Play a silent audio clip BEFORE TTS speak() so Android considers our
        // MediaSession the active media-playing session. Without this, the TTS
        // engine's internal session steals earbud/BT button routing.
        playFakeSilence();
        ttsEngine.speak(chunks[currentChunkIdx], TextToSpeech.QUEUE_FLUSH, null, "chunk_" + currentChunkIdx);
        reassertMediaSession();
    }

    /**
     * Force our MediaSession to be the active one.
     * Called after ttsEngine.speak() and ttsEngine.stop() because the TTS
     * engine's internal MediaSession competes with ours for active status.
     * We assert both immediately and with delays to cover the TTS engine's
     * asynchronous session activation, and start a periodic re-assertion loop.
     */
    private void reassertMediaSession() {
        if (mediaSession == null) return;
        mediaSession.setActive(true);
        updatePlaybackState(currentlyPlaying);
        if (mainHandler != null) {
            // Remove any pending reassert callbacks to avoid duplicates
            mainHandler.removeCallbacks(reassertRunnable);
            mainHandler.postDelayed(() -> {
                if (mediaSession != null) {
                    mediaSession.setActive(true);
                    updatePlaybackState(currentlyPlaying);
                }
            }, 100);
            mainHandler.postDelayed(() -> {
                if (mediaSession != null) {
                    mediaSession.setActive(true);
                    updatePlaybackState(currentlyPlaying);
                }
            }, 300);
            mainHandler.postDelayed(() -> {
                if (mediaSession != null) {
                    mediaSession.setActive(true);
                    updatePlaybackState(currentlyPlaying);
                }
            }, 600);
            // Start periodic re-assertion while playing
            if (currentlyPlaying) {
                mainHandler.postDelayed(reassertRunnable, REASSERT_INTERVAL_MS);
            }
        }
    }

    /**
     * Play a short silent audio clip via MediaPlayer to make Android treat our
     * MediaSession as the active media-playing session. TTS alone doesn't count
     * as "real" media playback, so without this Android routes earbud/BT button
     * events to the TTS engine's internal session instead of ours.
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
                    // Don't release immediately — keep it alive briefly so
                    // Android continues to associate our session with media playback
                    if (mainHandler != null) {
                        mainHandler.postDelayed(() -> {
                            if (silentPlayer != null) {
                                silentPlayer.release();
                                silentPlayer = null;
                            }
                        }, 2000);
                    }
                });
                silentPlayer.start();
            }
        } catch (Exception e) {
            // Silence player is a best-effort enhancement; don't crash if it fails
        }
    }

    /* ── Public static methods called from TtsBridge ── */

    public static void startPlayback(String[] textChunks, float rate, float pitch, int startIdx) {
        startPlayback(textChunks, rate, pitch, startIdx, null);
    }

    public static void startPlayback(String[] textChunks, float rate, float pitch, int startIdx, String chapterId) {
        if (sInstance == null) {
            // Service not created yet — buffer for when onCreate runs
            sPreStartChunks = textChunks;
            sPreStartRate = rate;
            sPreStartPitch = pitch;
            sPreStartIdx = startIdx;
            sPreStartChapterId = chapterId;
            sHasPreStart = true;
            return;
        }
        // If TTS engine is still initialising, buffer the request for later
        if (!sInstance.ttsReady) {
            sInstance.pendingChunks = textChunks;
            sInstance.pendingRate = rate;
            sInstance.pendingPitch = pitch;
            sInstance.pendingStartIdx = startIdx;
            sInstance.hasPendingPlayback = true;
            if (chapterId != null) sInstance.currentChapterId = chapterId;
            return;
        }
        sInstance.hasPendingPlayback = false;
        sInstance.chunks = textChunks;
        sInstance.currentChunkIdx = startIdx;
        sInstance.ttsRate = rate;
        sInstance.ttsPitch = pitch;
        if (chapterId != null) sInstance.currentChapterId = chapterId;
        sInstance.currentlyPlaying = true;
        sInstance.updatePlaybackState(true);
        sInstance.updateNotification();
        sInstance.speakCurrentChunk();
    }

    public static void pausePlayback() {
        if (sInstance == null) return;
        if (sInstance.ttsEngine != null) sInstance.ttsEngine.stop();
        sInstance.currentlyPlaying = false;
        // Stop the periodic re-assertion loop
        if (sInstance.mainHandler != null) {
            sInstance.mainHandler.removeCallbacks(sInstance.reassertRunnable);
        }
        // Re-assert our MediaSession so earbuds can still resume playback.
        // ttsEngine.stop() may activate the TTS engine's internal session.
        sInstance.reassertMediaSession();
        sInstance.updateNotification();
        if (sCallback != null) sCallback.onStateChanged(false, sInstance.currentChunkIdx);
    }

    public static void resumePlayback() {
        if (sInstance == null || sInstance.chunks == null || sInstance.currentChunkIdx < 0) return;
        sInstance.currentlyPlaying = true;
        sInstance.updatePlaybackState(true);
        sInstance.updateNotification();
        sInstance.speakCurrentChunk();
        if (sCallback != null) sCallback.onStateChanged(true, sInstance.currentChunkIdx);
    }

    public static void stopPlayback() {
        if (sInstance == null) return;
        if (sInstance.mainHandler != null) {
            sInstance.mainHandler.removeCallbacks(sInstance.reassertRunnable);
            sInstance.mainHandler.removeCallbacks(sInstance.sleepExpireRunnable);
        }
        sInstance.sleepExpireAtMs = -1;
        if (sInstance.ttsEngine != null) sInstance.ttsEngine.stop();
        sInstance.chunks = null;
        sInstance.currentChunkIdx = -1;
        sInstance.currentChapterId = null;
        sInstance.currentlyPlaying = false;
        sInstance.hasPendingPlayback = false;
        sInstance.pendingChunks = null;
        sInstance.chapterQueue.clear();
        sInstance.updatePlaybackState(false);
        sInstance.updateNotification();
    }

    /** Queue a single chapter for seamless auto-advance. */
    public static void queueNextChapter(String[] textChunks, String chapterId, String title, float rate, float pitch) {
        if (sInstance == null) return;
        sInstance.chapterQueue.add(new QueuedChapter(textChunks, chapterId, title, rate, pitch));
    }

    /** Replace the entire chapter queue with multiple chapters at once. */
    public static void queueAllChapters(QueuedChapter[] chapters) {
        if (sInstance == null) return;
        sInstance.chapterQueue.clear();
        for (QueuedChapter ch : chapters) {
            sInstance.chapterQueue.add(ch);
        }
    }

    public static void clearNextChapter() {
        if (sInstance == null) return;
        sInstance.chapterQueue.clear();
    }

    public static void setRate(float rate) {
        if (sInstance != null) sInstance.ttsRate = rate;
    }

    public static void setPitch(float pitch) {
        if (sInstance != null) sInstance.ttsPitch = pitch;
    }

    public static int getCurrentChunk() {
        return sInstance != null ? sInstance.currentChunkIdx : -1;
    }

    public static String getCurrentChapterId() {
        return sInstance != null ? sInstance.currentChapterId : null;
    }

    public static boolean isCurrentlyPlaying() {
        return sInstance != null && sInstance.currentlyPlaying;
    }

    /**
     * Schedule the sleep timer to fire at an absolute epoch-ms timestamp.
     * Uses Handler.postDelayed so it fires even when the WebView is suspended.
     */
    public static void setSleepTimer(long expireAtMs) {
        if (sInstance == null) return;
        sInstance.mainHandler.removeCallbacks(sInstance.sleepExpireRunnable);
        sInstance.sleepExpireAtMs = expireAtMs;
        long delay = expireAtMs - System.currentTimeMillis();
        if (delay <= 0) {
            if (sInstance.currentlyPlaying) pausePlayback();
            sInstance.sleepExpireAtMs = -1;
        } else {
            sInstance.mainHandler.postDelayed(sInstance.sleepExpireRunnable, delay);
        }
    }

    /** Cancel the sleep timer without stopping playback. */
    public static void cancelSleepTimer() {
        if (sInstance == null) return;
        sInstance.mainHandler.removeCallbacks(sInstance.sleepExpireRunnable);
        sInstance.sleepExpireAtMs = -1;
    }

    /* ═══════════════════════════════ MediaSession ═══════════════════════════ */

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

        // Set media button receiver so Android routes earbud/BT button events here
        android.content.ComponentName mbr = new android.content.ComponentName(this, TtsPlaybackService.class);
        Intent mediaButtonIntent = new Intent(Intent.ACTION_MEDIA_BUTTON);
        mediaButtonIntent.setComponent(mbr);
        PendingIntent mbrPending = PendingIntent.getService(
                this, 0, mediaButtonIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        mediaSession.setMediaButtonReceiver(mbrPending);

        // MediaSession callbacks handle play/pause NATIVELY — no JS round-trip needed.
        // This is critical for lock-screen / headphone / BT controls when WebView is suspended.
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public boolean onMediaButtonEvent(Intent mediaButtonEvent) {
                KeyEvent event = mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (event != null && event.getAction() == KeyEvent.ACTION_DOWN) {
                    int keyCode = event.getKeyCode();
                    if (keyCode == KeyEvent.KEYCODE_HEADSETHOOK
                            || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
                        if (currentlyPlaying) pausePlayback();
                        else if (chunks != null) resumePlayback();
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY) {
                        if (!currentlyPlaying && chunks != null) resumePlayback();
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                        if (currentlyPlaying) pausePlayback();
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_STOP) {
                        stopPlayback();
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
                        if (sCallback != null) sCallback.onSkipNext();
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
                        if (sCallback != null) sCallback.onSkipPrev();
                        return true;
                    }
                }
                return super.onMediaButtonEvent(mediaButtonEvent);
            }
            @Override public void onPlay() {
                if (chunks != null && !currentlyPlaying) resumePlayback();
            }
            @Override public void onPause() {
                if (currentlyPlaying) pausePlayback();
            }
            @Override public void onStop() {
                stopPlayback();
            }
            @Override public void onSkipToPrevious() {
                if (sCallback != null) sCallback.onSkipPrev();
            }
            @Override public void onSkipToNext() {
                if (sCallback != null) sCallback.onSkipNext();
            }
        });

        setMetadata(currentTitle);
        mediaSession.setActive(true);
        updatePlaybackState(false);
    }

    private void updatePlaybackState(boolean playing) {
        if (mediaSession == null) return;
        long actions = PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        int state = playing
                ? PlaybackStateCompat.STATE_PLAYING
                : PlaybackStateCompat.STATE_PAUSED;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());
    }

    private void setMetadata(String title) {
        if (mediaSession == null) return;
        mediaSession.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE,  title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "TruyệnAudio")
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM,  "TruyệnAudio")
                .build());
    }

    /* ═══════════════════════════════ notification ═══════════════════════════ */

    private Notification buildNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent prevBroadcast = new Intent(ACTION_PREV);
        prevBroadcast.setPackage(getPackageName());
        PendingIntent prevPending = PendingIntent.getBroadcast(
                this, 2, prevBroadcast,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent toggleBroadcast = new Intent(ACTION_TOGGLE);
        toggleBroadcast.setPackage(getPackageName());
        PendingIntent togglePending = PendingIntent.getBroadcast(
                this, 1, toggleBroadcast,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent nextBroadcast = new Intent(ACTION_NEXT);
        nextBroadcast.setPackage(getPackageName());
        PendingIntent nextPending = PendingIntent.getBroadcast(
                this, 3, nextBroadcast,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        int toggleIcon  = currentlyPlaying ? android.R.drawable.ic_media_pause
                                           : android.R.drawable.ic_media_play;
        String toggleLabel = currentlyPlaying ? "Tạm dừng" : "Phát";

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("TruyệnAudio")
                .setContentText(currentTitle)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(contentIntent)
                .addAction(new NotificationCompat.Action(
                        android.R.drawable.ic_media_previous, "Trước", prevPending))
                .addAction(new NotificationCompat.Action(
                        toggleIcon, toggleLabel, togglePending))
                .addAction(new NotificationCompat.Action(
                        android.R.drawable.ic_media_next, "Tiếp", nextPending))
                .setStyle(new MediaStyle()
                        .setMediaSession(mediaSession.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2))
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(currentlyPlaying)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build();
    }

    private void updateNotification() {
        setMetadata(currentTitle);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
    }

    /* ═══════════════════════════════ broadcast receiver ════════════════════ */

    private void registerToggleReceiver() {
        toggleReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                String action = intent.getAction();
                // Toggle is handled natively — no JS round-trip
                if (ACTION_TOGGLE.equals(action)) {
                    if (currentlyPlaying) pausePlayback();
                    else resumePlayback();
                }
                else if (ACTION_PREV.equals(action) && sCallback != null) sCallback.onSkipPrev();
                else if (ACTION_NEXT.equals(action) && sCallback != null) sCallback.onSkipNext();
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_TOGGLE);
        filter.addAction(ACTION_PREV);
        filter.addAction(ACTION_NEXT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(toggleReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(toggleReceiver, filter);
        }
    }

    private void unregisterToggleReceiver() {
        if (toggleReceiver != null) {
            try { unregisterReceiver(toggleReceiver); } catch (Exception ignored) {}
            toggleReceiver = null;
        }
    }

    /* ═══════════════════════════ becoming noisy (earbud disconnect) ═════════ */

    private void registerNoisyReceiver() {
        noisyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (android.media.AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                    if (currentlyPlaying) pausePlayback();
                }
            }
        };
        IntentFilter filter = new IntentFilter(android.media.AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(noisyReceiver, filter);
        }
    }

    private void unregisterNoisyReceiver() {
        if (noisyReceiver != null) {
            try { unregisterReceiver(noisyReceiver); } catch (Exception ignored) {}
            noisyReceiver = null;
        }
    }

    /* ═══════════════════════════════ WakeLock ═══════════════════════════════ */

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK, "TruyenAudio::TtsWakeLock");
                wakeLock.acquire(4 * 60 * 60 * 1000L);
            }
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) { wakeLock.release(); wakeLock = null; }
    }

    /* ═══════════════════════════════ channel ════════════════════════════════ */

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "TTS Playback", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Hiển thị khi đang phát audio");
            channel.setShowBadge(false);
            channel.enableVibration(false);
            channel.setSound(null, null);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }
}
