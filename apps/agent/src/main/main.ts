import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, Tray } from 'electron';
import { PrintAgent } from '../core/agent.js';
import { FileConfigStore, type SecretBox } from '../core/config-store.js';
import { JobLedger } from '../core/ledger.js';
import { FilePrinterLister, WindowsPrinterLister } from '../core/printers.js';
import { RecordingPrinter, SumatraPrinter } from '../core/print-ports.js';
import { AgentError, type Log } from '../core/types.js';
import { readSettings } from '../settings.js';

const settings = readSettings();
if (settings.dataDir) app.setPath('userData', settings.dataDir);

const log: Log = {
  info: (m, x) => console.log(`[agent] ${m}`, x ?? ''),
  warn: (m, x) => console.warn(`[agent] ${m}`, x ?? ''),
  error: (m, x) => console.error(`[agent] ${m}`, x ?? ''),
};

/** The device token is encrypted with the Windows account (DPAPI) when the OS offers it. */
const secretBox: SecretBox = {
  encrypt: (plain) =>
    safeStorage.isEncryptionAvailable()
      ? `enc:${safeStorage.encryptString(plain).toString('base64')}`
      : plain,
  decrypt: (stored) =>
    stored.startsWith('enc:')
      ? safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      : stored,
};

function sumatraPath(): string {
  const packaged = join(process.resourcesPath, 'sumatra', 'SumatraPDF.exe');
  return app.isPackaged ? packaged : join(__dirname, '..', 'vendor', 'sumatra', 'SumatraPDF.exe');
}

let agent: PrintAgent;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function showWindow(): void {
  if (!win) return;
  win.show();
  win.focus();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 380,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'Print Platform printing app',
    icon: join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  void win.loadFile(join(__dirname, 'ui', 'index.html'));
  // Closing the window keeps the app running in the tray, ready to print.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
  });
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Print Platform printing app');
  const menu = (): Menu =>
    Menu.buildFromTemplate([
      { label: 'Open', click: showWindow },
      {
        label: 'Start when Windows starts',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) =>
          app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
  agent.on('state', (state) => {
    tray?.setToolTip(
      state.phase === 'online'
        ? `Printing connected to ${state.shopName ?? 'your shop'}`
        : state.phase === 'unpaired'
          ? 'Not linked to a shop yet'
          : 'Printing app is reconnecting…',
    );
  });
}

function setupAutoUpdate(): void {
  // Store installs are updated by the Store; only the manual installer updates itself.
  if (!app.isPackaged || process.windowsStore || !settings.updateUrl) return;
  void import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.setFeedURL({ provider: 'generic', url: settings.updateUrl! });
      const check = (): void => void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
      check();
      setInterval(check, 6 * 3_600_000).unref();
    })
    .catch((err: unknown) => log.warn('updates unavailable', { err: String(err) }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  void app.whenReady().then(() => {
    const userData = app.getPath('userData');
    agent = new PrintAgent({
      store: new FileConfigStore(join(userData, 'config.json'), secretBox),
      ledger: new JobLedger(join(userData, 'jobs.json')),
      lister: settings.fakePrintersFile
        ? new FilePrinterLister(settings.fakePrintersFile)
        : new WindowsPrinterLister(),
      printer: settings.recordDir
        ? new RecordingPrinter(settings.recordDir)
        : new SumatraPrinter(sumatraPath()),
      log,
      version: app.getVersion(),
      deviceName: hostname(),
      defaultServerUrl: settings.serverUrl,
      tempDir: join(userData, 'tmp'),
    });

    ipcMain.handle('agent:get-state', () => agent.state);
    ipcMain.handle('agent:pair', async (_event, code: unknown) => {
      try {
        await agent.pair(String(code));
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof AgentError ? err.message : 'Could not link this PC. Try again.',
        };
      }
    });
    ipcMain.handle('agent:unpair', () => agent.unpair());

    createWindow();
    createTray();
    agent.on('state', (state) => {
      win?.webContents.send('agent:state', state);
      // A PC that lost its shop needs the owner's attention.
      if (state.phase === 'unpaired') showWindow();
    });
    agent.start();

    // Start quietly in the tray when launched at login and already linked to a shop.
    const hidden = process.argv.includes('--hidden') && agent.state.phase !== 'unpaired';
    win?.once('ready-to-show', () => {
      if (!hidden) showWindow();
    });

    if (app.isPackaged && !existsSync(sumatraPath())) {
      log.error('SumatraPDF is missing from the installation');
    }
    setupAutoUpdate();
  });

  app.on('before-quit', () => {
    quitting = true;
    agent?.stop();
  });
  // Stay alive in the tray when every window is closed.
  app.on('window-all-closed', () => undefined);
}
