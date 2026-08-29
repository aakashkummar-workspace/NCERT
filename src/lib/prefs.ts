/**
 * Local, non-critical preferences.
 *
 * A student is only ever in one class, so asking on every launch is noise. The
 * stored value is a *display* preference and nothing more: every /class/9/… and
 * /class/10/… route stays prerendered and reachable regardless of what is here.
 *
 * Every access is wrapped, because `localStorage` is not merely empty in some
 * private-window and locked-down-WebView configurations — the property access
 * itself throws a SecurityError. Losing the preference is fine; crashing the
 * home screen is not.
 */

/** Kept local rather than imported from the manifest so this module stays tiny. */
export type ClassPref = 9 | 10;

const CLASS_KEY = "ncert:class";

export function getClass(): ClassPref | null {
  try {
    const raw = window.localStorage.getItem(CLASS_KEY);
    const n = Number(raw);
    return n === 9 || n === 10 ? n : null;
  } catch {
    return null;
  }
}

export function setClass(cls: ClassPref): void {
  try {
    window.localStorage.setItem(CLASS_KEY, String(cls));
  } catch {
    // Storage is unavailable; the choice simply will not survive a reload.
  }
}
