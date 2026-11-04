// 管理后台设备指纹来源：本地稳定的随机设备 ID（localStorage），随每个请求
// 通过 X-Device-Id 发送；服务端会与 UA / 语言组合成指纹并绑定登录会话。
// 清除浏览器存储或更换浏览器会生成新 ID，需要重新登录。

const STORAGE_KEY = "mindbase_admin_device_id";
const ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const DEVICE_ID_HEADER = "X-Device-Id";

let cached: string | null = null;

function randomDeviceId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readStoredDeviceId(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** 返回稳定的设备 ID；首次调用生成并持久化，storage 不可用时退化为进程内 ID。 */
export function getDeviceId(): string {
  if (cached) return cached;
  const stored = readStoredDeviceId();
  if (stored) {
    cached = stored;
    return stored;
  }
  const created = randomDeviceId();
  try {
    window.localStorage.setItem(STORAGE_KEY, created);
  } catch {
    // 隐私模式/禁用存储：仍使用进程内 ID（刷新后变化，服务端会要求重新登录）
  }
  cached = created;
  return created;
}
