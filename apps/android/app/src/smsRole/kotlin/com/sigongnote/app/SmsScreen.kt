package com.sigongnote.app

/** Screen navigation has no authority to send or approve records. */
enum class SmsScreen {
    INBOX, THREAD, COMPOSE, SETTINGS, BUSINESS, HELP;
    companion object {
        fun back(screen: SmsScreen, hasConversation: Boolean): SmsScreen = when(screen) {
            COMPOSE -> if(hasConversation) THREAD else INBOX
            BUSINESS, HELP -> SETTINGS
            else -> INBOX
        }
    }
}
