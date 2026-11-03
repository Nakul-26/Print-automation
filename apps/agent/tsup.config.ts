import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Electron's main process, the window's bridge, and the headless command-line runner.
    entry: { main: 'src/main/main.ts', preload: 'src/main/preload.ts', cli: 'src/cli.ts' },
    format: ['cjs'],
    target: 'node22',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    external: ['electron', 'electron-updater'],
    noExternal: [/^@print\//, 'socket.io-client', 'zod'],
    outExtension: () => ({ js: '.cjs' }),
    // The server the shop PC talks to is built into the installer, so nobody has to type it.
    // Set PRINT_SERVER_URL when building a release; the default is the production site.
    define: {
      __DEFAULT_SERVER__: JSON.stringify(
        process.env['PRINT_SERVER_URL'] ?? 'https://print.fortifyhub.net',
      ),
      __UPDATE_URL__: JSON.stringify(process.env['UPDATE_URL'] ?? ''),
    },
    async onSuccess() {
      mkdirSync('dist/ui', { recursive: true });
      for (const file of ['index.html', 'app.js', 'style.css']) {
        copyFileSync(`src/ui/${file}`, `dist/ui/${file}`);
      }
    },
  },
]);
