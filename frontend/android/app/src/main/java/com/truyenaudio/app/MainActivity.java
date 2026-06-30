package com.truyenaudio.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int REQ_POST_NOTIFICATIONS = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // The UI is dark, so force light (white) status-bar and nav-bar icons.
        // Without this some OEM/OS versions default to dark icons that vanish
        // against the dark background.
        WindowInsetsControllerCompat insets =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (insets != null) {
            insets.setAppearanceLightStatusBars(false);
            insets.setAppearanceLightNavigationBars(false);
        }

        WebView webView = getBridge().getWebView();
        webView.addJavascriptInterface(new TtsBridge(this, webView), "TtsBridge");

        // Android 13+ requires a runtime permission for the foreground-service
        // notification to display. Without it, the media notification (and
        // therefore lock-screen / BT controls) silently never appears.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                        this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQ_POST_NOTIFICATIONS);
            }
        }
    }

    private long lastBackPressedMs = 0;

    @Override
    public void onBackPressed() {
        // Pop WebView history first so the hardware back button navigates
        // within the app (e.g. listen → book detail) instead of exiting on
        // the first press, especially when the app cold-starts onto a deep
        // link like /listen?id=…
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // At the root with no history: require a second press within 2s before
        // exiting, so a stray back tap can't kill the app (and stop playback)
        // out from under the user.
        long now = System.currentTimeMillis();
        if (now - lastBackPressedMs < 2000) {
            super.onBackPressed();
        } else {
            lastBackPressedMs = now;
            android.widget.Toast.makeText(
                    this, "Nhấn back lần nữa để thoát", android.widget.Toast.LENGTH_SHORT).show();
        }
    }
}
