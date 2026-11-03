package com.sigongnote.app

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

object MessageNotificationReadiness {
    fun ready(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return false
        return listOf("sms_messages", "mms_messages").all { id ->
            val channel = manager.getNotificationChannel(id)
            channel == null || (channel.importance != NotificationManager.IMPORTANCE_NONE &&
                (Build.VERSION.SDK_INT < 28 || channel.group == null ||
                    manager.getNotificationChannelGroup(channel.group)?.isBlocked != true))
        }
    }
}
