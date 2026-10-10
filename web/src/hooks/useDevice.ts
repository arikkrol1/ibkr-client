import { useSyncExternalStore } from "react";
import {
  detectDevice,
  parseOverride,
  resolveDevice,
  type Device,
  type DeviceOverride,
} from "../utils/device";

/**
 * Current layout ("mobile" | "desktop"), mirrored on <html data-device> so
 * Tailwind's `mobile:` variant (index.css) can style it. The manual override
 * is a per-browser convenience in localStorage.
 */

const KEY = "deviceOverride";
const listeners = new Set<() => void>();

function readOverride(): DeviceOverride {
  try {
    return parseOverride(localStorage.getItem(KEY));
  } catch {
    return "auto";
  }
}

let override = readOverride();
const detected: Device = detectDevice(navigator as Navigator & { userAgentData?: { mobile?: boolean } });

function apply() {
  document.documentElement.dataset.device = resolveDevice(override, detected);
}

/** Call once before the first render, so there's no desktop→mobile flash. */
export function initDevice() {
  apply();
}

export function setDeviceOverride(next: DeviceOverride) {
  override = next;
  try {
    if (next === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked (private mode): the choice lasts for this page only.
  }
  apply();
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useDevice(): { device: Device; detected: Device; override: DeviceOverride } {
  const current = useSyncExternalStore(subscribe, () => override);
  return { device: resolveDevice(current, detected), detected, override: current };
}
