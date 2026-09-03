package com.truyenaudio.app;

import java.util.concurrent.Executor;

/**
 * Serial, latest-wins delivery for background progress updates.
 *
 * <p>A slow request must never finish after a newer request and move the
 * server pointer backwards. While one value is being sent, repeated submits
 * collapse to the most recent value. A failed value remains pending until the
 * next submit/retry, but a newer pending value always supersedes it.</p>
 */
final class LatestProgressSync<T> {
    interface Sender<T> {
        void send(T value) throws Exception;
    }

    interface FailureListener {
        void onFailure(Exception error);
    }

    private final Executor executor;
    private final Sender<T> sender;
    private final FailureListener failureListener;

    private T pending;
    private boolean running;

    LatestProgressSync(
            Executor executor,
            Sender<T> sender,
            FailureListener failureListener) {
        this.executor = executor;
        this.sender = sender;
        this.failureListener = failureListener;
    }

    void submit(T value) {
        boolean schedule = false;
        synchronized (this) {
            pending = value;
            if (!running) {
                running = true;
                schedule = true;
            }
        }
        if (schedule) executor.execute(this::drain);
    }

    private void drain() {
        while (true) {
            T value;
            synchronized (this) {
                value = pending;
                pending = null;
                if (value == null) {
                    running = false;
                    return;
                }
            }

            try {
                sender.send(value);
            } catch (Exception error) {
                failureListener.onFailure(error);
                synchronized (this) {
                    if (pending == null) {
                        // Keep the failed latest value for the next submit.
                        // Do not spin while the device is offline.
                        pending = value;
                        running = false;
                        return;
                    }
                    // A newer value arrived during the failed request. Drop
                    // the stale failure and immediately try the newer value.
                }
            }
        }
    }
}
