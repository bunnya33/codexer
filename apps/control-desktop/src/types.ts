export type SetupState = { url: string; version: string; error: string };
export type ConnectionResult = { ok: boolean; error?: string };
export type WindowState = { maximized: boolean; focused: boolean };
export type WindowApi = {
  state(): Promise<WindowState>;
  subscribe(callback: (state: WindowState) => void): () => void;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  menu(): Promise<void>;
};
export type ControlSetupApi = {
  state(): Promise<SetupState>;
  connect(url: string): Promise<ConnectionResult>;
};

declare global {
  interface Window {
    controlSetup: ControlSetupApi;
    relayDesk: WindowApi;
  }
}
