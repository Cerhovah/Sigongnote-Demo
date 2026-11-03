plugins { kotlin("jvm") version "2.2.21"; kotlin("plugin.serialization") version "2.2.21" }
dependencies { implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0") }
dependencyLocking { lockAllConfigurations(); lockMode.set(LockMode.STRICT) }
kotlin { jvmToolchain(17) }
sourceSets.main { kotlin.srcDir("../../../packages/contracts/generated/kotlin") }
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach { compilerOptions.allWarningsAsErrors.set(true) }
tasks.register<JavaExec>("wireSmoke") {
 dependsOn(tasks.testClasses)
 classpath = sourceSets.test.get().runtimeClasspath
 mainClass.set("com.sigongnote.contracts.WireSmokeKt")
 args(project.file("../../../fixtures/synthetic/contract-wire.json").absolutePath)
}
