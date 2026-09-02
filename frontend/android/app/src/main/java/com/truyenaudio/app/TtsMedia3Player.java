package com.truyenaudio.app;

import android.net.Uri;
import android.os.Looper;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.SimpleBasePlayer;
import androidx.media3.common.util.UnstableApi;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import java.util.ArrayList;
import java.util.List;

/** Media3 view/controller facade over the existing deterministic TTS engine. */
@UnstableApi
final class TtsMedia3Player extends SimpleBasePlayer {
    private final TtsPlaybackService service;

    TtsMedia3Player(TtsPlaybackService service, Looper looper) {
        super(looper);
        this.service = service;
    }

    void syncFromService() {
        invalidateState();
    }

    @Override
    protected State getState() {
        List<TtsPlaybackService.MediaChapterSnapshot> snapshots =
                service.getMediaChapterSnapshots();
        List<MediaItemData> playlist = new ArrayList<>(snapshots.size());
        int currentIndex = 0;
        for (int index = 0; index < snapshots.size(); index++) {
            TtsPlaybackService.MediaChapterSnapshot chapter = snapshots.get(index);
            if (chapter.current) currentIndex = index;
            MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                    .setTitle(chapter.title)
                    .setArtist(chapter.bookTitle)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER);
            if (!chapter.coverUrl.isEmpty()) metadata.setArtworkUri(Uri.parse(chapter.coverUrl));
            MediaItem mediaItem = new MediaItem.Builder()
                    .setMediaId(chapter.chapterId)
                    .setMediaMetadata(metadata.build())
                    .build();
            long durationUs = chapter.durationMs > 0
                    ? chapter.durationMs * 1_000L : C.TIME_UNSET;
            playlist.add(new MediaItemData.Builder(chapter.chapterId)
                    .setMediaItem(mediaItem)
                    .setDurationUs(durationUs)
                    .build());
        }

        Player.Commands commands = new Player.Commands.Builder()
                .addAll(
                        Player.COMMAND_PLAY_PAUSE,
                        Player.COMMAND_STOP,
                        Player.COMMAND_RELEASE,
                        Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                        Player.COMMAND_GET_TIMELINE,
                        Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                        Player.COMMAND_SEEK_TO_NEXT,
                        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                        Player.COMMAND_SEEK_TO_PREVIOUS,
                        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                        Player.COMMAND_SET_SPEED_AND_PITCH)
                .build();
        boolean hasMedia = !playlist.isEmpty();
        return new State.Builder()
                .setAvailableCommands(commands)
                .setPlaylist(ImmutableList.copyOf(playlist))
                .setCurrentMediaItemIndex(hasMedia ? currentIndex : C.INDEX_UNSET)
                .setContentPositionMs(service.getEstimatedPositionMs())
                .setPlaybackParameters(new PlaybackParameters(
                        service.getCurrentRate(), service.getCurrentPitch()))
                .setPlaybackState(hasMedia ? Player.STATE_READY : Player.STATE_IDLE)
                .setPlayWhenReady(
                        hasMedia && service.isPlaying,
                        Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                .build();
    }

    @Override
    protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
        if (playWhenReady) service.resumePlayback();
        else service.pausePlayback();
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleSeek(
            int mediaItemIndex, long positionMs, @Player.Command int seekCommand) {
        if (seekCommand == Player.COMMAND_SEEK_TO_NEXT
                || seekCommand == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM) {
            service.skipToNextChapter();
        } else if (seekCommand == Player.COMMAND_SEEK_TO_PREVIOUS
                || seekCommand == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM) {
            service.restartCurrentChapter();
        } else if (positionMs != C.TIME_UNSET) {
            service.seekToEstimatedPosition(positionMs);
        }
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleSetPlaybackParameters(
            PlaybackParameters playbackParameters) {
        service.setRate(playbackParameters.speed);
        service.setPitch(playbackParameters.pitch);
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleStop() {
        service.stopPlayback();
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleRelease() {
        return Futures.immediateVoidFuture();
    }
}
