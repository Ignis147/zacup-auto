/** Единая точка импорта слоя данных. */
export { db, ZakaznikDB, checkIndexedDBAvailable, DB_SCHEMA_VERSION } from './database';
export * from './schema';
export * from './util';
export { brandsRepo, brandSettingsRepo } from './repos/brands';
export { productsRepo, type ProductInput } from './repos/products';
export { salesRepo } from './repos/sales';
export { stockRepo, isStockStale } from './repos/stock';
export { ordersRepo, type CreateDraftInput } from './repos/orders';
export { settingsRepo, backupReminderDue } from './repos/settings';
export { exportBackup, restoreBackup, validateBackup, parseBackupJson, summarizeBackup, backupFileName, type RestoreSummary } from './backup';
