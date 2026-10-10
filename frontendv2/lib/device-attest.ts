/**
 * Device attestation helpers — 浏览器设备证明的共享客户端逻辑。
 *
 * 流程：目标端点签发签名挑战（绑定资源 + 短时效）→ 页面用挑战计算临时指纹
 * → attest 端点换取短时效票据 → 消费端点携带票据头。
 *
 * 隐私：指纹是挑战绑定的（每次访问挑战不同 → 哈希每次不同），不构成跨站
 * 追踪标识。
 *
 * 诚实边界：算法在公开前端代码里，挡得住裸脚本与默认无头浏览器，挡不住
 * 读源码的对抗者 —— 是成本分层而非安全边界。
 */

export function isAutomationEnv(): boolean {
    return typeof navigator !== "undefined" && navigator.webdriver === true;
}

/** 挑战绑定的临时设备指纹（SHA-256 hex）。 */
export async function computeDeviceFingerprint(challenge: string): Promise<string> {
    const parts = [
        challenge,
        navigator.userAgent,
        navigator.language,
        String(navigator.hardwareConcurrency ?? 0),
        `${screen.width}x${screen.height}x${window.devicePixelRatio}`,
        Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    ];
    try {
        const canvas = document.createElement("canvas");
        canvas.width = 200;
        canvas.height = 50;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.textBaseline = "top";
            ctx.font = "14px 'Arial'";
            ctx.fillStyle = "#f60";
            ctx.fillRect(0, 0, 100, 20);
            ctx.fillStyle = "#069";
            ctx.fillText("mindbase-fp-🔑", 2, 2);
            parts.push(canvas.toDataURL());
        }
    } catch {
        // canvas 不可用（隐私模式扩展等）→ 少一路信号即可
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0001")));
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
