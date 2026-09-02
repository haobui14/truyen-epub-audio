# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# JavaScript bridge entry points are reached by name from the WebView.
-keepclassmembers class com.truyenaudio.app.TtsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class com.truyenaudio.app.OfflineBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Uncomment this to preserve the line number information for
# debugging stack traces.
-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
