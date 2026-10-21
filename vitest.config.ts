import { defineConfig } from 'vitest/config';

// Конфигурация тестов: интеграционные тесты БД используют fake-indexeddb
// (подключается напрямую в src/db/db.test.ts), поэтому setup-файл не требуется.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
