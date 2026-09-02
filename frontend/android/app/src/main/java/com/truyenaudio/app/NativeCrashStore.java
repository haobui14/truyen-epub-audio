package com.truyenaudio.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/** Persists a privacy-safe native crash breadcrumb for the next launch. */
final class NativeCrashStore {
    private static final String PREFS = "native_crash_recovery";
    private static final String KEY = "pending";
    private static boolean installed;

    private NativeCrashStore() {}

    static synchronized void install(Context context) {
        if (installed) return;
        installed = true;
        Context app = context.getApplicationContext();
        Thread.UncaughtExceptionHandler previous =
                Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                JSONObject crash = new JSONObject();
                crash.put("exception", error.getClass().getName());
                crash.put("thread", thread.getName());
                crash.put("sdk", Build.VERSION.SDK_INT);
                crash.put("app_version", BuildConfig.VERSION_NAME);
                crash.put("time", System.currentTimeMillis());
                JSONArray frames = new JSONArray();
                StackTraceElement[] stack = error.getStackTrace();
                for (int index = 0; index < Math.min(stack.length, 24); index++) {
                    StackTraceElement frame = stack[index];
                    frames.put(frame.getClassName() + "." + frame.getMethodName()
                            + ":" + frame.getLineNumber());
                }
                crash.put("frames", frames);
                app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putString(KEY, crash.toString()).commit();
            } catch (Exception ignored) {}
            if (previous != null) previous.uncaughtException(thread, error);
            else android.os.Process.killProcess(android.os.Process.myPid());
        });
    }

    static String consume(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String crash = preferences.getString(KEY, "");
        if (!crash.isEmpty()) preferences.edit().remove(KEY).commit();
        return crash;
    }
}
