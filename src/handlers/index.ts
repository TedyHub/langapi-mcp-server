/**
 * Handlers module
 *
 * Format-specific sync handlers for the sync_translations tool.
 */

export {
  parseXCStringsSource,
  getXCStringsExistingKeys,
  xcstringsHasMissingKeys,
  getXCStringsContentToSync,
  writeXCStringsTranslations,
  type XCStringsSourceData,
} from "./xcstrings-sync-handler.js";
