package com.sigongnote.app

import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** Private camera output survives Activity/process recreation and cache eviction. */
class PendingPhotos(private val directory: File, private val legacy: File) {
    companion object { private val lock = Any(); private val name = Regex("[a-f0-9-]{36}\\.jpg") }
    fun create(): File {
        check(directory.isDirectory || directory.mkdirs())
        return File(directory,"${UUID.randomUUID()}.jpg").apply { check(createNewFile()) }
    }
    fun find(value: String?): File? = value?.takeIf { name.matches(it) }?.let {
        File(directory,it).takeIf(File::isFile) ?: File(legacy,it).takeIf(File::isFile)
    }
    fun pending(): List<File> =
        listOf(directory,legacy).flatMap { it.listFiles()?.toList().orEmpty() }
            .filter { it.isFile && name.matches(it.name) && it.length()>0 }.sortedBy { it.name }
    fun cancel(file: File?) { if (file?.isFile == true && file.length()==0L) file.delete() }
    /** The callback confirms a durable, decryptable inbox copy of these exact bytes. */
    fun preserve(file: File, commit: (File,String,Long)->Boolean): Boolean = synchronized(lock) {
        require(file.canonicalFile.parentFile in listOf(directory.canonicalFile,legacy.canonicalFile))
        require(name.matches(file.name))
        if (!file.isFile || file.length()==0L) return false
        fun digest():String { val hash=MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input -> val buffer=ByteArray(65536); while(true) { val n=input.read(buffer); if(n<0)break;hash.update(buffer,0,n) } }
            return hash.digest().joinToString(""){"%02x".format(it)}
        }
        val length=file.length();val hash=digest()
        if (!commit(file,hash,length)) return false
        if(file.length()!=length || digest()!=hash)return false
        file.delete() // Failure is safe: retry verifies the receipt again.
        true
    }
}
