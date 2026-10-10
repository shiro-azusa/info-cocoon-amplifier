// ============================================================
// report.ts - 举报联动: 触发原生举报弹窗 + 复制AI理由
// ============================================================

const TAG = "[ruozhi-filter]";
import { log, warn } from "./debug";
import { showToast } from "./ui";

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

/**
 * 按文本查找元素。
 * - 优先「完全相等」，找不到再退化为「包含」（B站硬核会员的菜单项是「硬核会员举报」，
 *   纯全等匹配 "举报" 永远匹配不上）
 * - 优先「叶子节点」（子元素最少的那个），避免点到把整段文字包住的外层容器
 * - deep=true 时穿透 Shadow DOM（默认），deep=false 时只搜 light DOM 一层子树
 */
function findByText(
  root: ParentNode | null,
  text: string,
  deep = true,
): Element | null {
  if (!root) return null;
  const best = {
    exact: null as Element | null,
    partial: null as Element | null,
    exactKids: Number.POSITIVE_INFINITY,
    partialKids: Number.POSITIVE_INFINITY,
  };

  const visit = (node: ParentNode, depth: number) => {
    if (depth > 20) return;
    for (const child of node.children) {
      const el = child as HTMLElement;
      const t = (el.innerText?.trim() || el.textContent?.trim() || "").trim();
      if (t) {
        const n = el.querySelectorAll("*").length;
        if (t === text) {
          if (n < best.exactKids) {
            best.exact = el;
            best.exactKids = n;
          }
        } else if (t.includes(text)) {
          if (n < best.partialKids) {
            best.partial = el;
            best.partialKids = n;
          }
        }
      }
      if (deep && (el as Element).shadowRoot) {
        visit((el as Element).shadowRoot!, depth + 1);
      }
      if (el.children.length > 0) visit(el, depth + 1);
    }
  };

  const start =
    root instanceof Element ? ((root as Element).shadowRoot ?? root) : root;
  visit(start, 0);
  return best.exact ?? best.partial;
}

function waitFor(cb: () => boolean, ms: number): Promise<boolean> {
  return new Promise((r) => {
    const s = Date.now();
    const c = () => {
      if (cb()) r(true);
      else if (Date.now() - s > ms) r(false);
      else requestAnimationFrame(c);
    };
    c();
  });
}

/** 递归深搜：同时穿透 light DOM 与 Shadow DOM */
function deepFindAllDeep(root: ParentNode, sel: string, out: Element[] = []): Element[] {
  try {
    const found = root.querySelectorAll(sel);
    for (const e of found) out.push(e);
  } catch {
    /* 某些根节点不支持 querySelectorAll 时忽略 */
  }
  for (const child of root.children) {
    const ce = child as Element;
    if (ce.shadowRoot) deepFindAllDeep(ce.shadowRoot, sel, out);
    deepFindAllDeep(ce, sel, out);
  }
  return out;
}

/**
 * 枚举所有「可能承载本条评论操作栏」的作用域，由近到远。
 * 不假设唯一路径——renderer 自身、它的 shadow、它 shadow 内每个子元素的 shadow、
 * 以及祖先链上的每一层，全部纳入候选，逐个探测。
 */
function actionBarScopes(renderer: HTMLElement): ParentNode[] {
  const out: ParentNode[] = [];
  const push = (s: ParentNode | null | undefined) => {
    if (s && !out.includes(s)) out.push(s);
  };

  push(renderer as unknown as ParentNode);
  push(renderer.shadowRoot);
  if (renderer.shadowRoot) {
    for (const c of renderer.shadowRoot.children) {
      const ce = c as HTMLElement;
      push(ce.shadowRoot);
      push(ce);
    }
  }
  for (const c of renderer.children) {
    const ce = c as HTMLElement;
    push(ce.shadowRoot);
  }

  // 祖先链上的每一层（含 shadow 宿主）作为扩展候选
  let node: Node | null = renderer;
  let guard = 0;
  while (node && guard < 12) {
    guard++;
    if (node instanceof ShadowRoot) {
      push(node);
      node = node.host;
      continue;
    }
    const el = node as Element;
    push(el.shadowRoot ?? null);
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : el.parentNode;
  }
  return out;
}

/** 在所有候选作用域里找 action-buttons，返回第一个命中 */
function findActionBar(renderer: HTMLElement): HTMLElement | null {
  const scopes = actionBarScopes(renderer);
  for (let i = 0; i < scopes.length; i++) {
    const s = scopes[i];
    let hit: Element | null = null;
    try {
      hit = s.querySelector("bili-comment-action-buttons-renderer");
    } catch {
      hit = null;
    }
    if (hit) {
      if (i > 0) {
        log(TAG, "action-buttons 命中于候选作用域 #" + i);
      }
      return hit as HTMLElement;
    }
  }
  warn(TAG, scopes.length + " 个候选作用域全部未命中 action-buttons");
  return null;
}

/** 沿祖先链（含 Shadow 宿主）收集所有「评论渲染器」候选 */
function collectRendererCandidates(el: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const isRenderer = (t: string) =>
    t === "bili-comment-renderer" ||
    t === "bili-comment-reply-renderer" ||
    t === "bili-comment-thread-renderer";
  let node: Node | null = el;
  let guard = 0;
  while (node && guard < 20) {
    guard++;
    if (node instanceof Element) {
      const t = node.tagName.toLowerCase();
      if (isRenderer(t)) out.push(node as HTMLElement);
      else if (t.includes("comment-renderer") || t.includes("comment-thread"))
        out.push(node as HTMLElement);
    }
    if (node instanceof ShadowRoot) {
      const host = node.host as HTMLElement;
      const t = host.tagName.toLowerCase();
      if (isRenderer(t)) out.push(host);
      node = host;
      continue;
    }
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : node.parentNode;
  }
  if (!out.includes(el as HTMLElement)) out.push(el as HTMLElement);
  return out;
}

/**
 * 找到真正承载这条评论操作栏的渲染器。
 * 做法：从最近到最远遍历候选，返回「其 shadowRoot 里能查到
 * bili-comment-action-buttons-renderer」的那一个。实测 #more 不在评论元素的
 * light DOM 子树里，只有 shadowRoot.querySelector 才访问得到——所以
 * 必须探测，而不是预设某一层。
 */
function findCommentRenderer(el: HTMLElement): HTMLElement {
  const candidates = collectRendererCandidates(el);
  for (const c of candidates) {
    const sr = (c as HTMLElement).shadowRoot;
    if (sr && sr.querySelector("bili-comment-action-buttons-renderer")) {
      log(TAG, "renderer 命中:", c.tagName.toLowerCase());
      return c;
    }
  }
  log(
    TAG,
    "renderer 未命中，候选链:",
    candidates.map((c) => c.tagName.toLowerCase()).join(" > "),
  );
  return candidates[0] ?? el;
}

/**
 * 找到属于这条评论的「更多」按钮。
 * 通过 actionBarScopes 枚举所有候选作用域（不再假设唯一路径）。
 */
function findMoreButton(renderer: HTMLElement): HTMLElement | null {
  const actionBar = findActionBar(renderer);
  if (!actionBar) return null;

  const pick = (scope: ParentNode): HTMLElement | null => {
    const more = scope.querySelector("#more") as HTMLElement | null;
    if (!more) return null;
    const btn =
      (more.querySelector("button") as HTMLElement | null) ??
      (more.querySelector(
        'button, [role="button"], [tabindex], [class*="btn"], [class*="button"], [class*="more"]',
      ) as HTMLElement | null);
    const target = btn ?? more;
    return target.isConnected ? target : null;
  };

  const scopes: ParentNode[] = [];
  if (actionBar.shadowRoot) scopes.push(actionBar.shadowRoot);
  scopes.push(actionBar);
  for (const s of scopes) {
    const hit = pick(s);
    if (hit) {
      log(TAG, "命中「更多」按钮");
      return hit;
    }
  }
  warn(TAG, "action-buttons 内找不到 #more");
  return null;
}

/** 判断菜单是否真的可见（比只认一个 style 字符串更可靠） */
function isMenuVisible(menu: HTMLElement | null): boolean {
  if (!menu) return false;
  const styleAttr = menu.getAttribute("style") || "";
  if (styleAttr.includes("--bili-comment-menu-display:block")) return true;
  try {
    const cs = getComputedStyle(menu);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity || "1") < 0.1) return false;
    const rect = menu.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  } catch {
    /* 忽略 */
  }
  return false;
}

export async function triggerReport(
  commentEl: Element,
  reason: string,
  onPopupOpened?: () => void,
): Promise<{ opened: boolean; reasonCopied: boolean }> {
  const reasonCopied = await copyToClipboard(reason);
  if (reasonCopied) showToast("已复制 AI 判定理由，请粘贴到举报框 (Cmd+V)");

  const renderer = findCommentRenderer(commentEl as HTMLElement);

  log(
    TAG,
    "Comment container:",
    renderer.tagName.toLowerCase(),
    "| shadowRoot:",
    !!renderer.shadowRoot,
    "| children:",
    renderer.shadowRoot?.children.length ?? 0,
  );

  const prevDisplay = renderer.style.display;
  renderer.style.display = "";
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));

  try {
    const moreBtn = findMoreButton(renderer);
    if (!moreBtn) {
      warn(TAG, "No 'More' button found");
      return { opened: false, reasonCopied };
    }

    log(TAG, "Clicking 'More'...");
    moreBtn.click();

    // 菜单限定在「本条评论的 action-buttons 作用域」里找，避免拿到别人的菜单
    let menuEl: HTMLElement | null = null;
    const ok = await waitFor(() => {
      const bar = findActionBar(renderer);
      const scope: ParentNode | null = bar ? (bar.shadowRoot ?? bar) : null;
      menuEl = scope
        ? (scope.querySelector("bili-comment-menu") as HTMLElement | null)
        : null;
      return isMenuVisible(menuEl);
    }, 2500);
    if (!ok) {
      warn(TAG, "Menu did not appear");
      return { opened: false, reasonCopied };
    }

    const reportLi = findByText(menuEl ?? null, "举报") as HTMLElement | null;
    if (!reportLi) {
      warn(TAG, "No 'Report' found in menu");
      return { opened: false, reasonCopied };
    }

    log(TAG, "Clicking 'Report'...");
    reportLi.click();
    waitAndFillReportForm(reason, onPopupOpened);
    log(TAG, "Native report triggered");
    return { opened: true, reasonCopied };
  } finally {
    renderer.style.display = prevDisplay;
  }
}

function waitAndFillReportForm(
  reason: string,
  onPopupOpened?: () => void,
): void {
  const s = Date.now();
  let n = 0;
  let popupNotified = false;
  /** 举报弹窗首次出现时通知调用方（只通知一次） */
  const notifyPopupOpened = () => {
    if (popupNotified) return;
    popupNotified = true;
    onPopupOpened?.();
  };
  const f = () => {
    n++;
    const popup = deepFindAllDeep(document.body, "bili-comments-popup")[0] as
      | HTMLElement
      | undefined;
    if (!popup) {
      if (Date.now() - s < 4000) setTimeout(f, 200);
      return;
    }
    notifyPopupOpened();
    const form = deepFindAllDeep(
      popup,
      "bili-comment-report-form",
    )[0] as HTMLElement | undefined;
    if (!form || !(form as HTMLElement).shadowRoot) {
      if (Date.now() - s < 4000) setTimeout(f, 200);
      return;
    }
    const sr = (form as HTMLElement).shadowRoot!;

    if (n <= 2) {
      // 按优先级匹配举报类型：骚扰谩骂 > 谩骂 > 骚扰 > 人身攻击 > 引战
      const categoryKeywords = ["骚扰谩骂", "谩骂", "骚扰", "人身攻击", "引战"];
      let matched = false;
      for (const kw of categoryKeywords) {
        for (const opt of sr.querySelectorAll("#option")) {
          const nameEl = opt.querySelector("#option-name");
          if (nameEl && (nameEl as HTMLElement).innerText?.includes(kw)) {
            const radio = opt.querySelector("bili-radio");
            if (radio && (radio as HTMLElement).shadowRoot) {
              const sp = (radio as HTMLElement).shadowRoot!.querySelector(
                "#input",
              ) as HTMLElement | null;
              if (sp) {
                sp.click();
                log(TAG, `Selected '${kw}' category`);
                matched = true;
                break;
              }
            }
            const inp = opt.querySelector(
              'input[type="radio"][value="4"]',
            ) as HTMLElement | null;
            if (inp) {
              inp.click();
              matched = true;
              break;
            }
          }
        }
        if (matched) break;
      }
      setTimeout(f, 300);
      return;
    }

    const ta = sr.querySelector(
      "textarea[maxlength='200']",
    ) as HTMLTextAreaElement | null;
    if (ta) {
      ta.value = reason.slice(0, 200);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      log(TAG, "Report reason auto-filled");
      return;
    }
    if (Date.now() - s < 4000) setTimeout(f, 300);
  };
  setTimeout(f, 600);
}

/** 一键举报：触发原生举报弹窗 + 自动选择"骚扰谩骂" + 填入理由 */
export async function triggerQuickReport(
  commentEl: Element,
  reason?: string,
): Promise<{ opened: boolean }> {
  const { opened } = await triggerReport(commentEl, reason ?? "骚扰谩骂");
  return { opened };
}

export async function copyReason(reason: string): Promise<boolean> {
  const ok = await copyToClipboard(reason);
  if (ok) showToast("已复制 AI 判定理由，请粘贴到举报框 (Cmd+V)");
  return ok;
}
