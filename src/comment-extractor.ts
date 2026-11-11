// ============================================================
// comment-extractor.ts - 从 DOM 节点提取评论信息
//
// ★ 为什么重写（v0.6.x）
//   旧实现把整条评论拍平成一串文本，再靠「第一行像人名」切分字段。
//   这条假设在下列常见情况下全部失效：
//     - 用户名含间隔号        Maxing·long     → 被当成"不是人名"
//     - 用户名以数字开头      2333xyz         → 同上
//     - 用户名只有 1 个字                     → 同上
//     - 正文是「图标 + 文字」的链接卡片       → 文字整段丢失
//   后果：用户名退化成占位名「未知用户」，而占位名又被当成身份键写进
//   黑名单，导致所有「名字没解析出来」的评论命中同一条记录被批量折叠。
//
// ★ 现在改为结构化读取，不再有任何猜测成分。
//
//   实测结构（2026-11 / B 站新版评论区），注意有两层 Shadow Host：
//     bili-comment-thread-renderer
//       └─ #shadow ─ bili-comment-renderer#comment
//            └─ #shadow ─ div#body.light
//                 ├─ div#main
//                 │   ├─ div#header ─ bili-comment-user-info [SHADOW]
//                 │   │                └─ #shadow ─ div#info ─ div#user-name[data-user-profile-id]
//                 │   └─ div#content
//                 │       ├─ i#top                ← 「置顶」徽章，不属于正文
//                 │       └─ bili-rich-text [SHADOW]
//                 │            └─ #shadow ─ style ─ p#contents   ← 正文真相在这
//                 └─ div#footer ─ bili-comment-action-buttons-renderer [SHADOW]
//
//   两个 [SHADOW] 都说明：innerText/textContent 在宿主上永远读不到内容，
//   必须再进一层 shadowRoot。
// ============================================================
import { strHash } from "./dom-utils";
import { log, warn } from "./debug";

const TAG = "[ruozhi-filter]";

/**
 * 用户名无法解析时的占位名。
 * ★ 它没有身份含义：db.ts 会拒绝拿它做黑名单的身份键，
 *   否则所有"名字没解析出来"的评论会挤到同一条记录上。
 */
export const UNKNOWN_UNAME = "未知用户";

/** 等待批处理的评论 */
export interface PendingComment {
  el: Element;
  /** 评论去重键（新版 DOM 无 data-rpid，退化为 mid + 正文的稳定 hash） */
  rpid: number;
  /** B 站 UID；0 表示没读到 */
  mid: number;
  /** 用户名；解析失败时为 UNKNOWN_UNAME */
  uname: string;
  /** 正文纯文本（不含用户名、徽章、操作按钮、CSS） */
  message: string;
  /** uname 是否真的从 DOM 读到（false = 占位名，不可用于身份判定） */
  nameResolved: boolean;
}

/**
 * 子评论容器的标签名。
 *
 * 搜索时遇到它们必须剪掉，否则从 thread 出发会抓到楼中楼的正文，
 * 从 reply 出发会抓到它的子回复。这是"作用域必须先拥有再查询"的落地。
 */
const NESTED_COMMENT_TAGS = new Set([
  "bili-comment-thread-renderer",
  "bili-comment-reply-renderer",
  "bili-comment-replies-renderer",
]);

// ── 作用域内的深度查询 ──

/**
 * 在 root **内部**查找第一个匹配 selector 的元素。
 *
 * 两条通路同时走：
 *   1. light DOM 子树（普通 children）
 *   2. 每个子元素自己的 shadowRoot
 * 遇到 NESTED_COMMENT_TAGS 里的标签直接跳过，保证「只搜这一条评论」。
 *
 * 注意：本函数只看 root 的后代，不看 root 自身，也不看 root 的 shadowRoot。
 * 需要连这两层一起看时用 findInComment。
 */
function findScoped(root: ParentNode, selector: string): Element | null {
  for (const child of Array.from(root.children)) {
    const tag = child.tagName.toLowerCase();
    if (NESTED_COMMENT_TAGS.has(tag)) continue;

    if (child.matches(selector)) return child;

    const inLight = findScoped(child, selector);
    if (inLight) return inLight;

    const sr = child.shadowRoot;
    if (sr) {
      const inShadow = findScoped(sr, selector);
      if (inShadow) return inShadow;
    }
  }
  return null;
}

/**
 * 以「这一条评论」为边界查找元素。
 *
 * 三层都要看，少任何一层都会直接抽空：
 *   1. 元素自身
 *   2. 元素的 light DOM 子树（交给 findScoped）
 *   3. **元素自己的 shadowRoot** —— thread / reply 的内容全在这里
 */
function findInComment(el: Element, selector: string): Element | null {
  if (el.matches(selector)) return el;

  const inLight = findScoped(el, selector);
  if (inLight) return inLight;

  const sr = el.shadowRoot;
  return sr ? findScoped(sr, selector) : null;
}

// ── 文本 ──

/**
 * 取元素的可见文本。
 *
 * 正常渲染时 innerText 最准：浏览器会剔除 <style>、display:none、脚本，
 * 并且正确处理「<a><img/>文字</a>」这类混合内容 —— 这正是旧版手写遍历
 * 丢掉蓝色链接文字的地方。
 *
 * 元素被折叠隐藏时规范要求 innerText 退化为 textContent，那会把 B 站
 * 会员卡片内联 <style> 里的 CSS 带出来，所以未渲染时走"克隆 + 摘样式"。
 */
function elementText(el: Element): string {
  const html = el as HTMLElement;
  const rendered = el.isConnected && html.getClientRects().length > 0;

  if (rendered) {
    const live = html.innerText?.trim() ?? "";
    if (live) return live;
  }

  const clone = el.cloneNode(true) as Element;
  clone
    .querySelectorAll("style, script, noscript, template")
    .forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/[ \t]+/g, " ").trim();
}

/** 逐个读取 shadow root 下各子元素的可见文本（ShadowRoot 本身没有 innerText） */
function shadowInnerText(sr: ShadowRoot): string {
  const parts: string[] = [];
  for (const child of Array.from(sr.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "style" || tag === "script" || tag === "noscript") continue;
    const text = elementText(child);
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

// ── 读作者 ──

interface AuthorInfo {
  uname: string;
  mid: number;
  resolved: boolean;
}

/**
 * 读用户名和 UID。
 *
 * 结构：bili-comment-user-info [SHADOW] → #shadow → div#info → div#user-name
 *         div#user-name 带 data-user-profile-id，里面是 <a href="//space.bilibili.com/UID">
 *
 * 用户名用 textContent 而不是 innerText：该元素在折叠态下可能不可渲染。
 */
function readAuthor(commentEl: Element): AuthorInfo {
  const infoEl = findInComment(commentEl, "bili-comment-user-info");
  const infoShadow = infoEl?.shadowRoot ?? null;

  let uname = "";
  let uidAttr = "";

  const nameEl = infoShadow?.querySelector("#user-name") ?? null;
  if (nameEl) {
    uname = (nameEl.textContent ?? "").trim();
    uidAttr = nameEl.getAttribute("data-user-profile-id") ?? "";
  }

  // 兜底：直接从用户主页链接取名字（避开等级/粉丝牌等徽章文本）
  if (!uname && infoShadow) {
    const link = infoShadow.querySelector('a[href*="space.bilibili.com"]');
    uname = (link?.textContent ?? "").trim();
    uidAttr = uidAttr || link?.getAttribute("data-user-profile-id") || "";
  }

  let mid = parseInt(uidAttr, 10) || 0;
  if (mid === 0) {
    const withUid = findInComment(commentEl, "[data-user-profile-id]");
    mid =
      parseInt(withUid?.getAttribute("data-user-profile-id") ?? "", 10) || 0;
  }
  if (mid === 0) {
    const link = findInComment(commentEl, 'a[href*="space.bilibili.com"]');
    const m = /space\.bilibili\.com\/(\d+)/.exec(
      link?.getAttribute("href") ?? "",
    );
    if (m) mid = parseInt(m[1], 10) || 0;
  }

  return { uname, mid, resolved: uname.length > 0 };
}

// ── 读正文 ──

/**
 * 读正文。
 *
 * 关键：正文不在 bili-rich-text 的宿主上，而在它 **自己的 shadow root**
 * 里的 p#contents（宿主 innerText 恒为 0）。也不能退回 div#content——
 * 那里混着 i#top（「置顶」徽章），会把它当成正文。
 */
function readContent(commentEl: Element): string {
  const rich = findInComment(commentEl, "bili-rich-text");
  if (rich) {
    const sr = rich.shadowRoot;
    const contents = sr?.querySelector("#contents") ?? null;

    const fromContents = contents ? elementText(contents) : "";
    if (fromContents) return fromContents;

    if (sr) {
      const fromShadow = shadowInnerText(sr);
      if (fromShadow) return fromShadow;
    }

    // 极少数布局里正文直接挂在 rich-text 的 light DOM 上
    const own = elementText(rich);
    if (own) return own;
  }

  // 结构变体：没有 bili-rich-text，但正文仍在某处的 #contents 里
  const fallback = findInComment(commentEl, "#contents");
  return fallback ? elementText(fallback) : "";
}

// ── 对外入口 ──

/** 从 DOM 节点提取评论信息 */
export function extractComment(el: Element): PendingComment | null {
  try {
    const author = readAuthor(el);
    const message = readContent(el);

    // 读不到正文 → 不是可判定的评论（骨架屏、已删除、加载中），交给下一轮扫描
    if (!message) return null;

    // rpid：新版评论 DOM 不暴露 data-rpid，退化为「mid + 正文」的稳定 hash。
    // 不含用户名，因为用户名可能解析失败变成占位名，那会让去重键抖动。
    let rpid = 0;
    const rpidStr =
      el.getAttribute("data-rpid") ??
      findInComment(el, "[data-rpid]")?.getAttribute("data-rpid");
    if (rpidStr) rpid = parseInt(rpidStr, 10) || 0;
    if (!rpid) rpid = strHash(`${author.mid}:${message.slice(0, 200)}`);

    if (!author.resolved) {
      log(
        TAG,
        `用户名未解析（mid=${author.mid}），使用占位名；正文前 20 字：${message.slice(0, 20)}`,
      );
    }

    return {
      el,
      rpid,
      mid: author.mid,
      uname: author.resolved ? author.uname : UNKNOWN_UNAME,
      message,
      nameResolved: author.resolved,
    };
  } catch (e) {
    warn(TAG, "extractComment 异常:", e);
    return null;
  }
}
