// Every key the window answers itself, in one pure function so a test can pin the list down
// without an Electron window. Anything not listed here is handed straight to the game.
//
// F5 (and Ctrl+R, the same habit with the other hand) is deliberately the browser's reload and
// nothing more: the page is thrown away and the game starts again from the save it last wrote,
// which is the start of the current wave. Nothing of ours saves first — the user reloads *because*
// something went wrong in the fight, so saving on the way out would hand them back the very state
// they wanted rid of. Progress since the last wave is gone, exactly as it is in the browser.

/** The subset of Electron's `Input` this decision needs. */
export interface KeyPress {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}

export interface KeyContext {
  /** Whether the window is in fullscreen right now. */
  fullScreen: boolean;
  /** Whether the developer tools may be opened at all (development builds only). */
  devTools: boolean;
}

export type KeyAction = "reload" | "fullscreen-on" | "fullscreen-off" | "devtools";

export function windowKeyAction(input: KeyPress, ctx: KeyContext): KeyAction | null {
  if (input.type !== "keyDown") return null;
  const plain = !input.control && !input.alt && !input.meta;
  if (input.key === "F11" && !input.alt) return ctx.fullScreen ? "fullscreen-off" : "fullscreen-on";
  if (input.key === "Escape" && plain && ctx.fullScreen) return "fullscreen-off";
  if (input.key === "F12" && plain) return ctx.devTools ? "devtools" : null;
  if (input.key === "F5" && plain) return "reload";
  // Ctrl+R, and Ctrl+Shift+R, which the browser treats as "reload and ignore what is cached".
  // Here that distinction would only mean fetching the game's own files off this computer again,
  // so both are the same plain reload.
  if ((input.key === "r" || input.key === "R") && (input.control || input.meta) && !input.alt) return "reload";
  return null;
}
