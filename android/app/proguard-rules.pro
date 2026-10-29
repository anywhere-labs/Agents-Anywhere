# Keep this file ready for release-specific shrinker rules.

# Reflection / JNI heavy third-party code: keep the whole library so a minified
# release build behaves like the debug build for these renderers.
-keep class org.scilab.forge.jlatexmath.** { *; }
-keep class com.termux.terminal.** { *; }
-keep class io.github.rosemoe.sora.** { *; }
-keep class com.theartofdev.edmodo.cropper.** { *; }

# Keep annotations used by kotlinx/okhttp consumer rules.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
