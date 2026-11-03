package com.sigongnote.app
import org.junit.Assert.*
import org.junit.Test
class SmsSyncPolicyTest {
    @Test fun normalPollsKeepTheHighWaterCursorAndFullReconciliationIsDaily(){
        assertTrue(SmsSyncPolicy.reconcileDue(0,1000));assertFalse(SmsSyncPolicy.reconcileDue(1000,901000))
        assertFalse(SmsSyncPolicy.reconcileDue(1000,86_400_999));assertTrue(SmsSyncPolicy.reconcileDue(1000,86_401_000))
        assertTrue(SmsSyncPolicy.reconcileDue(1000,999))
    }
    @Test fun reinstallKeepsRecordIdentityButOtherPhonesAccountsAndMessagesDoNotCollide(){
        val phone=SmsSyncPolicy.installationFingerprint("fixture-phone")
        fun key(user:String="user",device:String=phone,id:Long=1,time:Long=1000)=SmsSyncPolicy.messageKey("tenant",user,device,"mms",id,time)
        assertEquals(key(),key(device=SmsSyncPolicy.installationFingerprint("fixture-phone")))
        assertNotEquals(key(),key(user="other"));assertNotEquals(key(),key(device=SmsSyncPolicy.installationFingerprint("other-phone")))
        assertNotEquals(key(),key(id=2));assertNotEquals(key(),key(time=2000))
    }
    @Test fun everyIndependentGateIsRequired(){
        assertTrue(SmsSyncPolicy.ready(true,true,true,true,true))
        for(i in 0..4){val gate=BooleanArray(5){true};gate[i]=false;assertFalse(SmsSyncPolicy.ready(gate[0],gate[1],gate[2],gate[3],gate[4]))}
    }
    @Test fun selectedNumberDoesNotAuthorizeOtherRecipients(){
        val selected=setOf("01012340000")
        assertTrue(SmsSyncPolicy.allowedParticipants(listOf("+82 10-1234-0000"),selected))
        assertFalse(SmsSyncPolicy.allowedParticipants(listOf("01012340000","01098760000"),selected))
        assertFalse(SmsSyncPolicy.allowedParticipants(emptyList(),selected))
        assertFalse(SmsSyncPolicy.allowedParticipants(listOf("insert-address-token"),selected))
        assertFalse(SmsSyncPolicy.allowedParticipants(listOf("name1234@example.invalid"),selected))
    }
    @Test fun failedCopyNeverAdvancesCoverage(){
        assertEquals(7L,SmsSyncPolicy.checkpoint(7,101,false))
        assertEquals(101L,SmsSyncPolicy.checkpoint(7,101,true))
        assertEquals(7L,SmsSyncPolicy.checkpoint(7,2,true))
    }
    @Test fun allNewIsExplicitAndLegacyEmptyNumbersNeverExpand(){
        assertTrue(SmsSyncPolicy.readsMessage(true,listOf("unknown sender"),emptySet()))
        assertFalse(SmsSyncPolicy.readsMessage(false,listOf("01012340000"),emptySet()))
        assertFalse(SmsSyncPolicy.readsMessage(false,listOf("01099990000"),setOf("01012340000")))
    }
}
