/**
 * Lightweight browser / device detection.
 * No external dependency — pure navigator introspection.
 */

export interface DeviceInfo {
  device_type?: string;   // desktop | mobile | tablet
  device_name?: string;   // "MacBook Pro" | "iPhone 15"
  os?: string;            // "Windows" | "macOS" | "iOS" | "Android"
  os_version?: string;
  browser?: string;       // "Chrome" | "Safari" | "Firefox"
  browser_version?: string;
}

interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number;
}

/** Best-guess device type from screen + touch support. */
function detectDeviceType(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/tablet|ipad/i.test(ua) || (navigator.maxTouchPoints > 0 && window.innerWidth > 768)) {
    return "tablet";
  }
  if (/mobi|android.*mobile/i.test(ua) || (navigator.maxTouchPoints > 0 && window.innerWidth <= 768)) {
    return "mobile";
  }
  return "desktop";
}

/** Parse a user-agent string into platform info. */
function parsePlatform(): { os: string; os_version: string } {
  if (typeof navigator === "undefined") return { os: "unknown", os_version: "" };
  const ua = navigator.userAgent;
  const platform = navigator.platform || "";

  // macOS
  if (/mac/i.test(platform) || /macintosh/i.test(ua)) {
    const m = ua.match(/Mac OS X (\d+[._]\d+)/);
    return { os: "macOS", os_version: m ? m[1].replace(/_/g, ".") : "" };
  }
  // Windows
  if (/win/i.test(platform)) {
    const m = ua.match(/Windows NT (\d+\.\d+)/);
    return { os: "Windows", os_version: m ? m[1] : "" };
  }
  // iOS
  if (/iphone|ipad|ipod/i.test(ua)) {
    const m = ua.match(/OS (\d+[._]\d+)/);
    return { os: "iOS", os_version: m ? m[1].replace(/_/g, ".") : "" };
  }
  // Android
  if (/android/i.test(ua)) {
    const m = ua.match(/Android (\d+[._]\d+)/);
    return { os: "Android", os_version: m ? m[1] : "" };
  }
  // Linux
  if (/linux/i.test(platform)) {
    return { os: "Linux", os_version: "" };
  }
  return { os: "unknown", os_version: "" };
}

/** Parse browser from user-agent. */
function parseBrowser(): { browser: string; browser_version: string } {
  if (typeof navigator === "undefined") return { browser: "unknown", browser_version: "" };
  const ua = navigator.userAgent;

  // Edge (Chromium)
  if (/edg/i.test(ua)) {
    const m = ua.match(/Edg\/(\d+\.\d+)/);
    return { browser: "Edge", browser_version: m ? m[1] : "" };
  }
  // Chrome
  if (/chrome/i.test(ua) && !/edg/i.test(ua)) {
    const m = ua.match(/Chrome\/(\d+\.\d+)/);
    return { browser: "Chrome", browser_version: m ? m[1] : "" };
  }
  // Safari
  if (/safari/i.test(ua) && !/chrome/i.test(ua)) {
    const m = ua.match(/Version\/(\d+\.\d+)/);
    return { browser: "Safari", browser_version: m ? m[1] : "" };
  }
  // Firefox
  if (/firefox/i.test(ua)) {
    const m = ua.match(/Firefox\/(\d+\.\d+)/);
    return { browser: "Firefox", browser_version: m ? m[1] : "" };
  }
  return { browser: "unknown", browser_version: "" };
}

/** Get the vendor model name when available (e.g. "MacBook Pro", "iPhone 15"). */
function detectDeviceName(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  // navigator.userAgentData (Chromium browsers)
  const uad = (navigator as any).userAgentData;
  if (uad?.platform) {
    return uad.platform;
  }
  // Safari / fallback
  const ua = navigator.userAgent;
  if (/mac/i.test(navigator.platform || "")) {
    return "Mac";
  }
  return undefined;
}

/** Collect device info to send on login. Safe to call in browser only. */
export function collectDeviceInfo(): DeviceInfo {
  if (typeof window === "undefined") return {};
  const platform = parsePlatform();
  const browser = parseBrowser();
  return {
    device_type: detectDeviceType(),
    device_name: detectDeviceName(),
    os: platform.os,
    os_version: platform.os_version,
    browser: browser.browser,
    browser_version: browser.browser_version,
  };
}
