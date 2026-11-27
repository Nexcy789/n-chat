import java.util.Properties

plugins {
    id("com.android.application")
}

/**
 * 签名证书不进仓库。要出可安装的 release 包就自己造一个，然后写进
 * android/local.properties（已在 .gitignore 里）：
 *
 *   NCHAT_KEYSTORE=D:\\keys\\my.keystore
 *   NCHAT_STORE_PASSWORD=******
 *   NCHAT_KEY_ALIAS=mykey
 *   NCHAT_KEY_PASSWORD=******
 *
 * 三条来源按顺序找：gradle 属性（-PNCHAT_KEYSTORE=…）→ local.properties → 环境变量。
 * 注意 local.properties 的键不会自动变成 gradle 属性，得自己读进来。
 * 证书缺一项就走不签名的 release 包（app-release-unsigned.apk，装不上，仅供本地验证）。
 */
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun secret(name: String): String? =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }
        ?: localProps.getProperty(name)?.takeIf { it.isNotBlank() }
        ?: System.getenv(name)?.takeIf { it.isNotBlank() }

val ksPath = secret("NCHAT_KEYSTORE")
val hasKeystore = ksPath != null && file(ksPath).exists()

android {
    namespace = "com.dsh.group"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.dsh.group"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (hasKeystore) {
            create("release") {
                storeFile = file(ksPath!!)
                storePassword = secret("NCHAT_STORE_PASSWORD") ?: ""
                keyAlias = secret("NCHAT_KEY_ALIAS") ?: ""
                keyPassword = secret("NCHAT_KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (hasKeystore) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            if (hasKeystore) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}
