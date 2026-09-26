plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.spotiduck.app"
    compileSdk = 34

    defaultConfig {
        /**
         * Identifiant **propre à ce projet**, et non `com.spotiduck.app` : sur un
         * téléphone où cette application est déjà installée par un autre
         * distributeur (autre clé de signature), Android refuse l'installation
         * avec « le paquet est en conflit avec un paquet existant ». Avec un
         * identifiant distinct, l'APK s'installe toujours, sans désinstaller
         * quoi que ce soit — et les mises à jour suivantes fonctionnent puisque
         * la clé et le certificat sont désormais figés (voir keystore/README.md).
         */
        applicationId = "com.spotiduck.rework"
        minSdk = 24
        targetSdk = 34
        // Overridable from the command line (CI passes the run number and the
        // version from package.json).
        versionCode = (findProperty("sdVersionCode") as String?)?.toIntOrNull() ?: 38
        versionName = (findProperty("sdVersionName") as String?)?.takeIf { it.isNotBlank() } ?: "2.11.29"
    }

    /**
     * Signing: the CI generates a keystore (or uses the `SD_KEYSTORE_BASE64`
     * secret) and exports SD_KEYSTORE / SD_KEYSTORE_PASSWORD / SD_KEY_ALIAS /
     * SD_KEY_PASSWORD. When none of that is present we fall back to the debug
     * key, so `gradle assembleRelease` never fails locally.
     */
    signingConfigs {
        create("release") {
            val path = System.getenv("SD_KEYSTORE")
            if (!path.isNullOrBlank() && file(path).exists()) {
                storeFile = file(path)
                storePassword = System.getenv("SD_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SD_KEY_ALIAS")?.takeIf { it.isNotBlank() } ?: "spotiduck"
                keyPassword = System.getenv("SD_KEY_PASSWORD")?.takeIf { it.isNotBlank() }
                    ?: System.getenv("SD_KEYSTORE_PASSWORD")
                // Gradle defaults to JKS; the CI ships a PKCS#12 container.
                storeType = System.getenv("SD_KEYSTORE_TYPE")?.takeIf { it.isNotBlank() }
                    ?: if (path.endsWith(".p12") || path.endsWith(".pfx")) "PKCS12" else "JKS"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val rel = signingConfigs.getByName("release")
            signingConfig = if (rel.storeFile != null) rel else signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        // A UI wrapper has nothing to lint-gate a release on.
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // MediaSessionCompat + MediaStyle notification (no ExoPlayer: the audio is
    // played by Spotify's own web player inside the WebView).
    implementation("androidx.media:media:1.7.0")
}
