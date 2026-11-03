ALTER TABLE `capture_queue` ADD COLUMN `acknowledgedAtEpochMs` INTEGER;
UPDATE `capture_queue` SET `acknowledgedAtEpochMs` = `updatedAtEpochMs` WHERE `state` = 'acknowledged';
ALTER TABLE `folder_sources` ADD COLUMN `boundTenantId` TEXT;
ALTER TABLE `folder_sources` ADD COLUMN `boundUserId` TEXT;
ALTER TABLE `folder_sources` ADD COLUMN `boundDeviceId` TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS `index_folder_sources_serverSourceId` ON `folder_sources` (`serverSourceId`);
ALTER TABLE `folder_observations` ADD COLUMN `serverDocumentId` TEXT;
ALTER TABLE `folder_observations` ADD COLUMN `serverRevisionId` TEXT;
ALTER TABLE `folder_observations` ADD COLUMN `serverDocumentVersion` INTEGER;
