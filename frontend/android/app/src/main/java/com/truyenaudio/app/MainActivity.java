package com.truyenaudio.app;

import android.app.DownloadManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.URLUtil;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        NativeCrashStore.install(this);
        super.onCreate(savedInstanceState);

        // NOTE: do NOT call WindowCompat.setDecorFitsSystemWindows(window, false)
        // here. Capacitor 8's built-in SystemBars plugin owns window insets: it
        // listens on the WebView's parent and, when it can't pass real insets
        // through to CSS (WebView < 140, or before DOMContentLoaded sets
        // hasViewportCover), it zeroes systemBars()/displayCutout() on the way
        // down and only compensates with parent padding on API >= 35. Below
        // API 35 it relies on the platform default of the decor view fitting
        // system windows, so forcing that off left the WebView full-bleed with
        // every inset reported as 0 — content ran under the status and nav bars
        // (seen on Samsung). On API 35+ (targetSdk 36) edge-to-edge is the
        // framework default anyway, so this call bought nothing and broke
        // older releases. Safe-area values reach CSS via the plugin's
        // --safe-area-inset-* custom properties; see globals.css.

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
        webView.addJavascriptInterface(new OfflineBridge(this), "OfflineBridge");
        // The WebView silently drops responses served with Content-Disposition:
        // attachment — the tap just does nothing. Route them to DownloadManager
        // so any download link works even outside the TtsBridge.downloadFile
        // path (which the EPUB button uses to avoid a doubled request).
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url == null
                    || !(url.startsWith("http://") || url.startsWith("https://"))) {
                return; // blob:/data: URLs can't be re-fetched by DownloadManager
            }
            try {
                String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setTitle(name);
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) dm.enqueue(req);
            } catch (Exception ignored) {
            }
        });

    }
}
