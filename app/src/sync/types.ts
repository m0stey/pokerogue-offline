// Shared save-data types. Contract: DESIGN.md §3.2. Keep loose (Record) because the
// game's schema changes with every upstream release; only the fields we reason about are typed.

export interface GameStats extends Record<string, unknown> {
  playTime: number;
}

export interface SystemSave extends Record<string, unknown> {
  trainerId: number;
  secretId: number;
  gameVersion: string;
  timestamp: number;
  gameStats: GameStats;
}

export interface SessionSave extends Record<string, unknown> {
  seed: string;
  waveIndex: number;
  timestamp: number;
  gameVersion: string;
}

export const SESSION_SLOTS = 5;

export interface SaveSnapshot {
  system: SystemSave | null;
  /** Always length SESSION_SLOTS. */
  sessions: (SessionSave | null)[];
}

export interface AccountInfo extends Record<string, unknown> {
  username: string;
  lastSessionSlot: number;
  discordId?: string;
  googleId?: string;
  hasAdminRole?: boolean;
}

export type ConflictPolicy = "ask" | "prefer-this-computer" | "prefer-online";
