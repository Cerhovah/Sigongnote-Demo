package com.sigongnote.app

object FolderStagingPolicy {
    fun capacity(stored:Long,size:Long,modified:Long,now:Long,free:Long,total:Long):String? {
        if(size<1||stored<0||size>200L*1024*1024)return "file_too_large"
        // SGN2: 75-byte envelope, 21-byte terminal, 21 bytes per data chunk.
        val sealed=size+((size+1024*1024-1)/(1024*1024))*21+96
        val reserve=maxOf(1024L*1024*1024,total/10)
        if(free<sealed+reserve)return "device_low"
        val cap=2L*1024*1024*1024
        // Leave ten percent for this week's arrivals while historical copies remain protected.
        val allowed=if(modified>=now-7L*24*60*60*1000)cap else cap*9/10
        return if(stored>allowed-sealed)"app_copy_cap" else null
    }
    fun legacyOutside(source:FolderSource,entry:FolderEntry,marker:FolderPending?):Boolean {
        if(source.historyMode!="legacy_recent")return false
        if(source.scanGeneration==0 && !FolderScanPolicy.inInitialWindow(entry,source.selectedAtEpochMs))return true
        return marker?.attempts==-1 && marker.providerSize==entry.size &&
            marker.providerModifiedAtEpochMs==entry.modifiedAtEpochMs
    }
}
