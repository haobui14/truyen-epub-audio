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
import java.util.Locale;

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
    private boolean                 currentlyPlaying = false;
    private String                  currentTitle     = "Đang phát TTS...";

    /* ── Native TTS engine ── */
    private TextToSpeech ttsEngine;
    private boolean      ttsReady = false;
    private String[]     chunks;
    private int          currentChunkIdx = -1;
    private float        ttsRate  = 1f;
    private float        ttsPitch = 1f;

    /* ── Pending playback (buffered when TTS engine is still initialising) ── */
    private String[]     pendingChunks;
    private float        pendingRate;
    private float        pendingPitch;
    private int          pendingStartIdx;
    private boolean      hasPendingPlayback = false;

    /* ── Callback: service → WebView ── */
    public interface PlaybackCallback {
        default void onSkipPrev() {}
        default void onSkipNext() {}
        default void onChunkStart(int index) {}
        default void onPlaybackDone() {}
        default void onStateChanged(boolean playing, int chunkIndex) {}
    }
    private static PlaybackCallback sCallback;
    public static void setCallback(PlaybackCallback cb) { sCallback = cb; }

    /* ── Static accessor ── */
    private static TtsPlaybackService sInstance;

    public static void updateTitle(String title) {
        if (sInstance != null && title != null && !title.isEmpty()) {
            sInstance.currentTitle = title;
            sInstance.setMetadata(title);
            sInstance.updateNotification();
        }
    }

    /* ═══════════════════════════════ lifecycle ══════════════════════════════ */

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        createNotificationChannel();
        setupMediaSession();
        registerToggleReceiver();
        registerNoisyReceiver();
        initTtsEngine();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
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
        unregisterToggleReceiver();
        unregisterNoisyReceiver();
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
        } else {
            // All chunks done
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
        ttsEngine.speak(chunks[currentChunkIdx], TextToSpeech.QUEUE_FLUSH, null, "chunk_" + currentChunkIdx);
    }

    /* ── Public static methods called from TtsBridge ── */

    public static void startPlayback(String[] textChunks, float rate, float pitch, int startIdx) {
        if (sInstance == null) return;
        // If TTS engine is still initialising, buffer the request for later
        if (!sInstance.ttsReady) {
            sInstance.pendingChunks = textChunks;
            sInstance.pendingRate = rate;
            sInstance.pendingPitch = pitch;
            sInstance.pendingStartIdx = startIdx;
            sInstance.hasPendingPlayback = true;
            return;
        }
        sInstance.hasPendingPlayback = false;
        sInstance.chunks = textChunks;
        sInstance.currentChunkIdx = startIdx;
        sInstance.ttsRate = rate;
        sInstance.ttsPitch = pitch;
        sInstance.currentlyPlaying = true;
        sInstance.updatePlaybackState(true);
        sInstance.updateNotification();
        sInstance.speakCurrentChunk();
    }

    public static void pausePlayback() {
        if (sInstance == null) return;
        if (sInstance.ttsEngine != null) sInstance.ttsEngine.stop();
        sInstance.currentlyPlaying = false;
        sInstance.updatePlaybackState(false);
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
        if (sInstance.ttsEngine != null) sInstance.ttsEngine.stop();
        sInstance.chunks = null;
        sInstance.currentChunkIdx = -1;
        sInstance.currentlyPlaying = false;
        sInstance.hasPendingPlayback = false;
        sInstance.pendingChunks = null;
        sInstance.updatePlaybackState(false);
        sInstance.updateNotification();
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

    public static boolean isCurrentlyPlaying() {
        return sInstance != null && sInstance.currentlyPlaying;
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
