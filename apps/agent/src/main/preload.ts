import { contextBridge, ipcRenderer } from 'electron';
import type { AgentState } from '../core/types.js';

/** The only things the window may ask of the app. */
contextBridge.exposeInMainWorld('printAgent', {
  getState: (): Promise<AgentState> => ipcRenderer.invoke('agent:get-state'),
  pair: (code: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:pair', code),
  unpair: (): Promise<void> => ipcRenderer.invoke('agent:unpair'),
  onState: (listener: (state: AgentState) => void): void => {
    ipcRenderer.on('agent:state', (_event, state: AgentState) => listener(state));
  },
});
