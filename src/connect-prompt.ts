// ============================================================
// connect-prompt.ts - 检测到 @connect 白名单拒绝时的用户提示
// ============================================================
//
// 背景：
// @connect 是 userscript 头部静态元数据，运行时无法动态添加。
// 当用户配置了自定义 provider endpoint（如 api.minimaxi.com），
// 而该域名不在 @connect 白名单时，GM_xmlhttpRequest 会被脚本管理器
// 拒绝（Violentmonkey 直接拒，Tampermonkey 在某些版本下也会拒）。
//
// 本模块提供：
// - showConnectPrompt(hostname): 右下角轻量 toast（每会话每域名一次）
// - showConnectPromptModal(hostname): 阻断式 modal（用户主动测试失败时用）
//
// 样式自包含，跨主题兼容。

const TAG = "[ruozhi-filter/connect-prompt]";

// 本会话已提示过的 hostname，避免重复打扰
const shownThisSession = new Set<string>();

// 已挂载到 DOM 的容器
let toastRoot: HTMLDivElement | null = null;
let modalRoot: HTMLDivElement | null = null;

const STYLES = `
.ruozhi-cp-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 360px;
  max-width: calc(100vw - 48px);
  background: #1f2937;
  color: #f9fafb;
  padding: 14px 38px 14px 16px;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.28);
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
  z-index: 2147483600;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.25s, transform 0.25s;
  pointer-events: auto;
}
.ruozhi-cp-toast.show {
  opacity: 1;
  transform: translateY(0);
}
.ruozhi-cp-toast .title {
  font-weight: 600;
  margin-bottom: 6px;
  font-size: 13.5px;
}
.ruozhi-cp-toast .body {
  color: #d1d5db;
  font-size: 12px;
  margin-bottom: 10px;
}
.ruozhi-cp-toast .body code {
  background: #374151;
  color: #fcd34d;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
}
.ruozhi-cp-toast .code {
  background: #111827;
  color: #fcd34d;
  padding: 6px 8px 6px 10px;
  border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  word-break: break-all;
}
.ruozhi-cp-toast .copy {
  flex: 0 0 auto;
  background: #374151;
  color: #f9fafb;
  border: none;
  padding: 4px 10px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  white-space: nowrap;
}
.ruozhi-cp-toast .copy:hover { background: #4b5563; }
.ruozhi-cp-toast .copy.copied { background: #047857; }
.ruozhi-cp-toast .link {
  color: #93c5fd;
  cursor: pointer;
  font-size: 12px;
  background: none;
  border: none;
  padding: 0;
  margin-top: 8px;
  font-family: inherit;
  text-decoration: underline dotted;
  display: inline-block;
}
.ruozhi-cp-toast .link:hover { color: #bfdbfe; }
.ruozhi-cp-toast .close {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 2px 6px;
}
.ruozhi-cp-toast .close:hover { color: #f9fafb; }

.ruozhi-cp-modal-bg {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483647;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
}
.ruozhi-cp-modal {
  background: #ffffff;
  color: #111827;
  border-radius: 10px;
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 20px 22px;
  box-shadow: 0 20px 50px rgba(0,0,0,0.3);
}
.ruozhi-cp-modal h3 {
  margin: 0 0 10px;
  font-size: 16px;
  color: #b91c1c;
}
.ruozhi-cp-modal p {
  margin: 0 0 10px;
  color: #374151;
}
.ruozhi-cp-modal p code {
  background: #f3f4f6;
  color: #1f2937;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.ruozhi-cp-modal .code {
  background: #f3f4f6;
  color: #111827;
  padding: 8px 12px;
  border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ruozhi-cp-modal .copy {
  background: #2563eb;
  color: #fff;
  border: none;
  padding: 5px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
}
.ruozhi-cp-modal .copy:hover { background: #1d4ed8; }
.ruozhi-cp-modal .copy.copied { background: #047857; }
.ruozhi-cp-modal .steps {
  background: #f9fafb;
  border-left: 3px solid #2563eb;
  padding: 10px 14px;
  margin: 14px 0 4px;
  border-radius: 0 4px 4px 0;
  font-size: 13px;
  color: #1f2937;
}
.ruozhi-cp-modal .steps ol { margin: 6px 0 0 18px; padding: 0; }
.ruozhi-cp-modal .steps li { margin: 3px 0; }
.ruozhi-cp-modal .actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
.ruozhi-cp-modal .btn {
  padding: 7px 18px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  border: 1px solid #2563eb;
  background: #2563eb;
  color: #fff;
}
.ruozhi-cp-modal .btn:hover { background: #1d4ed8; border-color: #1d4ed8; }
`;

function ensureStyles(): void {
  if (document.getElementById("ruozhi-cp-styles")) return;
  const s = document.createElement("style");
  s.id = "ruozhi-cp-styles";
  s.textContent = STYLES;
  document.head.appendChild(s);
}

function ensureToastRoot(): HTMLDivElement {
  if (!toastRoot) {
    toastRoot = document.createElement("div");
    toastRoot.id = "ruozhi-cp-toasts";
    document.body.appendChild(toastRoot);
  }
  return toastRoot;
}

function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* 静默失败 */
  }
  ta.remove();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 轻量 toast 提示。同一 hostname 在一次会话内只提示一次。
 * 失败调用方应继续按错误处理（如 fallback、计数 +1 等），不应阻断后续流程。
 */
export function showConnectPrompt(hostname: string): void {
  if (!hostname) return;
  if (shownThisSession.has(hostname)) return;
  shownThisSession.add(hostname);

  ensureStyles();
  const root = ensureToastRoot();
  const t = document.createElement("div");
  t.className = "ruozhi-cp-toast";

  const connectLine = `// @connect      ${hostname}`;

  t.innerHTML = `
    <button class="close" aria-label="关闭">×</button>
    <div class="title">需要授权新的 API 域名</div>
    <div class="body">
      请求 <code>${escapeHtml(hostname)}</code> 被脚本管理器拒绝，因为它不在脚本的 <code>@connect</code> 白名单中。
    </div>
    <div class="code">
      <span>${escapeHtml(connectLine)}</span>
      <button class="copy">复制</button>
    </div>
    <button class="link">如何修改？</button>
  `;
  root.appendChild(t);

  t.querySelector(".copy")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    copyText(connectLine);
    btn.textContent = "已复制";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "复制";
      btn.classList.remove("copied");
    }, 2000);
  });

  const close = () => removeToast(t);
  t.querySelector(".close")?.addEventListener("click", close);
  t.querySelector(".link")?.addEventListener("click", () => {
    showConnectPromptModal(hostname);
  });

  requestAnimationFrame(() => {
    t.classList.add("show");
  });

  // 20 秒自动消失
  setTimeout(close, 20000);
}

function removeToast(t: HTMLElement): void {
  t.classList.remove("show");
  setTimeout(() => t.remove(), 300);
}

/**
 * 阻断式 modal。用户主动发起（如点击"测试连接"）失败时使用。
 * 不做去重——可被 toast 中的"如何修改？"链接反复触发。
 */
export function showConnectPromptModal(hostname: string): void {
  if (!hostname) return;

  ensureStyles();

  // 关闭已有 modal，避免叠加
  modalRoot?.remove();

  const bg = document.createElement("div");
  bg.className = "ruozhi-cp-modal-bg";

  const connectLine = `// @connect      ${hostname}`;

  bg.innerHTML = `
    <div class="ruozhi-cp-modal" role="dialog" aria-modal="true">
      <h3>连接被拒绝：域名未授权</h3>
      <p>请求 <code>${escapeHtml(hostname)}</code> 被脚本管理器的 <code>@connect</code> 白名单拦截。</p>
      <p>请将下面这一行添加到脚本头部，然后保存并刷新页面：</p>
      <div class="code">
        <span>${escapeHtml(connectLine)}</span>
        <button class="copy">复制</button>
      </div>
      <div class="steps">
        <strong>修改步骤</strong>
        <ol>
          <li>打开脚本管理器面板（油猴/Violentmonkey 图标）</li>
          <li>找到本脚本，点击「编辑」</li>
          <li>在 <code>// ==UserScript==</code> 区块里粘贴上面那行</li>
          <li>保存，回到 B 站页面刷新</li>
        </ol>
      </div>
      <div class="actions">
        <button class="btn" data-act="ok">我知道了</button>
      </div>
    </div>
  `;

  bg.addEventListener("click", (e) => {
    if (e.target === bg) close();
  });
  bg.querySelector('[data-act="ok"]')?.addEventListener("click", () => close());
  bg.querySelector(".copy")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    copyText(connectLine);
    btn.textContent = "已复制";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "复制";
      btn.classList.remove("copied");
    }, 2000);
  });

  document.body.appendChild(bg);
  modalRoot = bg;

  function close(): void {
    bg.remove();
    if (modalRoot === bg) modalRoot = null;
  }
}
