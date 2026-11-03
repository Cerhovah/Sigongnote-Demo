package com.sigongnote.app

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class PendingPhotosTest {
    @Test fun pendingScreenDoesNotWaitForEncryptionOfAnotherPhoto() {
        val root=Files.createTempDirectory("pending-photo-concurrency").toFile()
        val store=PendingPhotos(File(root,"files"),File(root,"cache"));val original=store.create().apply{writeText("photo")}
        val entered=java.util.concurrent.CountDownLatch(1);val finish=java.util.concurrent.CountDownLatch(1)
        val worker=Thread{store.preserve(original){_,_,_->entered.countDown();finish.await();false}}.apply{start()}
        val ui=java.util.concurrent.Executors.newSingleThreadExecutor()
        try{
            assertTrue(entered.await(2,java.util.concurrent.TimeUnit.SECONDS))
            ui.submit{assertEquals(listOf(original),store.pending());val another=store.create();store.cancel(another);assertFalse(another.exists())}.get(1,java.util.concurrent.TimeUnit.SECONDS)
        }finally{finish.countDown();worker.join(2000);ui.shutdownNow();root.deleteRecursively()}
    }
    @Test fun failuresCancellationAndRecreationKeepBytesUntilVerifiedCommit() {
        val root=Files.createTempDirectory("pending-photo-test").toFile()
        try {
            val dir=File(root,"files");val cache=File(root,"cache").apply{mkdirs()}
            val store=PendingPhotos(dir,cache);val original=store.create().apply{writeText("unique photo bytes")}
            assertFalse(store.preserve(original){_,_,_->false})
            runCatching{store.preserve(original){_,_,_->error("storage full")}}
            store.cancel(original);assertEquals("unique photo bytes",original.readText())
            val legacy=File(cache,"12345678-1234-1234-1234-123456789012.jpg").apply{writeText("legacy")}
            val reopened=PendingPhotos(dir,cache);assertEquals(setOf(original,legacy),reopened.pending().toSet())
            assertTrue(reopened.preserve(original){file,hash,length->assertEquals(original,file);assertEquals(18L,length);assertEquals(64,hash.length);true})
            assertFalse(original.exists());assertEquals("legacy",legacy.readText())
            val empty=store.create();store.cancel(empty);assertFalse(empty.exists())
            val changed=store.create().apply{writeText("before")}
            assertFalse(store.preserve(changed){file,_,_->file.writeText("after!");true})
            assertEquals("after!",changed.readText())
            assertNull(store.find("../outside.jpg"))
        } finally {root.deleteRecursively()}
    }
}
