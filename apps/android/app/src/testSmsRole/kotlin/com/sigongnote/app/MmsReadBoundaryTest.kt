package com.sigongnote.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MmsReadBoundaryTest {
    @Test fun corruptRecordDoesNotCrashTheWholeInbox() {
        var unread = 0
        val records = listOf<() -> String>({ "first" }, { throw AssertionError("private payload") }, { "last" })
        val result = records.mapNotNull { read ->
            try { readMmsPdu(read) } catch (_: Exception) { unread++; null }
        }
        assertEquals(listOf("first", "last"), result)
        assertEquals(1, unread)
    }
    @Test fun unrelatedFatalErrorsAreNotReportedAsSuccessfulReads() {
        assertThrows(OutOfMemoryError::class.java) { readMmsPdu<String> { throw OutOfMemoryError() } }
    }
    @Test fun arrivalNoticeIsNotDownloadedContentAndReportsAreNotParseFailures() {
        assertEquals(MmsInboxKind.CONTENT, mmsInboxKind(128))
        assertEquals(MmsInboxKind.CONTENT, mmsInboxKind(132))
        assertEquals(MmsInboxKind.AWAITING_DOWNLOAD, mmsInboxKind(130))
        assertEquals(MmsInboxKind.REPORT, mmsInboxKind(134))
        assertEquals(MmsInboxKind.REPORT, mmsInboxKind(136))
        assertEquals(MmsInboxKind.REPORT, mmsInboxKind(999))
    }
}
