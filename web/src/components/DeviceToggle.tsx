import { setDeviceOverride, useDevice } from "../hooks/useDevice";
import type { DeviceOverride } from "../utils/device";

const OPTIONS: { value: DeviceOverride; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "mobile", label: "Mobile" },
  { value: "desktop", label: "Desktop" },
];

/**
 * Footer switch for the layout. "Auto" follows the user agent; the other two
 * force a layout (remembered per browser).
 */
export function DeviceToggle() {
  const { override, detected } = useDevice();
  return (
    <div className="mx-auto mt-10 flex max-w-6xl items-center justify-center gap-2 text-xs text-gray-600">
      <span>Layout:</span>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => setDeviceOverride(o.value)}
          className={`rounded px-1.5 py-1 ${
            override === o.value ? "text-gray-300" : "hover:text-gray-400"
          }`}
        >
          {o.label}
          {o.value === "auto" && ` (${detected})`}
        </button>
      ))}
    </div>
  );
}
