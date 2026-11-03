import java.util.Base64

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.kapt)
}

android {
    namespace = "com.sigongnote.app"
    compileSdk = 36
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "com.sigongnote.app"
        // Synthetic device tests must never replace the user's installed app or its queue.
        if (providers.gradleProperty("ISOLATED_DEVICE_TEST").orNull == "true")
            applicationId = "com.sigongnote.app.devtest"
        // The isolated test app sits next to the owner's real app; a different name keeps them apart on the phone.
        manifestPlaceholders["appLabel"] = if (providers.gradleProperty("ISOLATED_DEVICE_TEST").orNull == "true") "시공노트 새화면(시험)" else "시공노트"
        minSdk = 26
        targetSdk = 36
        versionCode = providers.gradleProperty("APP_VERSION_CODE").orNull?.toInt()?.also { require(it>0) } ?: 1
        versionName = providers.gradleProperty("APP_VERSION_NAME").orNull?.also { require(it.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.]+)?"))) } ?: "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        for (name in listOf("CLOUD_API_ORIGIN","CLOUD_AUTH_ORIGIN","CLOUD_PUBLISHABLE_KEY","CLOUD_LOGIN_PROVIDERS")) {
            val value = providers.gradleProperty(name).orNull.orEmpty()
            require(value.none { it == '"' || it == '\\' || it.isISOControl() })
            if (name == "CLOUD_LOGIN_PROVIDERS") require(value.split(',').map {it.trim()}.filter {it.isNotEmpty()}.all {it in setOf("google","custom:naver","custom:kakao")}) {"Unsupported login provider"}
            if (name == "CLOUD_PUBLISHABLE_KEY") {
                require(!value.startsWith("sb_secret_")) { "Only a public client key is allowed" }
                if (value.startsWith("ey") || value.contains('.')) {
                    val parts = value.split('.')
                    require(parts.size == 3) { "Invalid public client key" }
                    val payload = groovy.json.JsonSlurper().parseText(
                        String(Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8)) as Map<*, *>
                    require(payload["role"] == "anon") { "Only an anon JWT is allowed in client builds" }
                }
            }
            buildConfigField("String",name,"\"$value\"")
        }
    }
    flavorDimensions += "capture"
    productFlavors {
        create("standard") { dimension = "capture" }
        create("smsSync") {
            dimension = "capture"; applicationIdSuffix = ".smssync"
            manifestPlaceholders["appLabel"] = if(providers.gradleProperty("ISOLATED_DEVICE_TEST").orNull == "true") "시공노트 문자(시험)" else "시공노트 문자연결(승인필요)"
        }
        create("smsRole") {
            dimension = "capture"
            applicationIdSuffix = ".smsrole"
        }
    }
    sourceSets.getByName("androidTest").assets.srcDir("$projectDir/schemas")
    sourceSets.getByName("main").assets.srcDir("$rootDir/../../.work/native-assets")
    buildTypes { release { isMinifyEnabled = false } }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// SMS-role remains a debug test build until carrier MMS and Play review are verified.
androidComponents {
    beforeVariants(selector().withBuildType("release")) { variant ->
        if (providers.gradleProperty("ISOLATED_DEVICE_TEST").orNull == "true")
            variant.enable = false
        if (variant.productFlavors.any { it.first == "capture" && (it.second == "smsRole" ||
            (it.second == "smsSync" && providers.gradleProperty("PRIVATE_SMS_PILOT").orNull != "true")) })
            variant.enable = false
    }
}

kotlin { jvmToolchain(17) }
val buildSharedWorkUi by tasks.registering(Exec::class) {
    workingDir("$rootDir/../..")
    commandLine("node","scripts/build-native-work-ui.mjs")
}
tasks.named("preBuild").configure { dependsOn(buildSharedWorkUi) }
kapt { arguments { arg("room.schemaLocation", "$projectDir/schemas") } }

dependencies {
    implementation(project(":contracts"))
    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("androidx.work:work-runtime:2.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    add("smsRoleImplementation","com.klinkerapps:android-smsmms:5.2.6") {
        exclude(group = "com.squareup.okhttp")
    }
    kapt("androidx.room:room-compiler:2.8.5")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

dependencyLocking { lockAllConfigurations(); lockMode.set(LockMode.STRICT) }
tasks.withType<Test>().configureEach { maxHeapSize = "128m" }
