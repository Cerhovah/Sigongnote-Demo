package com.sigongnote.app

class SmsSyncGateUnavailable:Exception()
/** Local expiry/stop/permission checks on every read; fresh server checks at page/transfer boundaries. */
class SmsSyncGate(private val local:()->Unit,private val remote:()->Unit,private val elapsed:()->Long,
    private val maxAgeMs:Long=5000) {
    private var nextCheck=Long.MIN_VALUE
    init {require(maxAgeMs in 1..5000)}
    fun check(force:Boolean=false){
        local()
        if(force||elapsed()>=nextCheck){nextCheck=Long.MIN_VALUE;remote();nextCheck=elapsed()+maxAgeMs}
        local()
    }
}
