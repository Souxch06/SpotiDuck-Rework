// SpotiDuck — projet Android (wrapper WebView + couche d'interface injectée).
// Un seul module `:app` ; aucune dépendance propriétaire, tout est public.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "SpotiDuck"
include(":app")
