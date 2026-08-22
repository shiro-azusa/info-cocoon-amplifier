// ============================================================
// gm-fetch.ts - GM_xmlhttpRequest 的 fetch 兼容封装
// 在 Tampermonkey 环境下绕过 CORS 限制，非 TM 环境降级原生 fetch
// ============================================================

import { log } from "./debug";

const TAG = "[ruozhi-filter/gm-fetch]";

/**
 * GM_xmlhttpRequest 抛出的网络错误。
 * - isConnectRefused=true 表示被脚本管理器的 @connect 白名单拦截
 * - hostname 是出错 host（不含协议/路径），供 UI 提示用
 */
export class GMFetchError extends Error {
  readonly isConnectRefused: boolean;
  readonly hostname: string;

  constructor(
    message: string,
    opts: { isConnectRefused?: boolean; hostname?: string } = {},
  ) {
    super(message);
    this.name = "GMFetchError";
    this.isConnectRefused = !!opts.isConnectRefused;
    this.hostname = opts.hostname ?? "";
  }
}

/**
 * fetch 兼容的跨域请求函数。
 *
 * - Tampermonkey 环境 → 使用 GM_xmlhttpRequest（绕过 CORS）
 * - 非 Tampermonkey 环境 → 使用 window.fetch（标准行为）
 */
export async function gmFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (typeof GM_xmlhttpRequest !== "undefined") {
    return gmFetchWithXhr(url, init);
  }

  // Fallback: 非 Tampermonkey 环境
  if (typeof unsafeWindow !== "undefined") {
    log(TAG, "GM_xmlhttpRequest 不可用，回退 unsafeWindow.fetch");
    return unsafeWindow.fetch(url, init);
  }
  return fetch(url, init);
}

/**
 * 检测错误信息是否属于"@connect 白名单拒绝"模式。
 * 覆盖 Tampermonkey / Violentmonkey / ScriptCat 常见措辞。
 */
function isConnectRefusalMessage(msg: string): boolean {
  if (!msg) return false;
  const s = msg.toLowerCase();
  return (
    s.includes("@connect") ||
    s.includes("not a part of") ||
    (s.includes("refused") && s.includes("connect"))
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function gmFetchWithXhr(url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body as string | undefined;
    const hostname = safeHostname(url);

    GM_xmlhttpRequest({
      url,
      method,
      headers,
      data: body,
      responseType: "",
      onload: (resp) => {
        const parsedHeaders = parseResponseHeaders(resp.responseHeaders);
        resolve(
          new Response(resp.responseText, {
            status: resp.status,
            statusText: resp.statusText,
            headers: parsedHeaders,
          }),
        );
      },
      onerror: (resp) => {
        // Violentmonkey 把拒绝原因放在 responseText，
        // Tampermonkey / ScriptCat 放在 error 字段。
        // 拼接后做模式匹配，兼容各家管理器。
        const combined = [resp.error, resp.responseText]
          .filter(Boolean)
          .join(" | ");
        const isRefused = isConnectRefusalMessage(combined);
        const detail = (resp.responseText || resp.error || "").slice(0, 200);
        reject(
          new GMFetchError(
            `GM_xmlhttpRequest 失败: ${resp.status} ${resp.statusText}${detail ? " - " + detail : ""}`,
            { isConnectRefused: isRefused, hostname },
          ),
        );
      },
      ontimeout: () => {
        reject(new GMFetchError("GM_xmlhttpRequest 超时", { hostname }));
      },
      timeout: 60000,
    });
  });
}

/**
 * 解析 GM_xmlhttpRequest 返回的原始响应头字符串为 Headers 对象。
 */
function parseResponseHeaders(raw: string): Headers {
  const headers = new Headers();
  if (!raw) return headers;

  const pairs = raw.split("\r\n");
  for (const pair of pairs) {
    const idx = pair.indexOf(":");
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (key && val) {
        headers.append(key, val);
      }
    }
  }
  return headers;
}
