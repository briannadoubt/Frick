import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.serialization")
    `maven-publish`
}

// Single source of truth for the published Maven coordinate. Bumped in
// lockstep with the framework version; see CHANGELOG.md.
val frickVersion = "0.6.0"

android {
    namespace = "dev.frick.client"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
    }

    publishing {
        // Publish the `release` variant as a Maven AAR. AGP wires up the
        // sources jar automatically when `withSourcesJar()` is set.
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
        disable += "AndroidGradlePluginVersion"
        disable += "NewerVersionAvailable"
        // Advisory "a newer dependency version exists" — not a release blocker,
        // consistent with the sibling NewerVersionAvailable/AGP checks above.
        disable += "GradleDependency"
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    val ktorVersion = "3.4.3"
    val robolectricVersion = "4.16.1"
    val serializationVersion = "1.11.0"
    val okhttpVersion = "5.3.2"
    val msgpackVersion = "0.9.12"

    implementation("io.ktor:ktor-client-core:$ktorVersion")
    implementation("io.ktor:ktor-client-okhttp:$ktorVersion")
    implementation("com.squareup.okhttp3:okhttp:$okhttpVersion")
    // Encryption-at-rest for the durable session secret: EncryptedSharedPreferences
    // over an AndroidKeyStore master key (see FrickSessionSecretStore.kt).
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$serializationVersion")
    implementation("org.msgpack:msgpack-core:$msgpackVersion")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:$robolectricVersion")
    testImplementation("com.squareup.okhttp3:mockwebserver3-junit4:$okhttpVersion")
    testImplementation("com.squareup.okhttp3:mockwebserver3:$okhttpVersion")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}

tasks.withType<JavaCompile>().configureEach {
    options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror"))
}

tasks.withType<KotlinJvmCompile>().configureEach {
    compilerOptions {
        allWarningsAsErrors.set(true)
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// Maven publication. Defaults to GitHub Packages, configured via env vars
// so credentials never live in the repo:
//
//   GITHUB_REPOSITORY  — "owner/repo", supplied automatically by Actions.
//   GITHUB_ACTOR       — username, supplied automatically by Actions.
//   GITHUB_TOKEN       — token with `write:packages`, also auto-supplied.
//
// Local publishing for testing:
//   ./gradlew :frick:publishToMavenLocal
publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "dev.frick"
            artifactId = "frick-client"
            version = frickVersion

            afterEvaluate {
                from(components["release"])
            }

            pom {
                name.set("Frick Android client")
                description.set("Frick realtime framework — Kotlin client SDK")
                url.set("https://github.com/briannadoubt/Frick")
                licenses {
                    license {
                        name.set("Apache License 2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0")
                    }
                }
                developers {
                    developer {
                        id.set("briannadoubt")
                        name.set("Brianna Zamora")
                    }
                }
                scm {
                    url.set("https://github.com/briannadoubt/Frick")
                    connection.set("scm:git:https://github.com/briannadoubt/Frick.git")
                    developerConnection.set("scm:git:git@github.com:briannadoubt/Frick.git")
                }
            }
        }
    }

    repositories {
        maven {
            name = "GitHubPackages"
            val repoSlug = System.getenv("GITHUB_REPOSITORY") ?: "briannadoubt/Frick"
            url = uri("https://maven.pkg.github.com/$repoSlug")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: ""
                password = System.getenv("GITHUB_TOKEN") ?: ""
            }
        }
    }
}
