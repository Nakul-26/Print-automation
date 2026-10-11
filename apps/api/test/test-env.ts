/** Integration tests use their own database so they never touch development data. */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://print:print@localhost:5432/print_test';
