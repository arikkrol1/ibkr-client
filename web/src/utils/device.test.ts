import { describe, expect, it } from "vitest";
import { detectDevice, parseOverride, resolveDevice } from "./device";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  androidPhone:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  ipad:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ipadosDesktopMode:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

describe("detectDevice", () => {
  it.each([
    ["iPhone", UA.iphone, "mobile"],
    ["Android phone", UA.androidPhone, "mobile"],
    ["Android tablet", UA.androidTablet, "desktop"],
    ["iPad", UA.ipad, "desktop"],
    ["iPadOS (desktop-class UA)", UA.ipadosDesktopMode, "desktop"],
    ["Mac Chrome", UA.macChrome, "desktop"],
  ])("%s → %s", (_name, userAgent, device) => {
    expect(detectDevice({ userAgent })).toBe(device);
  });

  it("treats Client Hints mobile:true as a phone even with a desktop UA", () => {
    expect(detectDevice({ userAgent: UA.macChrome, userAgentData: { mobile: true } })).toBe("mobile");
  });

  it("still trusts a phone UA when Client Hints say mobile:false (UA override, emulators)", () => {
    expect(detectDevice({ userAgent: UA.iphone, userAgentData: { mobile: false } })).toBe("mobile");
    expect(detectDevice({ userAgent: UA.iphone, userAgentData: {} })).toBe("mobile");
  });

  it("is desktop when neither signal says phone", () => {
    expect(detectDevice({ userAgent: UA.macChrome, userAgentData: { mobile: false } })).toBe("desktop");
  });
});

describe("parseOverride", () => {
  it.each([
    ["mobile", "mobile"],
    ["desktop", "desktop"],
    ["auto", "auto"],
    [null, "auto"],
    ["garbage", "auto"],
  ])("%s → %s", (raw, expected) => {
    expect(parseOverride(raw)).toBe(expected);
  });
});

describe("resolveDevice", () => {
  it("uses the detected device on auto, otherwise the override", () => {
    expect(resolveDevice("auto", "mobile")).toBe("mobile");
    expect(resolveDevice("desktop", "mobile")).toBe("desktop");
    expect(resolveDevice("mobile", "desktop")).toBe("mobile");
  });
});
