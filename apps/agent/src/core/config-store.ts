import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SavedConfig {
  serverUrl: string;
  deviceId: string;
  /** Device token: proves to the server which shop this PC belongs to. */
  token: string;
  shopName: string;
  deviceName: string;
}

/** Protects the token at rest. Electron's safeStorage in the app; a pass-through in tests. */
export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export const plainSecretBox: SecretBox = { encrypt: (s) => s, decrypt: (s) => s };

export interface ConfigStore {
  load(): SavedConfig | null;
  save(config: SavedConfig): void;
  clear(): void;
}

/** Writes JSON atomically so a crash can never leave a half-written file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export class FileConfigStore implements ConfigStore {
  constructor(
    private readonly file: string,
    private readonly box: SecretBox = plainSecretBox,
  ) {}

  load(): SavedConfig | null {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SavedConfig>;
      if (!raw.serverUrl || !raw.deviceId || !raw.token) return null;
      return {
        serverUrl: raw.serverUrl,
        deviceId: raw.deviceId,
        token: this.box.decrypt(raw.token),
        shopName: raw.shopName ?? '',
        deviceName: raw.deviceName ?? '',
      };
    } catch {
      return null; // missing, damaged, or encrypted for another user: start unpaired
    }
  }

  save(config: SavedConfig): void {
    writeJsonAtomic(this.file, { ...config, token: this.box.encrypt(config.token) });
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}
