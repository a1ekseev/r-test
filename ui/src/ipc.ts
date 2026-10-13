// The only module that talks to the Rust side.
import { invoke } from '@tauri-apps/api/core';

export interface Status {
  version: string;
  arch: string;
  os: string;
  hostname: string;
  timezone: string;
  server: boolean;
  serverUrl: string;
  incognito: boolean;
}

export interface Session {
  stored: boolean;
  pong: number;
  message: string;
  image: string;
}

export const status = () => invoke<Status>('status');
export const requestCode = (email: string) => invoke<null>('request_code', { email });
export const confirmCode = (email: string, code: string) => invoke<Session>('confirm_code', { email, code });
export const frontendReady = (problems: string[]) => invoke<null>('frontend_ready', { problems });
export const reportProblem = (detail: string) => invoke<null>('report_problem', { detail });
