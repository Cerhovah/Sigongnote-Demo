package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class WorkUploadPolicyTest {
    @Test fun signedStorageUploadUsesConfiguredOriginOnly(){
        val origin="https://example.supabase.co"
        val path="/storage/v1/object/upload/sign/sigongnote-originals/tenant/item?token=signature"
        assertTrue(WorkUploadPolicy.allows(origin+path,origin,"PUT"))
        assertTrue(WorkUploadPolicy.allows(origin+path,origin,"OPTIONS"))
        assertFalse(WorkUploadPolicy.allows("https://other.supabase.co"+path,origin,"PUT"))
        assertFalse(WorkUploadPolicy.allows(origin+path,origin,"GET"))
        assertFalse(WorkUploadPolicy.allows(origin+"/auth/v1/user?token=x",origin,"PUT"))
        assertFalse(WorkUploadPolicy.allows(origin+path.substringBefore('?'),origin,"PUT"))
        assertFalse(WorkUploadPolicy.allows(origin+path.replace("sigongnote-originals","other"),origin,"PUT"))
    }
}
