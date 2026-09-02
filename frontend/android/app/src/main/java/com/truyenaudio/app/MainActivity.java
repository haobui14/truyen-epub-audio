package com.truyenaudio.app;

import android.app.DownloadManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.URLUtil;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        NativeCrashStore.install(this);
        super.onCreate(savedInstanceState);

        // Target SDK 36 is edge-to-edge by definition. Opt in explicitly on
        // older supported releases too, then forward measured insets to CSS so
        // cutouts, gesture navigation, three-button nav, and landscape all use
        // one native source of truth.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

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
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            androidx.core.graphics.Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            float density = getResources().getDisplayMetrics().density;
            final float top = bars.top / density;
            final float right = bars.right / density;
            final float bottom = bars.bottom / density;
            final float left = bars.left / density;
            webView.post(() -> webView.evaluateJavascript(
                    "document.documentElement.style.setProperty('--sat-native','" + top + "px');"
                            + "document.documentElement.style.setProperty('--sar-native','" + right + "px');"
                            + "document.documentElement.style.setProperty('--sab-native','" + bottom + "px');"
                            + "document.documentElement.style.setProperty('--sal-native','" + left + "px');"
                            + "window.dispatchEvent(new CustomEvent('native-insets-change'));",
                    null));
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);

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
