/**
 * Phone vs desktop layout, chosen from the user agent (the same dev server
 * serves both, see README → Mobile access), with a manual override.
 */

export type Device = "mobile" | "desktop";
export type DeviceOverride = "auto" | Device;

export interface NavigatorLike {
  userAgent: string;
  /** User-Agent Client Hints (Chromium); `mobile` is the browser's own verdict. */
  userAgentData?: { mobile?: boolean };
}

// Phones only. Tablets get the desktop layout: Android tablets omit "Mobile",
// and iPadOS reports a Mac UA. iPad's UA also contains "Mobile/15E148", hence
// no bare /Mobile/ match.
const PHONE_UA = /iPhone|iPod|Android.+Mobile|Windows Phone|IEMobile|BlackBerry|Opera Mini/i;

/** Mobile if either the Client Hints or the UA string says it's a phone. */
export function detectDevice(nav: NavigatorLike): Device {
  return nav.userAgentData?.mobile === true || PHONE_UA.test(nav.userAgent) ? "mobile" : "desktop";
}

export function parseOverride(raw: string | null | undefined): DeviceOverride {
  return raw === "mobile" || raw === "desktop" ? raw : "auto";
}

export function resolveDevice(override: DeviceOverride, detected: Device): Device {
  return override === "auto" ? detected : override;
}
