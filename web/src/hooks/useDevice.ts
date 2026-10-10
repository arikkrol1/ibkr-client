import { detectDevice } from "../utils/device";

/**
 * Picks the layout ("mobile" | "desktop") from the user agent and mirrors it
 * on <html data-device> so Tailwind's `mobile:` variant (index.css) can style
 * it. Call once before the first render, so there's no desktop→mobile flash.
 */
export function initDevice() {
  document.documentElement.dataset.device = detectDevice(
    navigator as Navigator & { userAgentData?: { mobile?: boolean } },
  );
  try {
    // Left behind by the removed Layout override switch.
    localStorage.removeItem("deviceOverride");
  } catch {
    // Storage blocked (private mode): nothing to clean up.
  }
}
