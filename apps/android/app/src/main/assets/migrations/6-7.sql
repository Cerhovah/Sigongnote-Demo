ALTER TABLE `notification_scopes` ADD COLUMN `tenantId` TEXT;
ALTER TABLE `notification_scopes` ADD COLUMN `userId` TEXT;
ALTER TABLE `notification_scopes` ADD COLUMN `deviceId` TEXT;
ALTER TABLE `notification_snapshots` ADD COLUMN `tenantId` TEXT;
ALTER TABLE `notification_snapshots` ADD COLUMN `userId` TEXT;
ALTER TABLE `notification_snapshots` ADD COLUMN `deviceId` TEXT;
