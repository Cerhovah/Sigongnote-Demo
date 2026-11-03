package com.sigongnote.app
import org.junit.Assert.*
import org.junit.Test
class SmsSyncGateTest {
    @Test fun localChecksStayImmediateAndNetworkCallsAreBounded(){
        var now=0L;var local=0;var remote=0;var allowed=true;var available=true
        val gate=SmsSyncGate({local++;if(!allowed)throw SecurityException()}, {remote++;if(!available)throw SmsSyncGateUnavailable()}, {now})
        repeat(1000){gate.check()};assertEquals(1,remote);assertEquals(2000,local)
        now=5000;gate.check();assertEquals(2,remote)
        gate.check(true);assertEquals(3,remote)
        allowed=false;try{gate.check();fail()}catch(_:SecurityException){};assertEquals(3,remote)
        allowed=true;available=false;try{gate.check(true);fail()}catch(_:SmsSyncGateUnavailable){}
        available=true;gate.check();assertEquals(5,remote)
    }
    @Test fun serverRevokeAndExpiryStopBeforeTheNextReadAndUnavailableIsRetryable(){
        var now=0L;var revoked=false;var reads=0;val expiry=4000L
        val gate=SmsSyncGate({if(now>=expiry)throw SecurityException()}, {if(revoked)throw SecurityException()}, {now})
        gate.check(true);reads++
        revoked=true;try{gate.check(true);reads++;fail()}catch(_:SecurityException){}
        assertEquals(1,reads);revoked=false;now=expiry
        try{gate.check();reads++;fail()}catch(_:SecurityException){};assertEquals(1,reads)
    }
}
