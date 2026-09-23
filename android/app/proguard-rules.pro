# Nothing is obfuscated or stripped (the app is a thin WebView shell), but the
# file must exist: the release build type references it.
-keep class com.spotiduck.app.** { *; }
# The @JavascriptInterface methods are called by name from JavaScript.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
