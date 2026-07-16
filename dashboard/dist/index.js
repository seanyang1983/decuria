/*
 * Decuria dashboard — Part 1 (functional).
 * Omnilimb-matched design (.dc-* classes). IIFE using window.__HERMES_PLUGIN_SDK__.
 *
 * Real wiring (no mock data):
 *   - Channels + global model loaded from GET /api/plugins/decuria/channels
 *   - Model/provider universe loaded from GET /api/plugins/decuria/model-universe (cached, lightweight)
 *   - Channel + global saves POST to /channels and /global/model (writes config.yaml)
 *   - Visibility: provider-grouped toggles, POST /visibility immediately (no restart)
 *   - Providers: enabled/disabled state (plugin file) + add/remove in config.yaml
 */
(function () {
  "use strict";

  // ── 智囊团会话跨挂载缓存（切回标签页时先秒显缓存再后台刷新，避免空白闪烁）──
  var _moaChatsCache = {};     // preset -> { sessions, details }
  var _moaChatsLoading = {};   // preset -> Promise（并发去重，避免同一预设重复抓取）

  function boot() {
    // ── 注入按提供商代理开关的 CSS ──
    (function () {
      var css = ".dc-vis-group-header{display:flex;align-items:center;gap:.35rem}.dc-vis-group-header-main{display:flex;align-items:center;min-width:0;background:none;border:none;cursor:pointer;padding:0;color:inherit;font:inherit;text-align:left}.dc-vis-group-count{margin-left:auto;flex-shrink:0}.dc-proxy-switch{cursor:pointer;display:inline-flex;align-items:center;gap:.25rem;user-select:none;flex-shrink:0;font-size:.7rem;color:var(--color-muted-foreground);transition:color .15s;margin-left:30px}.dc-proxy-switch:hover{color:var(--color-foreground)}.dc-proxy-switch-on{color:var(--dc-accent,#67e8f9)}.dc-proxy-switch input{position:absolute;opacity:0;pointer-events:none;width:0;height:0}.dc-proxy-switch-track{display:inline-block;position:relative;width:28px;height:16px;border-radius:8px;background:var(--color-muted-foreground,#ffe6cb);background:color-mix(in srgb,currentColor 20%,transparent);transition:background .2s;vertical-align:middle;flex-shrink:0}.dc-proxy-switch-on .dc-proxy-switch-track{background:var(--dc-accent,#67e8f9)}.dc-proxy-switch-thumb{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 0 2px rgba(0,0,0,.3);transition:transform .2s}.dc-proxy-switch-on .dc-proxy-switch-thumb{transform:translateX(12px)}.dc-vis-proxy-btn{font-size:.75rem;padding:.18rem .5rem;border-radius:6px}.dc-chat-src-tag{display:inline-flex;align-items:center;gap:.2rem;font-size:.65rem;color:#fbbf24;background:rgba(251,191,36,.12);padding:.1rem .4rem;border-radius:4px;margin-left:.4rem;white-space:nowrap;flex-shrink:0}.dc-chat-src-badge{display:inline-flex;align-items:center;gap:.2rem;font-size:.6rem;color:#67e8f9;background:rgba(103,232,249,.12);padding:.08rem .35rem;border-radius:4px;margin-left:auto;white-space:nowrap;flex-shrink:0}.dc-moa-src-section{margin-top:.6rem;padding-top:.6rem;border-top:1px solid rgba(255,255,255,.06)}.dc-moa-src-title{font-size:.72rem;color:var(--color-muted-foreground);margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.05em}.dc-moa-src-row{display:flex;align-items:center;gap:.4rem;padding:.2rem 0}.dc-moa-src-name{font-size:.75rem;white-space:nowrap;width:70px;flex-shrink:0}.dc-moa-src-count{font-size:.7rem;color:var(--color-muted-foreground);width:50px;flex-shrink:0;text-align:right}.dc-moa-bar-track-sm{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.06)}.dc-moa-orchestrator{max-height:480px}.dc-moa-roundtable-v{min-height:280px}.dc-moa-drag-hint{margin-top:.3rem}.dc-vis-group-header-main{gap:.8rem}.dc-bar-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;flex-shrink:0;background:none;font-size:.75rem}.dc-brand-wrap{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;color:#fff;overflow:hidden}.dc-brand-wrap svg{display:block;margin:auto;width:18px;height:18px;flex-shrink:0}.dc-bar-icon svg{width:18px;height:18px}.dc-bar-icon{font-size:13px}.dc-prov-ico{width:18px!important;height:18px!important}.dc-moa-icon-bg{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#fff}.dc-moa-icon-bg .dc-prov-ico{filter:none!important;width:20px;height:20px}";
      try { var s = document.createElement("style"); s.textContent = css; (document.head || document.documentElement).appendChild(s); } catch(e) {}
    })();

    var SDK = window.__HERMES_PLUGIN_SDK__;
    var REG = window.__HERMES_PLUGINS__;

    // ── 独立模式（无 Hermes Dashboard SDK）→ 用全局 Preact 回退 ──
    if ((!SDK || !SDK.React || !REG) && window.preact && document.getElementById("decuria-root") && !window.__hermes_boot_standalone && window.__hermes_standalone_ready) {
      window.__hermes_boot_standalone = true;
      var _P = window.preact;
      window.__tmp_react = { createElement: _P.h };
      window.__tmp_hooks = _P.hooks;
      window.__tmp_components = {};
      window.__tmp_fetchJSON = function(url, opts) { return fetch(url, opts).then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); };
      SDK = window.__HERMES_PLUGIN_SDK__ = { React: window.__tmp_react, hooks: window.__tmp_hooks, fetchJSON: window.__tmp_fetchJSON, components: {} };
      REG = window.__HERMES_PLUGINS__ = { register: function(){} };
    }

    // ── 独立模式：自愈认证 + 配色跟随主页面 ──
    // token 优先从 URL hash(#tk=) 取（按钮快速路径），缺失则回退同域隐藏 iframe 读 /decuria；
    // 主题变量始终从同域 iframe 读主页面的全部 CSS 变量并应用到本页，保证配色与 /decuria 完全一致。
    // ── 独立模式：从同域 iframe 提取主页面实际渲染色值 + token ──
    // 仪表盘不用 CSS 自定义属性(--*)，而是直接用 OKLCH/sRGB 色值。
    // 所以不读 --* 变量，而是从 iframe 里实际 DOM 元素的 computedStyle 提取
    // 真实 color / backgroundColor，然后用这些值在本页定义 CSS 变量供 style.css 使用。
    function _loadDashboardContext() {
      return new Promise(function (resolve) {
        try {
          // ── 快速路径：插件通常作为仪表盘弹窗/子框架运行，
          //    直接同源读取父窗口(或 opener)的 token 与主页面配色 —— 零成本、即时返回，
          //    彻底消除原先每次启动都新建 iframe 导航到 /decuria（最长 8 秒）的卡顿。 ──
          var ref = (window.parent && window.parent !== window) ? window.parent
                  : (window.opener && window.opener !== window ? window.opener : null);
          var token = "";
          var theme = null;
          try {
            token = (ref && ref.__HERMES_SESSION_TOKEN__) || window.__HERMES_SESSION_TOKEN__ || "";
            var pdoc = (ref && ref.document) ? ref.document : document;
            if (pdoc && pdoc.body) {
              function _c(el) { if (!el) return null; var s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor, border: s.borderColor }; }
              theme = {
                foreground: _c(pdoc.body).color,
                background: _c(pdoc.body).bg,
                card: (pdoc.querySelector('.dc-moa-copy-panel') ? _c(pdoc.querySelector('.dc-moa-copy-panel')).bg : _c(pdoc.body).bg),
                btn: (pdoc.querySelector('.dc-btn') ? _c(pdoc.querySelector('.dc-btn')) : null),
                input: (pdoc.querySelector('.dc-moa-copy-select, textarea, input') ? _c(pdoc.querySelector('.dc-moa-copy-select, textarea, input')) : null),
                border: (pdoc.querySelector('.dc-moa-copy-panel') ? getComputedStyle(pdoc.querySelector('.dc-moa-copy-panel')).borderTopColor : 'rgba(255,255,255,0.12)'),
              };
            }
          } catch (e) { /* 跨域或父窗口未就绪，走下方 iframe 兜底 */ }

          if (token && theme) { resolve({ token: token, theme: theme }); return; }

          // ── iframe 兜底（仅当父窗口/opener 取不到时才用，例如完全独立的静态打开）──
          var ifr = document.createElement("iframe");
          ifr.setAttribute("aria-hidden", "true");
          ifr.style.cssText = "position:absolute;width:0;height:0;left:-9999px;top:-9999px;border:0;";
          ifr.src = "/decuria";
          function _cleanup() {
            // 用完即销毁隐藏 iframe，避免常驻独立 document/window 造成内存泄漏
            try {
              ifr.onload = null;
              ifr.onerror = null;
              ifr.src = "about:blank";
              if (ifr.parentNode) ifr.parentNode.removeChild(ifr);
            } catch (e) {}
          }
          ifr.onload = function () {
            try {
              var cw = ifr.contentWindow, cd = ifr.contentDocument;
              var token2 = (cw && cw.__HERMES_SESSION_TOKEN__) || "";
              var theme2 = null;
              if (cd && cd.body) {
                // 从 iframe 实际 DOM 元素提取 computed 色值
                function _c2(el) { if (!el) return null; var s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor, border: s.borderColor }; }
                theme2 = {
                  foreground: _c2(cd.body).color,
                  background: _c2(cd.body).bg,
                  card: (cd.querySelector('.dc-moa-copy-panel') ? _c2(cd.querySelector('.dc-moa-copy-panel')).bg : _c2(cd.body).bg),
                  btn: (cd.querySelector('.dc-btn') ? _c2(cd.querySelector('.dc-btn')) : null),
                  input: (cd.querySelector('.dc-moa-copy-select, textarea, input') ? _c2(cd.querySelector('.dc-moa-copy-select, textarea, input')) : null),
                  border: (cd.querySelector('.dc-moa-copy-panel') ? getComputedStyle(cd.querySelector('.dc-moa-copy-panel')).borderTopColor : 'rgba(255,255,255,0.12)'),
                };
              }
              resolve({ token: token2, theme: theme2 });
            } catch (e) { resolve({ token: "", theme: null }); }
            finally { _cleanup(); }
          };
          ifr.onerror = function () { resolve({ token: "", theme: null }); _cleanup(); };
          document.body.appendChild(ifr);
          setTimeout(function () { resolve({ token: "", theme: null }); _cleanup(); }, 8000);
        } catch (e) { resolve({ token: "", theme: null }); }
      });
    }
    function _applyTheme(theme) {
      var de = document.documentElement;
      if (!theme) {
        // 无 iframe 数据 → 用已知的安全默认（深青底+奶油字）
        de.style.setProperty('--color-foreground', '#ffe6cb');
        de.style.setProperty('--color-background', '#041c1c');
        de.style.setProperty('--color-card', 'color-mix(in srgb, #ffe6cb 4%, #041c1c)');
        de.style.setProperty('--color-border', 'rgba(255,230,203,0.12)');
        de.style.setProperty('--color-muted-foreground', '#ffe6cb');
        de.style.setProperty('--color-primary', '#67e8f9');
        de.style.setProperty('--dc-accent', '#67e8f9');
        de.style.setProperty('--dc-accent-2', '#c084fc');
        de.style.setProperty('--background-base', '#041c1c');
        de.style.setProperty('--midground-base', '#ffe6cb');
        return;
      }
      // 用 iframe 提取的真实色值定义变量
      de.style.setProperty('--color-foreground', theme.foreground || '#ffe6cb');
      de.style.setProperty('--color-background', theme.background || '#041c1c');
      de.style.setProperty('--color-card', theme.card || theme.background || '#041c1c');
      de.style.setProperty('--color-border', theme.border || 'rgba(255,230,203,0.12)');
      // 次要文字/ghost 按钮：与前景色一致（暗色主题下不需降透明度）
      de.style.setProperty('--color-muted-foreground', theme.foreground || '#ffe6cb');
      de.style.setProperty('--color-primary', '#67e8f9');
      de.style.setProperty('--dc-accent', '#67e8f9');
      de.style.setProperty('--dc-accent-2', '#c084fc');
      de.style.setProperty('--background-base', theme.background || '#041c1c');
      de.style.setProperty('--midground-base', theme.foreground || '#ffe6cb');
    }

    if ((!SDK || !SDK.React || !REG) || window.__hermes_boot_standalone) {
      // Standalone auth accepts fragment-only tokens. Query-string tokens are
      // intentionally rejected because they leak into server/proxy logs.
      var _tk = window.__HERMES_SESSION_TOKEN__ || "";
      if (!_tk) {
        var _m = /(?:^#|[&#])tk=([^&]+)/.exec(location.hash || "");
        if (_m) { _tk = decodeURIComponent(_m[1]); window.__HERMES_SESSION_TOKEN__ = _tk; }
      }
      if (_tk && /(?:^#|[&#])tk=/.test(location.hash || "")) {
        try {
          var _cleanHash = (location.hash || "").replace(/(?:^#|[&#])tk=[^&]+/g, "").replace(/^&/, "#");
          history.replaceState(null, "", location.pathname + location.search + _cleanHash);
        } catch (e) {}
      }
      var _needCtx = (!window.__HERMES_SESSION_TOKEN__ || !window.__hermes_theme_applied) && !window.__hermes_auth_loading;
      if (_needCtx) {
        window.__hermes_auth_loading = true;
        _loadDashboardContext().then(function (res) {
          if (res.token && !window.__HERMES_SESSION_TOKEN__) window.__HERMES_SESSION_TOKEN__ = res.token;
          if (res.theme) { _applyTheme(res.theme); }
          window.__hermes_theme_applied = true;
          boot();
        }).catch(function () { window.__hermes_theme_applied = true; boot(); });
        setTimeout(boot, 60); return;
      }
      if (!window.__HERMES_SESSION_TOKEN__ || !window.__hermes_theme_applied) { setTimeout(boot, 60); return; }
      // token + 主题就绪 → 注入认证头
      var _tk2 = window.__HERMES_SESSION_TOKEN__;
      if (_tk2 && !window.__hermes_fetch_patched) {
        window.__hermes_fetch_patched = true;
        var _origFetch = window.fetch.bind(window);
        window.fetch = function (url, opts) {
          var rawUrl = typeof url === "string" ? url : (url && url.url) || "";
          var resolved;
          try { resolved = new URL(rawUrl, location.href); } catch (e) { resolved = null; }
          if (resolved && resolved.origin === location.origin && resolved.pathname.indexOf("/api/") === 0) {
            opts = opts || {};
            var sourceHeaders = opts.headers || (typeof Request !== "undefined" && url instanceof Request ? url.headers : undefined);
            var hdrs = new Headers(sourceHeaders || {});
            hdrs.set("X-Hermes-Session-Token", _tk2);
            opts.headers = hdrs;
          }
          return _origFetch(url, opts);
        };
      }
    }

    if (!SDK || !SDK.React || !REG) { setTimeout(boot, 60); return; }

    var React = SDK.React;
    var h = React.createElement;
    var useState = SDK.hooks.useState;
    var useEffect = SDK.hooks.useEffect;
    var C = SDK.components || {};
    var fetchJSON = SDK.fetchJSON;
    var API = "/api/plugins/decuria";

    // ---- Provider default base URLs (from Hermes provider registry + auth.py) --
    var PROVIDER_DEFAULT_BASE_URLS = {
      "openai": "https://api.openai.com/v1",
      "openai-api": "https://api.openai.com/v1",
      "openai-codex": "https://chatgpt.com/backend-api/codex",
      "anthropic": "https://api.anthropic.com",
      "openrouter": "https://openrouter.ai/api/v1",
      "deepseek": "https://api.deepseek.com/v1",
      "siliconflow": "https://api.siliconflow.cn/v1",
      "freellm": "https://api.siliconflow.cn/v1",
      "google": "https://generativelanguage.googleapis.com/v1beta/openai",
      "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
      "vertex": "https://generativelanguage.googleapis.com/v1beta/openai",
      "groq": "https://api.groq.com/openai/v1",
      "together": "https://api.together.xyz/v1",
      "mistral": "https://api.mistral.ai/v1",
      "cohere": "https://api.cohere.com/v2",
      "perplexity": "https://api.perplexity.ai",
      "fireworks": "https://api.fireworks.ai/inference/v1",
      "novita": "https://api.novita.ai/v1",
      "zhipu": "https://open.bigmodel.cn/api/paas/v4",
      "glm": "https://open.bigmodel.cn/api/paas/v4",
      "zai": "https://open.bigmodel.cn/api/paas/v4",
      "iamhc": "https://open.bigmodel.cn/api/paas/v4",
      "alibaba": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "moonshot": "https://api.moonshot.cn/v1",
      "stepfun": "https://api.stepfun.ai/step_plan/v1",
      "minimax": "https://api.minimax.chat/v1",
      "minimax-cn": "https://api.minimaxi.chat/v1",
      "minimax-oauth": "https://api.minimax.io/anthropic",
      "kimi-coding": "https://platform.kimi.kli.app/v1",
      "kimi-coding-cn": "https://platform.kimi.kli.app/v1",
      "xai": "https://api.x.ai/v1",
      "xai-oauth": "https://api.x.ai/v1",
      "nvidia": "https://integrate.api.nvidia.com/v1",
      "huggingface": "https://router.huggingface.co/v1",
      "replicate": "https://api.replicate.com/v1",
      "arcee": "https://api.arcee.ai/api/v1",
      "gmi": "https://api.gmi-serving.com/v1",
      "kilocode": "https://api.kilo.ai/api/gateway",
      "opencode": "https://opencode.ai/zen/v1",
      "opencode-zen": "https://opencode.ai/zen/v1",
      "opencode-go": "https://opencode.ai/zen/go/v1",
      "nous": "https://inference-api.nousresearch.com/v1",
      "lmstudio": "http://127.0.0.1:1234/v1",
      "ollama-cloud": "https://ollama.com/v1",
      "xiaomi": "https://api.xiaomimimo.com/v1",
      "tencent-tokenhub": "https://tokenhub.tencentmaas.com/v1",
      "bedrock": "https://bedrock-runtime.us-east-1.amazonaws.com",
      "azure-foundry": "https://models.inference.azure.com",
      "github-copilot": "",
      "copilot": "",
      "copilot-acp": "",
      "moa": "moa://local",
      "custom": ""
    };

    function getDefaultBaseUrl(slug) {
      if (!slug) return "";
      var s = slug.trim().toLowerCase();
      return PROVIDER_DEFAULT_BASE_URLS[s] || "";
    }

    // ---- i18n -------------------------------------------------------------
    var T = {
      heroKicker: "DECURIA · MODEL CHANNEL ROUTER",
      heroTitle: "三个臭皮匠",
      heroSub: "多模型协作编排 · 三个臭皮匠顶个诸葛亮",
      refresh: "刷新",
      refreshing: "刷新中…",
      loading: "加载中…",
      errTitle: "加载失败",
      statChannels: "渠道数", statProviders: "提供商", statModels: "可用模型", statVis: "已隐藏",
      tabConfig: "通道配置", tabVisibility: "模型管理", tabProviders: "提供商管理", tabMoA: "智囊团",
      globalBarName: "全局默认模型", globalBarSub: "未单独配置的渠道回退到此模型",
      fallbackTitle: "候补模型", fallbackSub: "为图片等多模态任务指定专用模型；渠道未单独配置时回退到此。",
      fallbackRowSub: "设置后，对应模态任务默认使用此模型", lblImage: "图片模型", lblVision: "图片识别模型", lblVideo: "视频模型",
      rowsLabel: "各渠道独立配置",
      lblModel: "目标模型", lblProvider: "模型通道 (provider)",
      phModel: "选择模型…", phProvider: "选择 provider…",
      btnSave: "保存", btnSaving: "保存中…", savedOk: "已保存 ✓",
      btnSaveAll: "💾 保存全部配置", saveHint: "修改后需重启 gateway 才会生效",
      saveNote: "已写入 config.yaml，重启 gateway 生效",
      visTitle: "模型管理", visSub: "默认所有模型均为「关闭」状态：关闭的模型不会被加载，也不会出现在「通道配置」的模型下拉列表中。在模型管理中将某个模型「开启」后，它才会被加载，并可在通道配置的模型列表中选择。",
      visSearchPh: "搜索模型…", visNoMatch: "无匹配模型", visOn: "已开启", visOf: "/ 共",
      provTitle: "提供商管理", provSub: "启用 / 禁用模型供应商，或新增 / 移除。禁用后其下所有模型在通道配置中不再可选。",
      provAddNamePh: "名称（如 My Provider）", provAddSlugPh: "标识符（如 my-provider）",
      provAddUrlPh: "base_url（可选）", provAddKeyPh: "api_key（可选）",
      provAddKeyEnvPh: "key_env（可选）", provAddAnotherKey: "+ 添加另一个 Key", provRemoveKey: "移除此 Key",
      provAddBtn: "添加提供商", provEnableBtn: "启用", provDisableBtn: "禁用", provRemoveBtn: "移除",
      provActiveCount: "活跃", provTotalCount: "共", provAdd: "添加",
      footerNote: "通道配置的改动写入当前 profile 的 config.yaml；运行中的 gateway 需重启后采用新配置。",
      autoOpt: "自动（跟随全局）",
      authenticated: "已认证", unauth: "未认证", configured: "已配置",
      removing: "移除中…", adding: "添加中…",
      search: "搜索", clear: "清除", expandAll: "展开全部", collapse: "收起",
      provAddTitle: "添加提供商", cancel: "取消", errSlugRequired: "标识符不能为空",
      keyLabel: "密钥 (Key)", keyPh: "选择密钥…", keyAuto: "跟随 Provider 默认",
      provEditTitle: "编辑提供商", provEditBtn: "编辑", provEditSave: "保存修改",
      provEditNamePh: "显示名称", provEditUrlPh: "base_url", provEditKeyPh: "api_key", provEditEnvPh: "key_env（环境变量名，可选）",
      provUrlHint: "该地址为参考地址，请根据官方地址配置",
      provEditAnotherKey: "+ 添加另一个 Key", provRemoveKey: "移除此 Key",
      provKeyTitle: "密钥管理", provAddKeyBtn: "添加密钥", provKeysListTitle: "已注册密钥",
      provKeyNamePh: "标签（如 微信备用）", provKeyEnvPh: "key_env 环境变量名（可选）", provKeyValuePh: "api_key 值",
      provNoKeys: "暂无额外密钥，点击下方添加", provKeyRemoveBtn: "删除", keyedTag: "已填 Key",
      // IP 代理配置（按提供商粒度 · 弹窗式）
      proxyAddBtn: "代理配置", proxyModalTitle: "IP 代理设置",
      proxyModalHost: "代理地址（如 127.0.0.1 或 ::1，无需填 http://）", proxyModalPort: "端口（如 18888）",
      proxyModalNote: "开启后会立即更新 Hermes 模型路由；插件加载或重启时不会自动改写 config.yaml。",
      proxyOn: "代理", proxyOff: "直连",
      proxySavedOk: "代理已保存 ✓", proxyNoUrl: "请填写代理地址和端口",
      proxyTestBtn: "测试代理", proxyTesting: "测试中…",
      proxyTestOk: "✓ 代理可用（连接成功）", proxyTestFail: "✗ 不可达：{msg}",
      // MoA / 智囊团（参考设计：MINISTRY · THE ROUNDTABLE OF EXPERTS）
      moaTitle: "智囊团", moaSub: "多模型协作编排 · Mixture of Agents",
      moaMinistryTitle: "专家圆桌会议",
      moaClickHint: "拖动左边的模型卡片到专家的位置",
      moaBenchTitle: "模型席", moaBenchSub: "点击模型卡片选中，再点击右侧圆桌席位放置",
      moaCoreTitle: "核心 · 编排器", moaCoreSub: "",
      moaTabArena: "全部", moaTabCost: "上下文", moaTabSpeed: "名称",
      moaExpert: "臭皮匠", moaOrchestrator: "编排器", moaConductor: "指挥",
      moaArenaRank: "排名", moaCostBadge: "成本", moaSpeedBadge: "速度",
      moaStatusUntracked: "未追踪", moaStatusArena: "竞技场",
      moaDragHint: "放置模型", moaDropHere: "拖放到此处",
      moaDetails: "模型详情", moaDesc: "描述",
      moaArrogantFeatures: "傲慢特性", moaContext: "上下文窗口",
      moaAgentStat: "上下文窗口", moaCostM: "输入 Token", moaTps: "输出 Token",
      moaCopyHermes: "复制配置到 Hermes", moaCopied: "已复制 ✓",
      moaNoModel: "未选择模型", moaUnconfigured: "未配置", moaRunning: "推理中…",
      moaSearchPh: "搜索模型…",
      moaDocLink: "参考文档",
      moaUseDefault: "使用默认配置",
      moaCoreModelLabel: "核心模型 — 汇总者，汇总每个专家的提议并撰写最终答案、执行工具调用。",
      moaExpertsLabel: "专家 — 参考模型。每位并行提出方案（无工具）；核心模型据此裁决。",
      moaCopyConfigIntro: "Hermes — 为我设置一个「多智能体」预设组合（你的「moa」功能），最近一次发布新增；文档：https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents 。通过「mixinry\"调用它。",
      moaTaglinePrefix: "竞技场排行榜 第",
      moaTaglineMid: " 位 | 实时超频核心",
      moaClose: "关闭",
    };

    // ---- helpers ----------------------------------------------------------
    function cn() {
      var a = [];
      for (var i = 0; i < arguments.length; i++) { if (arguments[i]) a.push(arguments[i]); }
      return a.join(" ");
    }
    // 真实品牌图标（取自本机 OpenCode AI Desktop 的 provider 图标雪碧图，
    // 已逐个抽取到 assets/provider-icons/<slug>.svg，fill=currentColor 随主题着色）。
    var ICON_DIR = "/dashboard-plugins/decuria/assets/provider-icons/";
    var KNOWN_ICONS = {
      "302ai":1, "abacus":1, "aihubmix":1, "alibaba":1, "alibaba-cn":1,
      "amazon-bedrock":1, "anthropic":1, "azure":1, "azure-cognitive-services":1,
      "bailing":1, "baseten":1, "berget":1, "cerebras":1, "chutes":1,
      "cloudferro-sherlock":1, "cloudflare-ai-gateway":1, "cloudflare-workers-ai":1,
      "cohere":1, "cortecs":1, "deepinfra":1, "deepseek":1, "digitalocean":1,
      "evroc":1, "fastrouter":1, "fireworks-ai":1, "firmware":1, "friendli":1,
      "github-copilot":1, "github-models":1, "gitlab":1, "google":1,
      "google-vertex":1, "google-vertex-anthropic":1, "groq":1, "helicone":1,
      "huggingface":1, "iflowcn":1, "inception":1, "inference":1, "io-net":1,
      "jiekou":1, "kilo":1, "kimi-for-coding":1, "kuae-cloud-coding-plan":1,
      "llama":1, "lmstudio":1, "lucidquery":1, "meganova":1, "minimax":1,
      "minimax-cn":1, "minimax-cn-coding-plan":1, "minimax-coding-plan":1,
      "mistral":1, "moark":1, "modelscope":1, "moonshotai":1, "moonshotai-cn":1,
      "morph":1, "nano-gpt":1, "nebius":1, "nova":1, "novita-ai":1, "nvidia":1,
      "ollama-cloud":1, "openai":1, "opencode":1, "opencode-go":1, "openrouter":1,
      "ovhcloud":1, "perplexity":1, "poe":1, "privatemode-ai":1, "qihang-ai":1,
      "qiniu-ai":1, "requesty":1, "sap-ai-core":1, "scaleway":1, "siliconflow":1,
      "siliconflow-cn":1, "stackit":1, "stepfun":1, "submodel":1, "synthetic":1,
      "togetherai":1, "upstage":1, "v0":1, "venice":1, "vercel":1, "vivgrid":1,
      "vultr":1, "wandb":1, "xai":1, "xiaomi":1, "zai":1, "zai-coding-plan":1,
      "zenmux":1, "zhipuai":1, "zhipuai-coding-plan":1,
      // 新增（从 opencode desktop sprite-D4l0cmw5 + sprite-Cw-OOOIB 提取 / 手绘）
      "arcee":1, "copilot":1, "azure-foundry":1, "gmi":1, "kilocode":1,
      "custom":1, "copilot-acp":1,
      // 2026-07-09 补充缺失 provider 图标（手绘 / 风格统一）
      "moa":1, "openai-codex":1, "tencent-tokenhub":1, "xai-oauth":1,
      "nous":1, "openai-api":1
    };
    // Decuria 自有 / 常见变体 slug → 图标文件 的别名（只指向已存在的文件）
    var ICON_ALIASES = [
      ["opencode", "opencode"],
      ["opencode-zen", "opencode"],
      ["sensenova", "nova"],
      ["freellm", "openrouter"],
      ["free", "openrouter"],
      ["agnes", "alibaba"],
      ["iamhc", "zhipuai"],
      ["qwen", "alibaba"],
      ["alibaba", "alibaba"],
      ["doubao", "bailing"],
      ["bailing", "bailing"],
      ["glm", "zhipuai"],
      ["zhipu", "zhipuai"],
      // 2026-07-09 修正：kimi 系列用 opencode 专属图标，必须先于泛化 "kimi" 别名
      ["kimi-coding-cn", "moonshotai-cn"],
      ["kimi-coding", "kimi-for-coding"],
      ["kimi", "moonshotai"],
      ["moonshot", "moonshotai"],
      ["claude", "anthropic"],
      ["anthropic", "anthropic"],
      ["gemini", "google"],
      ["google", "google"],
      ["abab", "minimax"],
      ["minimax", "minimax"],
      ["step", "stepfun"],
      ["deepseek", "deepseek"],
      // 新增别名（常见 slug 变体 → 已有图标文件）
      ["copilot", "copilot"],
      ["github-copilot", "copilot"],
      ["bedrock", "amazon-bedrock"],
      ["vertex", "google-vertex"],
      ["azure-foundry", "azure-foundry"],
      ["kilocode", "kilocode"],
      // 2026-07-09 补充别名（新 provider 的常见变体 → 图标文件）
      ["moa", "moa"],
      ["codex", "openai-codex"],
      ["openai-codex", "openai-codex"],
      ["tokenhub", "tencent-tokenhub"],
      ["tencent-tokenhub", "tencent-tokenhub"],
      ["grok", "xai-oauth"],
      ["xai-oauth", "xai-oauth"],
      ["supergrok", "xai-oauth"],
      ["nous", "nous"],
      ["nous-research", "nous"],
      ["nousportal", "nous"],
      ["openai-api", "openai-api"],
      // 2026-07-09 补充：model-universe 出现但无映射的 slug
      ["novita", "novita-ai"],
      ["alibaba-coding-plan", "alibaba"]
    ];
    function iconFileForSlug(slug) {
      var s = (slug || "").toLowerCase().trim();
      if (!s) return "unknown";
      if (KNOWN_ICONS[s]) return s;
      for (var i = 0; i < ICON_ALIASES.length; i++) {
        if (s.indexOf(ICON_ALIASES[i][0]) >= 0) return ICON_ALIASES[i][1];
      }
      return "unknown";
    }
    function providerIcon(slug) {
      var file = iconFileForSlug(slug);
      // 全部供应商图标合并进单个 sprite.svg（1 次请求 + 浏览器缓存），
      // 通过 <use> 引用对应 symbol，彻底消除原先每张图标一个 HTTP 请求的瀑布。
      // CSS .dc-prov-ico 的 filter:brightness(0) invert(1) 会把图标统一反转为白色剪影。
      return h("svg", {
        className: "dc-prov-ico",
        viewBox: "0 0 24 24",
        "aria-hidden": "true"
      }, h("use", {
        href: ICON_DIR + "sprite.svg#" + file,
        "xlink:href": ICON_DIR + "sprite.svg#" + file
      }));
    }
    // ── 品牌 SVG 图标数据（SVG paths from Simple Icons, CC0-1.0）──
    var _BRAND = {
      weixin:       { c:"#07C160", v:"M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" },
      feishu:       {c:"#3370FF",vb:"0 0 48 48",v:["M41.07 5.994L3.31 16.52l12.08 9.29 8.41.15 9.68-9.44c-.26-.53-.38-.97-.38-1.32 0-.79.31-1.42.8-1.87.83-.76 1.82-.88 2.99-.34L41.07 5.99Z","M42.1 6.73L31.58 44.49l-9.29-9.08-.15-8.41 9.38-9.52c.51.36 1.06.53 1.66.49.9-.05 1.49-.6 1.76-.92.27-.32.59-.85.57-1.65-.02-.53-.19-1.02-.52-1.46L42.1 6.73Z"]},
      feishu2:       {c:"#3370FF",vb:"0 0 48 48",v:["M41.07 5.994L3.31 16.52l12.08 9.29 8.41.15 9.68-9.44c-.26-.53-.38-.97-.38-1.32 0-.79.31-1.42.8-1.87.83-.76 1.82-.88 2.99-.34L41.07 5.99Z","M42.1 6.73L31.58 44.49l-9.29-9.08-.15-8.41 9.38-9.52c.51.36 1.06.53 1.66.49.9-.05 1.49-.6 1.76-.92.27-.32.59-.85.57-1.65-.02-.53-.19-1.02-.52-1.46L42.1 6.73Z"]},
      telegram:     { c:"#26A5E4", v:"M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.247-.241-1.857-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" },
      discord:      { c:"#5865F2", v:"M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" },
      slack:        { c:"#4A154B", v:"M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" },
      whatsapp:      { c:"#25D366", v:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" },
      whatsapp_cloud:{ c:"#25D366", v:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" },
      signal:        { c:"#3A76F0", v:"M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c.18.018.382.136.418.369.143.908.144 2.627-.432 4.105-.58 1.49-1.832 2.786-3.764 3.255a.756.756 0 0 1-.903-.565.756.756 0 0 1 .565-.903c1.543-.365 2.476-1.357 2.92-2.496.446-1.146.446-2.47.333-3.166a.375.375 0 0 0-.137-.267zM12 3.375a8.625 8.625 0 1 0 0 17.25 8.625 8.625 0 0 0 0-17.25z" },
      matrix:        { c:"#000000", v:"M.633 8.68v9.138h2.28V8.68H.633zm2.865 0v9.138h2.28V8.68H3.498zm2.865 0v9.138h2.28V8.68H6.363zm2.865 0v9.138h2.28V8.68H9.228zm2.865 0v9.138h2.28V8.68h-2.28zm2.865 0v9.138h2.28V8.68h-2.28zm2.865 0v9.138h2.28V8.68h-2.28z" },
      line:         { c:"#00C300", v:"M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c.18.018.382.136.418.369.143.908.144 2.627-.432 4.105-.58 1.49-1.832 2.786-3.764 3.255a.756.756 0 0 1-.903-.565.756.756 0 0 1 .565-.903c1.543-.365 2.476-1.357 2.92-2.496.446-1.146.446-2.47.333-3.166a.375.375 0 0 0-.137-.267z" },
      kakaotalk:     { c:"#FEE500", v:"M12 0C5.373 0 0 4.373 0 9.764c0 5.392 5.373 9.765 12 9.765 1.034 0 2.028-.132 2.97-.378l-.016-.003c.636-.168 1.123-.726 1.184-1.4.066-.73-.38-1.388-1.03-1.63C15.738 15.396 18 12.84 18 9.764 18 4.373 12.627 0 12 0z" },
      mattermost:    { c:"#0025AA", v:"M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zM4.5 9.55a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zm7 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z" },
      dingtalk:      { c:"#0089FF", v:"M10.256 2.176C5.918 2.176 2.4 5.308 2.4 9.176c0 3.112 2.304 5.74 5.504 6.696l-.512 1.92c-.024.096-.048.192-.048.288 0 .216.176.392.392.392a.4.4 0 0 0 .232-.072l2.528-1.488a9.54 9.54 0 0 0 1.76.16c4.338 0 7.856-3.132 7.856-7S14.594 2.176 10.256 2.176zM7.6 7.2a1.44 1.44 0 1 1 0 2.88 1.44 1.44 0 0 1 0-2.88zm5.312 0a1.44 1.44 0 1 1 0 2.88 1.44 1.44 0 0 1 0-2.88z" },
      wecom:        { c:"#000000", v:"M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.664.664 0 0 1 .317-.078c.07 0 .14.012.208.036C6.277 16.972 7.466 17.188 8.69 17.188c4.801 0 8.692-3.287 8.692-7.342 0-4.054-3.89-7.341-8.691-7.341zm-2.67 9.294a1.062 1.062 0 1 1 0-2.124 1.062 1.062 0 0 1 0 2.124zm5.339 0a1.062 1.062 0 1 1 0-2.124 1.062 1.062 0 0 1 0 2.124z" },
      wecom_callback:{ c:"#000000", v:"M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.664.664 0 0 1 .317-.078c.07 0 .14.012.208.036C6.277 16.972 7.466 17.188 8.69 17.188c4.801 0 8.692-3.287 8.692-7.342 0-4.054-3.89-7.341-8.691-7.341zm-2.67 9.294a1.062 1.062 0 1 1 0-2.124 1.062 1.062 0 0 1 0 2.124zm5.339 0a1.062 1.062 0 1 1 0-2.124 1.062 1.062 0 0 1 0 2.124z" },
      qqbot:        { c:"#1EBAFC", v:"M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673z" },
      yuanbao:      { c:"#FF6A00", v:"M12 2L2 7l10 5 10-5L12 2zM2 17l10 5 10-5M2 12l10 5 10-5" },
      global:        { c:"#6366F1", v:"M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" },
      webhook:       { c:"#FF6D00", v:"M7.5 0a7.5 7.5 0 0 1 7.5 7.5c0 1.58-.488 3.047-1.32 4.255l4.032 4.033a1 1 0 0 1-1.414 1.414l-4.033-4.032A7.5 7.5 0 1 1 7.5 0z" },
      api_server:    { c:"#6366F1", v:"M20 2H4c-1.103 0-2 .897-2 2v16c0 1.103.897 2 2 2h16c1.103 0 2-.897 2-2V4c0-1.103-.897-2-2-2zM4 4h16v4H4V4zm0 6h16v8H4v-8z" },
      bluebubbles:   { c:"#007AFF", v:"M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zM9 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm6 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zM6.5 11h11a.5.5 0 0 1 .4.8C16.7 14 14.5 16 12 16s-4.7-2-5.9-4.2a.5.5 0 0 1 .4-.8z" },
      email:         { c:"#EA4335", v:"M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 1.636-3.655 3.636-3.655h.055C6.473 1.8 9.23 2.182 12 5.09c2.77-2.908 5.527-3.29 8.31-3.29h.055c2 0 3.636 1.632 3.636 3.655z" },
      homeassistant: { c:"#41BDF5", v:"M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 2.165a.5.5 0 0 1-.746.026l-2.12-1.926a.5.5 0 0 0-.7 0L9.25 13.684a.5.5 0 0 1-.746-.026l-1.97-2.165a.5.5 0 0 1 .026-.746l2.12-1.926a.5.5 0 0 0 0-.7L6.106 5.316a.5.5 0 0 1 .746-.746l2.12 1.926a.5.5 0 0 0 .7 0l2.108-1.926a.5.5 0 0 1 .746.026l1.97 2.165a.5.5 0 0 1-.026.746l-2.12 1.926a.5.5 0 0 0 0 .7l2.108 1.926a.5.5 0 0 1-.746.746z" },
      cron:         { c:"#10B981", v:"M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zM11 5h2v7h-2V5zm0 9h2v2h-2v-2z" }
    };
    function _makeBrandIcon(brand) {
      var b = _BRAND[brand];
      if (!b) return "📡";
      var paths = Array.isArray(b.v) ? b.v : [b.v];
      var pathEls = paths.map(function(p){return h("path",{d:p});});
      return h("span",{
        className:"dc-brand-wrap",
        style:{background:b.c}
      },h("svg",{
        viewBox:(b.vb||"0 0 24 24"),
        fill:"#fff",
        width:"18",
        height:"18",
        style:{display:"block",margin:"auto"}
      },pathEls));
    }
    // 候补模型图标（Lucide 开源图标，ISC License）
    var _FB_ICON = {
      image:  { c:"#8B5CF6", v:"M4 4h16v16H4z M4 16l4-4 3 3 5-5 4 4" },
      vision: { c:"#10B981", v:"M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" },
      video:  { c:"#F59E0B", v:"M3 6h13v12H3z M16 9l5-3v12l-5-3z" }
    };
    function _fallbackIcon(kind) {
      var b = _FB_ICON[kind];
      if (!b) return "📋";
      return h("span",{
        className:"dc-brand-wrap",
        style:{background:b.c}
      },h("svg",{
        viewBox:"0 0 24 24",
        fill:"none",
        stroke:"#fff",
        strokeWidth:2,
        strokeLinecap:"round",
        strokeLinejoin:"round",
        width:"18",
        height:"18",
        style:{display:"block",margin:"auto"}
      },h("path",{d:b.v})));
    }
    function platformIcon(p) {
      var b = _BRAND[p];
      if (!b) return "📡";
      return _makeBrandIcon(p);
    }
    function platformLabel(p) {
      var m = {
        "weixin":"微信","feishu":"飞书","feishu2":"飞书二",
        "telegram":"Telegram","discord":"Discord","slack":"Slack",
        "whatsapp":"WhatsApp","whatsapp_cloud":"WhatsApp Cloud","signal":"Signal",
        "matrix":"Matrix","line":"Line","kakaotalk":"KakaoTalk",
        "mattermost":"Mattermost","dingtalk":"钉钉","wecom":"企业微信",
        "wecom_callback":"企业微信回调","qqbot":"QQ 机器人","yuanbao":"元宝",
        "webhook":"Webhook","api_server":"API Server","bluebubbles":"BlueBubbles",
        "email":"邮件","homeassistant":"Home Assistant","cron":"定时任务"
      };
      return (m[p] || p);
    }
    function formatCtx(ctx) {
      if (!ctx || ctx <= 0) return "—";
      if (ctx >= 1000000) {
        var m = ctx / 1000000;
        return (Math.round(m * 100) / 100) + "M";
      }
      return Math.round(ctx / 1000) + "K";
    }

    function fmtTok(n) {
      if (!n || n <= 0) return "0";
      if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "K";
      return String(n);
    }

    // 渠道来源图标映射
    var _SRC_ICONS = { "微信": "💬", "飞书": "🚀", "飞书2": "🚀", "Telegram": "✈️",
      "企业微信": "📢", "钉钉": "🔔", "QQ机器人": "🐧", "Slack": "💼",
      "Discord": "🎮", "WhatsApp": "📱", "Signal": "🔒", "panel": "🖥️" };
    function _sourceIcon(src) {
      return (_SRC_ICONS[src] || "📡");
    }

    // ---- small UI primitives ---------------------------------------------
    function Hero(props) {
      return h("div", { className: "dc-hero" },
        h("div", { className: "dc-hero-text" },
          h("div", { className: "dc-kicker" }, T.heroKicker),
          h("h1", null, T.heroTitle),
          h("p", null, T.heroSub)
        )
      );
    }

    function Stats(props) {
      return h("div", { className: "dc-stats dc-stats-2x2" },
        h("div", { className: "dc-stat" },
          h("span", { className: "dc-stat-value" }, String(props.channelCount)),
          h("span", { className: "dc-stat-hint" }, " 个活跃渠道")
        ),
        h("div", { className: "dc-stat" },
          h("span", { className: "dc-stat-value" }, String(props.providerCount)),
          h("span", { className: "dc-stat-hint" }, " 个提供商")
        ),
        h("div", { className: "dc-stat" },
          h("span", { className: "dc-stat-value" }, String(props.modelCount)),
          h("span", { className: "dc-stat-hint" }, " 可选模型")
        ),
        h("div", { className: "dc-stat" },
          h("span", { className: cn("dc-stat-value", props.visibleCount > 0 ? "dc-ok" : "dc-warn") }, String(props.visibleCount)),
          h("span", { className: "dc-stat-hint" }, " 已开启模型")
        )
      );
    }

    function Tabs(props) {
      var items = props.tabs || [];
      return h("div", { className: "dc-tabs" },
        items.map(function (t) {
          return h("button", {
            key: t.key,
            className: cn(t.key === props.active && "active"),
            onClick: function () { if (props.onTab) props.onTab(t.key); }
          }, t.label);
        })
      );
    }

    function Switch(props) {
      return h("label", { className: "dc-switch" },
        h("input", { type: "checkbox", checked: !!props.checked, onChange: props.onChange }),
        h("span", { className: "dc-switch-track" })
      );
    }

    function Badge(text, variant) {
      return h("span", { className: cn("dc-badge", variant === "accent" && "dc-badge-accent", variant === "ok" && "dc-badge-ok", variant === "warn" && "dc-badge-warn", variant === "muted" && "dc-badge-muted") }, text);
    }

    function Spinner() {
      return h("div", { className: "dc-empty", style: { padding: "3rem 0" } }, T.loading);
    }

    function Loader(props) {
      return h("div", { className: "dc-empty", style: { padding: "2.5rem 0" } }, props.text || T.loading);
    }

    function ErrorBanner(props) {
      return h("div", { className: "dc-banner dc-banner-err" },
        h("strong", null, T.errTitle + "："),
        " " + props.message
      );
    }

    // ---- selects ----------------------------------------------------------
    function ModelSelect(props) {
      var opts = (props.options || []).map(function (m) {
        return h("option", { key: m, value: m }, m);
      });
      return h("select", {
        value: props.value || "",
        onChange: function (e) { if (props.onChange) props.onChange(e.target.value); }
      }, h("option", { value: "" }, props.placeholder || "选择…"), opts);
    }

    function ProviderSelect(props) {
      var opts = (props.options || []).map(function (p) {
        return h("option", { key: p.slug, value: p.slug }, p.name || p.slug);
      });
      return h("select", {
        value: props.value || "",
        onChange: function (e) { if (props.onChange) props.onChange(e.target.value); }
      }, h("option", { value: "" }, props.placeholder || "选择…"), opts);
    }

    // ---- Key control (selector for a provider's API keys) -----------------
    // Props: provider (slug), keys (array from /keys: [{id,label,key_env?,api_key?,api_key_preview?}]),
    //        value (selected key id), onChange(id).
    // Always renders as a <select> for consistent visual alignment across rows.
    // <=1 key -> single-option select (disabled-looking). >1 key -> pickable dropdown.
    function KeyControl(props) {
      var keys = props.keys || [];
      var value = props.value || "";
      if (keys.length === 0) return null;
      var opts = [];
      // First option = primary key preview (value="" means "use default")
      var primary = keys.find(function (k) { return k.id === "primary"; });
      if (primary) {
        var pPreview = primary.api_key || primary.api_key_preview || "";
        var pLabel = pPreview ? (pPreview.length > 20 ? pPreview.slice(0, 14) + "\u2026" + pPreview.slice(-4) : pPreview) : (primary.label || T.keyAuto);
        opts.push({ value: "", label: pLabel, title: pPreview || primary.label || "" });
      } else {
        opts.push({ value: "", label: T.keyAuto, title: "" });
      }
      // Extra keys — SKIP "primary" to avoid duplicate with the first option above
      keys.forEach(function (k) {
        if (k.id === "primary") return; // already shown as option ""
        var lbl = k.api_key || k.api_key_preview || k.label || k.key_env || k.id;
        if (lbl.length > 22) lbl = lbl.slice(0, 16) + "\u2026" + lbl.slice(-4);
        opts.push({ value: k.id, label: lbl, title: (k.api_key || k.api_key_preview || "") });
      });
      return h("select", {
        className: "dc-key-select",
        value: value,
        onChange: function (e) { if (props.onChange) props.onChange(e.target.value); }
      }, opts.map(function (o) { return h("option", { key: o.value, value: o.value, title: o.title }, o.label); }));
    }

    // ---- Config section ---------------------------------------------------
    function GlobalBar(props) {
      var ms = useState(props.initial.model || "");
      var ps = useState(props.initial.provider || "");
      var model = ms[0], setModel = ms[1];
      var prov = ps[0], setProv = ps[1];
      var ks = useState(props.initial.key || "");
      var key = ks[0], setKey = ks[1];

      function handleProvChange(v) {
        setProv(v);
        setModel("");
        setKey("");
        props.onChange({ model: "", provider: v, key: "" });
      }

      return h("div", { className: "dc-bar dc-bar-global" },
        h("div", { className: "dc-bar-id" },
          h("span", { className: "dc-bar-icon" }, _makeBrandIcon("global")),
          h("div", null,
            h("div", { className: "dc-bar-name" }, T.globalBarName),
            h("div", { className: "dc-bar-sub" }, T.globalBarSub)
          )
        ),
        h("div", { className: "dc-bar-controls" },
          ModelSelect({ value: model, options: props.modelsResolver(prov, model), placeholder: T.phModel, onChange: function (v) { setModel(v); props.onChange({ model: v, provider: prov, key: key }); } }),
          ProviderSelect({ value: prov, options: props.providerOptions, placeholder: T.phProvider, onChange: handleProvChange }),
          KeyControl({ provider: prov, keys: (props.providerKeys || {})[prov] || [], value: key, onChange: function (v) { setKey(v); props.onChange({ model: model, provider: prov, key: v }); } })
        )
      );
    }

    function ChannelRow(props) {
      var ch = props.ch;
      var rawChannelId = String(ch.channel_id || "");
      var maskedChannelId = rawChannelId
        ? (rawChannelId.length > 8
          ? rawChannelId.slice(0, 4) + "\u2026" + rawChannelId.slice(-4)
          : "\u2022\u2022\u2022\u2022")
        : "";
      var ms = useState(ch.model || "");
      var ps = useState(ch.provider || "");
      var model = ms[0], setModel = ms[1];
      var prov = ps[0], setProv = ps[1];
      var ks = useState(ch.key || "");
      var key = ks[0], setKey = ks[1];

      function handleProvChange(v) {
        setProv(v);
        setModel("");
        setKey("");
        props.onChange({ model: "", provider: v, key: "" });
      }

      return h("div", { className: "dc-bar dc-bar-ch" },
        h("div", { className: "dc-bar-id" },
          h("span", { className: "dc-bar-icon" }, platformIcon(ch.platform)),
          h("div", null,
            h("div", { className: "dc-bar-name" }, platformLabel(ch.platform) + " · " + maskedChannelId),
            h("div", { className: "dc-bar-sub" }, platformLabel(ch.platform) + " · " + maskedChannelId)
          )
        ),
        h("div", { className: "dc-bar-controls" },
          ModelSelect({ value: model, options: props.modelsResolver(prov, model), placeholder: T.phModel, onChange: function (v) { setModel(v); props.onChange({ model: v, provider: prov, key: key }); } }),
          ProviderSelect({ value: prov, options: props.providerOptions, placeholder: T.phProvider, onChange: handleProvChange }),
          KeyControl({ provider: prov, keys: (props.providerKeys || {})[prov] || [], value: key, onChange: function (v) { setKey(v); props.onChange({ model: model, provider: prov, key: v }); } })
        )
      );
    }

    function ConfigSection(props) {
      var channels = (props.channels && props.channels.channels) || [];
      var globalInit = (props.channels && props.channels.global) || {};
      var fbInit = props.fallback || { image: { model: "", provider: "", key: "" }, vision: { model: "", provider: "", key: "" }, video: { model: "", provider: "", key: "" } };
      var pKeys = props.providerKeys || {};

      // Collected state from each row (optimistic, tracks what user sees)
      var gSt = useState({ model: globalInit.model || "", provider: globalInit.provider || "", key: globalInit.key || "" });
      var globalVal = gSt[0], setGlobalVal = gSt[1];
      var fbSt = useState({
        image: Object.assign({}, fbInit.image || { model: "", provider: "", key: "" }),
        vision: Object.assign({}, fbInit.vision || { model: "", provider: "", key: "" }),
        video: Object.assign({}, fbInit.video || { model: "", provider: "", key: "" })
      });
      var fbVal = fbSt[0], setFbVal = fbSt[1];
      var chSt = useState(function () {
        var m = {};
        channels.forEach(function (ch) { m[ch.platform + "::" + ch.channel_id] = { model: ch.model || "", provider: ch.provider || "", key: ch.key || "" }; });
        return m;
      });
      var chVal = chSt[0], setChVal = chSt[1];

      // Save state
      var sv = useState(false);
      var savingAll = sv[0], setSavingAll = sv[1];
      var sd = useState(false);
      var savedAll = sd[0], setSavedAll = sd[1];
      var se = useState(null);
      var saveErr = se[0], setSaveErr = se[1];

      function handleSaveAll() {
        if (!globalVal.model || !globalVal.provider) return;
        setSavingAll(true); setSavedAll(false); setSaveErr(null);
        var payload = {
          global_model: { model: globalVal.model, provider: globalVal.provider, key: globalVal.key || "" },
          fallback_image: fbVal.image,
          fallback_vision: fbVal.vision,
          fallback_video: fbVal.video,
          channels: channels.map(function (ch) {
            var cv = chVal[ch.platform + "::" + ch.channel_id] || {};
            return { platform: ch.platform, channel_id: ch.channel_id, model: cv.model || "", provider: cv.provider || "", key: cv.key || "" };
          })
        };
        fetchJSON(API + "/config/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (res) {
          setSavingAll(false);
          setSavedAll(true);
          if (props.onSavedAll) props.onSavedAll(payload);
          setTimeout(function () { setSavedAll(false); }, 3000);
        }).catch(function (e) {
          setSavingAll(false);
          setSaveErr(String((e && e.message) || e));
        });
      }

      return h("div", { className: "dc-config-wrapper" },
        h(GlobalBar, { initial: globalInit, modelsResolver: props.modelsResolver, providerOptions: props.providerOptions, providerKeys: pKeys, onChange: setGlobalVal }),
        h(FallbackSection, { initial: fbInit, modelsResolver: props.modelsResolver, providerOptions: props.providerOptions, providerKeys: pKeys, onFallbackChange: function (kind, data) { var n = Object.assign({}, fbVal); n[kind] = data; setFbVal(n); }, fallbackValues: fbVal }),
        h("div", { className: "dc-rows-label" }, T.rowsLabel),
        h("div", { className: "dc-rows" },
          channels.map(function (ch) {
            return h(ChannelRow, {
              key: ch.platform + "::" + ch.channel_id,
              ch: ch,
              modelsResolver: props.modelsResolver,
              providerOptions: props.providerOptions,
              providerKeys: pKeys,
              onChange: function (data) { var n = Object.assign({}, chVal); n[ch.platform + "::" + ch.channel_id] = data; setChVal(n); }
            });
          })
        ),
        h("div", { className: "dc-save-all-bar" },
          h("span", { className: "dc-save-hint" }, T.saveHint),
          h("button", {
            className: "dc-btn dc-btn-primary dc-btn-lg" + (savingAll ? " dc-btn-loading" : "") + (savedAll ? " dc-btn-success" : ""),
            onClick: handleSaveAll,
            disabled: savingAll
          }, savingAll ? T.btnSaving : (savedAll ? T.savedOk : T.btnSaveAll)),
          saveErr && h("span", { className: "dc-inline-err" }, saveErr),
          savedAll && h("span", { className: "dc-save-note" }, T.saveNote)
        )
      );
    }

    // ---- Fallback (multi-modal) models -----------------------------------
    // A dedicated section placed between the global default model and the
    // per-channel rows. Lets the user pin an IMAGE model and a VIDEO model
    // (e.g. for multimodal tasks) under config.yaml::model.fallback.
    function FallbackRow(props) {
      var kind = props.kind; // "image"
      var init = props.initial || { model: "", provider: "", key: "" };
      var ms = useState(init.model || "");
      var ps = useState(init.provider || "");
      var ks = useState(init.key || "");
      var model = ms[0], setModel = ms[1];
      var prov = ps[0], setProv = ps[1];
      var key = ks[0], setKey = ks[1];

      function handleProvChange(v) {
        setProv(v);
        setModel("");
        setKey("");
        props.onChange(kind, { model: "", provider: v, key: "" });
      }

      return h("div", { className: "dc-bar" },
        h("div", { className: "dc-bar-id" },
          h("span", { className: "dc-bar-icon" }, (typeof props.icon === "string" && props.icon.indexOf("svg:") === 0) ? _fallbackIcon(props.icon.slice(4)) : props.icon),
          h("div", null,
            h("div", { className: "dc-bar-name" }, props.label),
            h("div", { className: "dc-bar-sub" }, T.fallbackRowSub)
          )
        ),
        h("div", { className: "dc-bar-controls" },
          ModelSelect({ value: model, options: props.modelsResolver(prov, model), placeholder: T.phModel, onChange: function (v) { setModel(v); props.onChange(kind, { model: v, provider: prov, key: key }); } }),
          ProviderSelect({ value: prov, options: props.providerOptions, placeholder: T.phProvider, onChange: handleProvChange }),
          KeyControl({ provider: prov, keys: (props.providerKeys || {})[prov] || [], value: key, onChange: function (v) { setKey(v); props.onChange(kind, { model: model, provider: prov, key: v }); } })
        )
      );
    }

    function FallbackSection(props) {
      var fb = props.fallbackValues || props.initial || { image: { model: "", provider: "", key: "" }, vision: { model: "", provider: "", key: "" } };
      return h("div", null,
        h("div", { className: "dc-rows-label" }, T.fallbackTitle),
        h("div", { className: "dc-rows", style: { marginBottom: ".3rem" } },
          h(FallbackRow, {
            kind: "image", label: T.lblImage, icon: "svg:image",
            initial: fb.image || { model: "", provider: "", key: "" },
            modelsResolver: props.modelsResolver, providerOptions: props.providerOptions, providerKeys: props.providerKeys,
            onChange: props.onFallbackChange
          }),
          h(FallbackRow, {
            kind: "vision", label: T.lblVision, icon: "svg:vision",
            initial: fb.vision || { model: "", provider: "", key: "" },
            modelsResolver: props.modelsResolver, providerOptions: props.providerOptions, providerKeys: props.providerKeys,
            onChange: props.onFallbackChange
          }),
          h(FallbackRow, {
            kind: "video", label: T.lblVideo, icon: "svg:video",
            initial: fb.video || { model: "", provider: "", key: "" },
            modelsResolver: props.modelsResolver, providerOptions: props.providerOptions, providerKeys: props.providerKeys,
            onChange: props.onFallbackChange
          })
        )
      );
    }

    // ---- Visibility section ----------------------------------------------
    function Chevron(props) {
      return h("span", { className: cn("dc-chevron", props.open && "open") }, "›");
    }

    function VisibilityGroup(props) {
      var pg = props.providerGroup;
      var open = useState(props.defaultOpen !== false);
      var userOpen = open[0], setOpen = open[1];

      var search = (props.searchQuery || "").toLowerCase().trim();
      // 搜索时强制展开分组，否则匹配项会藏在折叠层里、看起来像"搜不到"。
      var isOpen = search ? true : userOpen;

      var filtered = search
        ? (pg.models || []).filter(function (m) { return m.toLowerCase().indexOf(search) >= 0; })
        : (pg.models || []);

      var onCount = filtered.filter(function (m) { return props.visOn[pg.slug + "::" + m]; }).length;
      var pxOn = !!props.proxyProviders && !!props.proxyProviders[pg.slug];
      var hasProxyToggle = typeof props.onProxyToggle === "function";

      return h("div", { className: "dc-vis-group" },
        h("div", { className: "dc-vis-group-header" },
          h("button", { className: "dc-vis-group-header-main", onClick: function () { setOpen(!userOpen); } },
            h(Chevron, { open: isOpen }),
            h("span", { className: "dc-vis-group-icon" }, providerIcon(pg.slug)),
            h("span", { className: "dc-vis-group-name" }, pg.name || pg.slug)
          ),
          hasProxyToggle && h("label", {
            className: "dc-proxy-switch" + (pxOn ? " dc-proxy-switch-on" : ""),
            title: pxOn ? T.proxyOff : T.proxyOn,
            onClick: function (e) { e.stopPropagation(); }
          }, T.proxyOn,
            h("input", {
              type: "checkbox",
              checked: pxOn,
              onChange: function (e) { e.stopPropagation(); props.onProxyToggle(pg.slug, !pxOn); }
            }),
            h("span", { className: "dc-proxy-switch-track" },
              h("span", { className: "dc-proxy-switch-thumb" })
            )
          ),
          h("span", { className: "dc-vis-group-count" }, onCount + " / " + filtered.length)
        ),
        isOpen && h("div", { className: "dc-vis-group-body" },
          (pg.models || []).length === 0
            ? h("div", { className: "dc-empty", style: { padding: ".8rem .5rem", fontSize: ".82rem", color: "var(--dc-text-2)" } }, "\u8be5\u63d0\u4f9b\u5546\u672a\u63a2\u6d4b\u5230\u6a21\u578b\u5217\u8868\uff0c\u8bf7\u70b9\u51fb\u53f3\u4e0a\u89d2 \u{1f504} \u5237\u65b0")
            : filtered.length === 0 && h("div", { className: "dc-empty", style: { padding: ".8rem .5rem", fontSize: ".82rem" } }, "\u65e0\u5339\u914d\u6a21\u578b"),
          filtered.map(function (m) {
            var key = pg.slug + "::" + m;
            return h("div", { key: m, className: "dc-vis-item" },
              h("span", { className: "dc-vis-item-name" }, m),
              Switch({ checked: !!props.visOn[key], onChange: function () { props.onToggle(pg.slug, m); } })
            );
          })
        )
      );
    }

    function VisibilitySection(props) {
      // visOn: { "slug::model": true }  (true = visible). Backend stores the
      // HIDDEN set {slug:[models]} — empty => all visible. So a model is
      // visible unless it appears in the hidden list.
      var initVis = {};
      var hidden = props.hiddenByProvider || {};
      // Raw entries preserve the provider-level "*" default-off policy and
      // its !visible:<model> exceptions. hiddenByProvider is the expanded set
      // used to render the current switches.
      var rawHidden = props.rawHiddenByProvider || hidden;
      Object.keys(hidden).forEach(function (slug) {
        var _list = hidden[slug] || [];
        // P3-4：特殊标记 "*" 表示「该 provider 下所有模型均隐藏」（新增 provider
        // 且尚未探测到模型列表时的占位）。需展开为真实模型列表，否则只有
        // "slug::*" 这一条被标记隐藏，真实模型仍显示「开启」。
        if (_list.indexOf("*") >= 0) {
          (props.provRows || []).forEach(function (_p) {
            if (_p.slug === slug) (_p.models || []).forEach(function (_m) { initVis[slug + "::" + _m] = false; });
          });
        } else {
          _list.forEach(function (m) { initVis[slug + "::" + m] = false; });
        }
      });
      // everything else defaults to visible (true)
      (props.provRows || []).forEach(function (p) {
        (p.models || []).forEach(function (m) {
          var key = p.slug + "::" + m;
          if (!(key in initVis)) initVis[key] = true;
        });
      });
      var visState = useState(initVis);
      var visOn = visState[0], setVisOn = visState[1];
      // useState only consumes its initializer once. Re-seed when a forced
      // universe refresh adds/removes models or the persisted visibility file
      // changes, otherwise freshly discovered models never enter local state.
      var visSeedKey = Object.keys(initVis).sort().map(function (k) {
        return k + "=" + (initVis[k] ? "1" : "0");
      }).join("|");
      useEffect(function () { setVisOn(initVis); }, [visSeedKey]);
      var saving = useState(false);
      var search = useState("");
      var isSaving = saving[0], setSaving = saving[1];
      var query = search[0], setQuery = search[1];
      // P3-2：最近配置/编辑的 provider（来自 providerState.last_added）固定置顶。
      var lastAdded = props.lastAdded || null;
      var refreshing = useState(false);
      var isRefreshing = refreshing[0], setRefreshing = refreshing[1];
      // 刷新结果提示
      var refreshMsgSt = useState("");
      var refreshMsg = refreshMsgSt[0], setRefreshMsg = refreshMsgSt[1];

      // ── Per-provider proxy state ──
      var pxUrlSt = useState("127.0.0.1");
      var proxyHost = pxUrlSt[0], setProxyHost = pxUrlSt[1];
      var pxPortSt = useState(18888);
      var proxyPort = pxPortSt[0], setProxyPort = pxPortSt[1];
      var pxEpSt = useState({});  // { "gemini": true, "deepseek": false }
      var proxyProviders = pxEpSt[0], setProxyProviders = pxEpSt[1];
      var pxSvSt = useState(false);
      var proxySaved = pxSvSt[0], setProxySaved = pxSvSt[1];
      var pxErSt = useState(null);
      var proxyErr = pxErSt[0], setProxyErr = pxErSt[1];
      var showProxyModalSt = useState(false);
      var showProxyModal = showProxyModalSt[0], setShowProxyModal = showProxyModalSt[1];

      function _proxyAddress(host, port) {
        var h = (host || "").trim();
        if (h.indexOf(":") !== -1 && h.charAt(0) !== "[") h = "[" + h + "]";
        return h + ":" + String(Number(port) || 0);
      }

      function toggleProviderProxy(slug, on) {
        var next = Object.assign({}, proxyProviders);
        if (on) next[slug] = true; else delete next[slug];
        setProxyProviders(next);
        // Persist immediately, matching visibility toggles.
        var host = (proxyHost || "").trim();
        var port = Number(proxyPort) || 0;
        var body = { enabled_providers: next };
        if (host && port) body.proxy_url = _proxyAddress(host, port);
        fetchJSON(API + "/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).catch(function () {});
      }

      useEffect(function () {
        fetchJSON(API + "/proxy").then(function (d) {
          if (!d || typeof d !== "object") return;
          // Parse canonical and legacy proxy URL formats, including IPv6.
          if (d.proxy_url) {
            try {
              var rawProxy = String(d.proxy_url || "");
              var parsedProxy = new URL(rawProxy.indexOf("://") === -1 ? "http://" + rawProxy : rawProxy);
              setProxyHost((parsedProxy.hostname || "").replace(/^\[|\]$/g, ""));
              setProxyPort(Number(parsedProxy.port) || (parsedProxy.protocol === "https:" ? 443 : 80));
            } catch (e) { setProxyErr("代理地址格式无效"); }
          } else if (d.proxies && d.proxies.length > 0) {
            var active = d.proxies[d.active_index || 0] || {};
            setProxyHost(active.host || "");
            setProxyPort(active.port || 0);
          }
          if (d.enabled_providers) {
            setProxyProviders(d.enabled_providers);
          }
        }).catch(function () {});
      }, []);

      function handleRefresh() {
        if (isRefreshing) return;
        setRefreshing(true);
        setRefreshMsg("");
        // 强制重建模型宇宙缓存（探测所有 provider 的 /v1/models，同步返回新列表）
        var p = (props.onRefresh || function () { return Promise.resolve(); })();
        Promise.resolve(p).then(function (result) {
          setRefreshing(false);
          if (result && result.providers) {
            setRefreshMsg("refresh_ok");
            setTimeout(function () { setRefreshMsg(""); }, 2000);
          } else {
            setRefreshMsg("refresh_empty");
            setTimeout(function () { setRefreshMsg(""); }, 2500);
          }
        }).catch(function (err) {
          setRefreshing(false);
          setRefreshMsg("refresh_err");
          setTimeout(function () { setRefreshMsg(""); }, 3000);
        });
      }

      var q = (query || "").toLowerCase().trim();
      var rows = (props.provRows || []).filter(function (p) {
        // 只显示提供商管理页面已配置的 provider（keyed = 在 config.yaml 中有显式配置）
        if (!p.keyed) return false;
        var hasModels = (p.models || []).length > 0;
        if (!hasModels) return false;
        if (!q) return true;
        return hasModels && (p.models || []).some(function (m) { return m.toLowerCase().indexOf(q) >= 0; });
      }).sort(function (a, b) {
        // P3-2：最新配置的 provider 固定排第 1 位（与提供商管理页一致）。
        if (lastAdded) {
          if (a.slug === lastAdded) return -1;
          if (b.slug === lastAdded) return 1;
        }
        return (a.name || a.slug || "").localeCompare(b.name || b.slug || "");
      });

      var totalOn = 0, totalAll = 0;
      rows.forEach(function (p) {
        (p.models || []).forEach(function (m) {
          totalAll++;
          if (visOn[p.slug + "::" + m]) totalOn++;
        });
      });

      function toggle(slug, model) {
        var key = slug + "::" + model;
        var next = Object.assign({}, visOn);
        next[key] = !next[key]; // flip visible state
        setVisOn(next);
        // Rebuild visibility state. Providers created in default-OFF mode keep
        // their "*" policy; visible models are encoded as explicit exceptions,
        // so models discovered by a later refresh still default to OFF.
        var hiddenByProvider = {};
        Object.keys(rawHidden).forEach(function (slug) {
          var rawList = rawHidden[slug] || [];
          if (rawList.indexOf("*") < 0) return;
          hiddenByProvider[slug] = ["*"];
          rawList.forEach(function (item) {
            if (typeof item !== "string" || item.indexOf("!visible:") !== 0) return;
            var modelId = item.slice("!visible:".length);
            if (!((slug + "::" + modelId) in next)) hiddenByProvider[slug].push(item);
          });
        });
        Object.keys(next).forEach(function (k) {
          var parts = k.split("::");
          var s = parts[0], m = parts.slice(1).join("::");
          var rawList = rawHidden[s] || [];
          if (rawList.indexOf("*") >= 0) {
            hiddenByProvider[s] = hiddenByProvider[s] || ["*"];
            if (next[k]) hiddenByProvider[s].push("!visible:" + m);
          } else if (!next[k]) {
            (hiddenByProvider[s] = hiddenByProvider[s] || []).push(m);
          }
        });
        setSaving(true);
        // Mirror into canonical App state so re-mounting (tab switch) keeps
        // the correct on/off state without a full page refresh.
        if (props.onVisibilityChange) props.onVisibilityChange(hiddenByProvider);
        fetchJSON(API + "/visibility", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: hiddenByProvider })
        }).then(function () {
          setSaving(false);
          // 可见性变更后立即重建 MoA 模型席缓存，使智囊团模型席同步出新开/新隐藏的模型
          if (props.onVisibilitySaved) props.onVisibilitySaved();
        }).catch(function () { setSaving(false); });
      }

      return h("div", null,
        h("div", { className: "dc-section" },
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ".55rem" } },
            h("div", { className: "dc-section-title", style: { margin: 0 } }, T.visTitle),
            h("span", { className: "dc-vis-count" }, T.visOn + " " + totalOn + " " + T.visOf + " " + totalAll)
          ),
          h("p", { style: { margin: "0 0 .7rem", color: "var(--color-muted-foreground)", fontSize: ".82rem" } }, T.visSub),
          h("div", { className: "dc-vis-search-row" },
            h("input", {
              id: "dc-vis-search-input",
              className: "dc-vis-search",
              type: "text",
              placeholder: T.visSearchPh,
              value: query,
              onChange: function (e) { setQuery(e.target.value); }
            }),
            h("button", {
              type: "button",
              className: "dc-btn dc-btn-ghost dc-vis-search-btn",
              "aria-label": T.search,
              title: T.search,
              onClick: function () {
                var el = document.getElementById("dc-vis-search-input");
                if (el) el.focus();
              }
            }, T.search),
            h("button", {
              type: "button",
              className: "dc-btn dc-btn-ghost dc-vis-free-btn",
              "aria-label": "\u514d\u8d39\u6a21\u578b",
              title: "\u70b9\u51fb\u641c\u7d22\u5305\u542b free \u7684\u6a21\u578b",
              onClick: function () { setQuery("free"); }
            }, "\u514d\u8d39\u6a21\u578b"),
            query && h("button", {
              type: "button",
              className: "dc-btn dc-btn-ghost dc-vis-search-btn",
              "aria-label": T.clear,
              title: T.clear,
              onClick: function () { setQuery(""); }
            }, "✕"),
            h("button", {
              type: "button",
              className: "dc-btn dc-btn-ghost dc-vis-refresh-btn" + (isRefreshing ? " dc-vis-refresh-spinning" : "") + (refreshMsg === "refresh_ok" ? " dc-vis-refresh-ok" : "") + (refreshMsg === "refresh_err" ? " dc-vis-refresh-err" : ""),
              "aria-label": isRefreshing ? T.refreshing : T.refresh,
              title: isRefreshing ? T.refreshing : T.refresh,
              disabled: isRefreshing,
              onClick: handleRefresh
            },
              isRefreshing
                ? h("span", { className: "dc-vis-refresh-spinner" }, "⟳")
                : (refreshMsg === "refresh_ok" ? "✓ 已刷新"
                  : (refreshMsg === "refresh_err" ? "✕ 失败"
                    : (refreshMsg === "refresh_empty" ? "⚠ 无变化" : T.refresh)))
            ),
            h("button", {
              type: "button",
              className: "dc-btn dc-btn-secondary dc-vis-proxy-btn",
              "aria-label": T.proxyAddBtn,
              title: T.proxyAddBtn,
              onClick: function () { setShowProxyModal(true); }
            }, T.proxyAddBtn)
          ),
          h("div", { className: "dc-vis-groups" },
            (rows.length === 0 && q)
              ? h("div", { className: "dc-empty", style: { padding: ".9rem .5rem" } }, T.visNoMatch)
              : rows.map(function (pg) {
                  return h(VisibilityGroup, {
                    key: pg.slug,
                    providerGroup: pg,
                    defaultOpen: false,
                    visOn: visOn,
                    searchQuery: query,
                    onToggle: toggle,
                    proxyProviders: proxyProviders,
                    onProxyToggle: toggleProviderProxy
                  });
                })
          )
        ),
      showProxyModal && h(ProxyConfigModal, {
        currentHost: proxyHost,
        currentPort: proxyPort,
        saved: proxySaved,
        error: proxyErr,
        onClose: function (saved) {
          setShowProxyModal(false);
          if (saved) { setProxySaved(true); setTimeout(function () { setProxySaved(false); }, 3000); }
        },
        onSave: function (host, port) {
          setProxyHost(host); setProxyPort(port);
          if (!host || !port) { setProxyErr(T.proxyNoUrl); return; }
          setProxyErr(null);
          fetchJSON(API + "/proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proxy_url: _proxyAddress(host, port), enabled_providers: proxyProviders })
          }).then(function () {
            setProxySaved(true); setProxyErr(null);
            setTimeout(function () { setProxySaved(false); }, 3000);
            setShowProxyModal(false);
          }).catch(function (e) {
            setProxyErr((e && e.message) || String(e));
          });
        }
      })
    );

    // ---- 代理配置弹窗 -------------------------------------------------
    function ProxyConfigModal(props) {
      var hSt = useState(props.currentHost || "");
      var host = hSt[0], setHost = hSt[1];
      var pSt = useState(props.currentPort || "");
      var port = pSt[0], setPort = pSt[1];
      var saving = useState(false);
      var isSaving = saving[0], setSaving = saving[1];
      // ── 代理连通性测试 state ──
      var testingSt = useState(false);
      var isTesting = testingSt[0], setTesting = testingSt[1];
      var testResultSt = useState(null);  // null | "ok" | "fail"
      var testResult = testResultSt[0], setTestResult = testResultSt[1];
      var testMsgSt = useState("");
      var testMsg = testMsgSt[0], setTestMsg = testMsgSt[1];

      function testProxy() {
        var h = (host || "").trim();
        var p = Number(port) || 0;
        if (!h || !p) { setTestResult("fail"); setTestMsg("请填写地址和端口"); return; }
        setTesting(true); setTestResult(null); setTestMsg("");
        fetchJSON(API + "/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test_only: true, test_host: h, test_port: p })
        }).then(function (res) {
          setTesting(false);
          if (res && res.ok) { setTestResult("ok"); setTestMsg(res.message || ""); }
          else { setTestResult("fail"); setTestMsg((res && res.error) || String(res)); }
        }).catch(function (e) {
          setTesting(false);
          setTestResult("fail");
          setTestMsg((e && e.message) || String(e));
        });
      }

      function submit() {
        var h = (host || "").trim();
        var p = Number(port) || 0;
        if (!h || !p) return;
        setSaving(true);
        if (props.onSave) props.onSave(h, p);
      }

      return h("div", { className: "dc-modal-overlay" },
        h("div", { className: "dc-modal dc-proxy-modal", onClick: function (e) { e.stopPropagation(); } },
          h("div", { className: "dc-modal-header" },
            h("div", { className: "dc-modal-title" }, T.proxyModalTitle),
            h("button", { type: "button", className: "dc-modal-close", "aria-label": T.cancel, onClick: function () { if (!isSaving) props.onClose(false); } }, "\u2715")
          ),
          h("div", { className: "dc-modal-body" },
            h("label", { className: "dc-field" },
              h("span", { className: "dc-field-label" }, T.proxyModalHost),
              h("input", { type: "text", value: host, onChange: function (e) { setHost(e.target.value); }, placeholder: T.proxyModalHost })
            ),
            h("label", { className: "dc-field" },
              h("span", { className: "dc-field-label" }, T.proxyModalPort),
              h("input", { type: "number", value: port, min: 1, max: 65535, onChange: function (e) { setPort(e.target.value); }, placeholder: T.proxyModalPort })
            ),
            h("p", { style: { margin: ".5rem 0 0", color: "var(--color-muted-foreground)", fontSize: ".8rem" } }, T.proxyModalNote),
            // 测试结果
            testResult && h("div", {
              style: {
                padding: ".35rem .4rem",
                margin: ".4rem 0 0",
                fontSize: ".82rem",
                borderRadius: "6px",
                background: testResult === "ok" ? "rgba(34,197,94,.1)" : "rgba(239,68,68,.1)",
                color: testResult === "ok" ? "#22c55e" : "#ef4444"
              }
            }, testResult === "ok"
              ? T.proxyTestOk
              : T.proxyTestFail.replace("{msg}", testMsg)
            )
          ),
          props.error && h("div", { className: "dc-inline-err", style: { padding: "0 .4rem" } }, props.error),
          h("div", { className: "dc-modal-footer" },
            h("button", { type: "button", className: "dc-btn dc-btn-ghost", onClick: function () { if (!isSaving) props.onClose(false); } }, T.cancel),
            h("button", {
              type: "button",
              className: "dc-btn dc-btn-secondary" + (testResult === "ok" ? " dc-btn-success" : (testResult === "fail" ? " dc-btn-error" : "")),
              onClick: testProxy,
              disabled: isTesting
            }, isTesting ? T.proxyTesting : (T.proxyTestBtn || "\u6d4b\u8bd5\u4ee3\u7406")),
            h("button", { type: "button", className: "dc-btn dc-btn-primary", onClick: submit, disabled: isSaving },
              isSaving ? "\u4fdd\u5b58\u4e2d\u2026" : (props.saved ? T.proxySavedOk : "\u4fdd\u5b58"))
          )
        )
      );
    }
    }

    // ---- Provider management ---------------------------------------------
    // 添加提供商：独立弹窗（不再在本页内联成行）
    function ProviderAddModal(props) {
      var name = useState("");
      var slug = useState("");
      var url = useState("");
      // keys: array of { api_key, key_env } — at least 1 row
      var keys = useState([{ api_key: "" }]);
      var adding = useState(false);
      var err = useState(null);
      var nm = name[0], setNm = name[1];
      var sl = slug[0], setSl = slug[1];
      var u = url[0], setU = url[1];
      var kList = keys[0], setKeys = keys[1];
      var isAdding = adding[0], setAdding = adding[1];
      var error = err[0], setErr = err[1];

      // Auto-fill base_url when slug matches a known provider (only if user hasn't typed custom URL)
      useEffect(function () {
        if (!u && sl) {
          var defUrl = getDefaultBaseUrl(sl);
          if (defUrl) { setU(defUrl); }
        }
      }, [sl]);

      function addKeyRow() {
        setKeys(kList.concat([{ api_key: "" }]));
      }
      function removeKeyRow(idx) {
        if (kList.length <= 1) return;
        var next = kList.slice();
        next.splice(idx, 1);
        setKeys(next);
      }
      function updateKeyRow(idx, field, val) {
        var next = kList.slice();
        next[idx] = Object.assign({}, next[idx]);
        next[idx][field] = val;
        setKeys(next);
      }

      function submit() {
        var s = (sl || "").trim();
        if (!s) { setErr(T.errSlugRequired); return; }
        setAdding(true); setErr(null);
        fetchJSON(API + "/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: s, name: (nm || "").trim(), base_url: (u || "").trim(), api_key: (kList[0].api_key || "").trim() })
        }).then(function () {
          // After provider created, register extra keys (rows 2..N)
          var extras = kList.slice(1).filter(function (row) {
            return (row.api_key || "").trim();
          });
          if (extras.length === 0) { props.onClose && props.onClose(true); return; }
          var pending = extras.length;
          extras.forEach(function (row, i) {
            fetchJSON(API + "/providers/" + encodeURIComponent(s) + "/keys", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ api_key: (row.api_key || "").trim(), label: ("密钥 " + (i + 2)) })
            }).then(function () {
              pending--;
              if (pending === 0) { setAdding(false); props.onClose && props.onClose(true); }
            }).catch(function () {
              pending--;
              if (pending === 0) { setAdding(false); props.onClose && props.onClose(true); }
            });
          });
        }).catch(function (e) {
          setAdding(false); setErr(String((e && e.message) || e));
        });
      }

      return h("div", { className: "dc-modal-overlay" },
        h("div", { className: "dc-modal", onClick: function (e) { e.stopPropagation(); } },
          h("div", { className: "dc-modal-header" },
            h("div", { className: "dc-modal-title" }, T.provAddTitle),
            h("button", { type: "button", className: "dc-modal-close", "aria-label": T.cancel, onClick: function () { if (!isAdding) props.onClose && props.onClose(false); } }, "✕")
          ),
          h("div", { className: "dc-modal-body" },
            h("label", { className: "dc-field" },
              h("span", { className: "dc-field-label" }, T.provAddNamePh),
              h("input", { type: "text", value: nm, onChange: function (e) { setNm(e.target.value); }, placeholder: T.provAddNamePh })
            ),
            h("label", { className: "dc-field" },
              h("span", { className: "dc-field-label" }, T.provAddSlugPh + " *"),
              h("input", { type: "text", value: sl, onChange: function (e) { setSl(e.target.value); }, placeholder: T.provAddSlugPh })
            ),
            h("label", { className: "dc-field" },
              h("span", { className: "dc-field-label" }, T.provAddUrlPh),
              h("input", { type: "text", value: u, onChange: function (e) { setU(e.target.value); }, placeholder: T.provAddUrlPh }),
              u && h("span", { className: "dc-url-hint" }, T.provUrlHint)
            ),
            // ---- Multi-key rows (same style as dc-field above) ----------
            kList.map(function (row, idx) {
              return h("div", { key: "kr_" + idx, className: "dc-field" },
                idx === 0 && h("span", { className: "dc-field-label" }, T.provAddKeyPh),
                h("div", { style: { display: "flex", gap: ".5rem", alignItems: "center" } },
                  h("input", { type: "text", className: "dc-key-input", value: row.api_key || "", onChange: function (e) { updateKeyRow(idx, "api_key", e.target.value); }, placeholder: row.preview ? ("当前 " + row.preview + "（留空则保留）") : T.provAddKeyPh }),
                  idx > 0 && h("button", { type: "button", className: "dc-btn dc-btn-sm dc-btn-ghost dc-key-row-rm", onClick: function () { removeKeyRow(idx); }, title: T.provRemoveKey }, "\u2212")
                )
              );
            }),
            h("button", { type: "button", className: "dc-btn dc-btn-sm dc-btn-ghost dc-add-key-row-btn", onClick: addKeyRow }, T.provAddAnotherKey)
          ),
          error && h("div", { className: "dc-inline-err", style: { padding: "0 .2rem" } }, error),
          h("div", { className: "dc-modal-footer" },
            h("button", { type: "button", className: "dc-btn dc-btn-ghost", onClick: function () { if (!isAdding) props.onClose && props.onClose(false); } }, T.cancel),
            h("button", { type: "button", className: "dc-btn dc-btn-primary", onClick: submit, disabled: isAdding },
              isAdding ? T.adding : T.provAddBtn)
          )
        )
      );
    }

    // ---- Edit provider modal (prefilled with current config.yaml content) --
    function ProviderEditModal(props) {
      var slug = props.slug;
      var ld = useState(true);
      var isLoading = ld[0], setLoading = ld[1];
      var nmSt = useState("");
      var uSt = useState("");
      var envSt = useState("");
      var nm = nmSt[0], setNm = nmSt[1];
      var u = uSt[0], setU = uSt[1];
      var env = envSt[0], setEnv = envSt[1];
      // keys: array of { api_key, key_env } — row 0 = primary key from config
      var keys = useState([{ api_key: "" }]);
      var saving = useState(false);
      var err = useState(null);
      var isSaving = saving[0], setSaving = saving[1];
      var error = err[0], setErr = err[1];
      var kList = keys[0], setKeys = keys[1];
      // Default URL for this provider (computed once from slug)
      var _defaultUrlForSlug = getDefaultBaseUrl(slug);

      useEffect(function () {
        setLoading(true);
        // Load provider info + existing extra keys in parallel
        Promise.all([
          fetchJSON(API + "/providers/" + encodeURIComponent(slug) + "?reveal=1"),
          fetchJSON(API + "/keys")
        ]).then(function (results) {
          var d = results[0];
          var kd = results[1];
          setNm(d.name || "");
          setU(d.base_url || _defaultUrlForSlug || "");
          setEnv(d.key_env || "");
          // Build kList: row 0 = primary from config.yaml, rows 1..N = extras
          // P3-1：后端现在回显真实 api_key，编辑弹窗直接预填，便于查看/复制/修改。
          // 用户未改动时 dirty=false → 提交发 null，后端保留原密钥；改过则发新值覆盖。
          var initialKeys = [{ api_key: d.api_key || "", preview: d.api_key_preview || "", hasKey: !!d.api_key_preview }];
          var extras = (kd.keys && kd.keys[slug]) || [];
          if (extras.length > 0) {
            extras.forEach(function (ek) {
              // Skip "primary" — it comes from /providers/{slug} as row 0
              if (ek.id === "primary") return;
              initialKeys.push({ api_key: "", preview: ek.api_key_preview || "", hasKey: !!ek.api_key_preview });
            });
          }
          setKeys(initialKeys);
          setLoading(false);
        }).catch(function (e) { setErr(String((e && e.message) || e)); setLoading(false); });
      }, [slug]);

      function addKeyRow() {
        setKeys(kList.concat([{ api_key: "" }]));
      }
      function removeKeyRow(idx) {
        if (kList.length <= 1) return;
        var next = kList.slice();
        next.splice(idx, 1);
        setKeys(next);
      }
      function updateKeyRow(idx, field, val) {
        var next = kList.slice();
        next[idx] = Object.assign({}, next[idx]);
        next[idx][field] = val;
        next[idx].dirty = true;  // 用户改过该密钥框 → 提交时以新值覆盖（P2-4）
        setKeys(next);
      }

      function submit() {
        setSaving(true); setErr(null);
        // Save primary key (row 0) to provider config
        var primaryRow = kList[0] || {};
        // P2-4 替换式：用户改过才用新值覆盖；未改则发 null，后端保留原密钥
        var primaryKey = primaryRow.dirty ? (primaryRow.api_key || "").trim() : null;
        fetchJSON(API + "/providers/" + encodeURIComponent(slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: (nm || "").trim(), base_url: (u || "").trim(), api_key: primaryKey })
        }).then(function () {
          // 仅提交「用户新增/改过」的额外密钥，避免把掩码 preview 当新密钥写入或重复添加
          var extras = kList.slice(1).filter(function (row) {
            return row.dirty && (row.api_key || "").trim();
          });
          if (extras.length === 0) { setSaving(false); props.onClose && props.onClose(true); return; }
          var pending = extras.length;
          extras.forEach(function (row, i) {
            fetchJSON(API + "/providers/" + encodeURIComponent(slug) + "/keys", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ api_key: (row.api_key || "").trim(), label: ("密钥 " + (i + 2)) })
            }).then(function () {
              pending--;
              if (pending === 0) { setSaving(false); props.onClose && props.onClose(true); }
            }).catch(function () {
              pending--;
              if (pending === 0) { setSaving(false); props.onClose && props.onClose(true); }
            });
          });
        }).catch(function (e) {
          setSaving(false); setErr(String((e && e.message) || e));
        });
      }

      return h("div", { className: "dc-modal-overlay" },
        h("div", { className: "dc-modal", onClick: function (e) { e.stopPropagation(); } },
          h("div", { className: "dc-modal-header" },
            h("div", { className: "dc-modal-title" }, T.provEditTitle + " · " + slug),
            h("button", { type: "button", className: "dc-modal-close", "aria-label": T.cancel, onClick: function () { if (!isSaving) props.onClose && props.onClose(false); } }, "✕")
          ),
          h("div", { className: "dc-modal-body" },
            isLoading
              ? h("div", { className: "dc-inline-err" }, "加载中…")
              : [
                h("label", { key: "en", className: "dc-field" },
                  h("span", { className: "dc-field-label" }, T.provEditNamePh),
                  h("input", { type: "text", value: nm, onChange: function (e) { setNm(e.target.value); }, placeholder: T.provEditNamePh })
                ),
                h("label", { key: "eu", className: "dc-field" },
                  h("span", { className: "dc-field-label" }, T.provEditUrlPh),
                  h("input", { type: "text", value: u, onChange: function (e) { setU(e.target.value); }, placeholder: T.provEditUrlPh }),
                  u && h("span", { className: "dc-url-hint" }, T.provUrlHint)
                ),
                // ---- Multi-key rows (same style as dc-field above) ----
              ].concat(kList.map(function (row, idx) {
                return h("div", { key: "ekr_" + idx, className: "dc-field" },
                  idx === 0 && h("span", { className: "dc-field-label" }, T.provEditKeyPh),
                  h("div", { style: { display: "flex", gap: ".5rem", alignItems: "center" } },
                    h("input", { type: "text", className: "dc-key-input", value: row.api_key || "", onChange: function (e) { updateKeyRow(idx, "api_key", e.target.value); }, placeholder: T.provEditKeyPh }),
                    idx > 0 && h("button", { type: "button", className: "dc-btn dc-btn-sm dc-btn-ghost dc-key-row-rm", onClick: function () { removeKeyRow(idx); }, title: T.provRemoveKey }, "\u2212")
                  )
                );
              })).concat([
                h("button", { key: "eak", type: "button", className: "dc-btn dc-btn-sm dc-btn-ghost dc-add-key-row-btn", onClick: addKeyRow }, T.provEditAnotherKey)
              ])
          ),
          error && h("div", { className: "dc-inline-err", style: { padding: "0 .2rem" } }, error),
          h("div", { className: "dc-modal-footer" },
            h("button", { type: "button", className: "dc-btn dc-btn-ghost", onClick: function () { if (!isSaving) props.onClose && props.onClose(false); } }, T.cancel),
            h("button", { type: "button", className: "dc-btn dc-btn-primary", onClick: submit, disabled: isSaving || isLoading },
              isSaving ? T.btnSaving : T.provEditSave)
          )
        )
      );
    }

    // ---- Per-provider extra keys modal (list / add / delete) ---------------
    function ProviderKeysModal(props) {
      var slug = props.slug;
      var ld = useState(true);
      var isLoading = ld[0], setLoading = ld[1];
      var keys = useState([]);
      var kList = keys[0], setKeys = keys[1];
      var label = useState("");
      var env = useState("");
      var val = useState("");
      var adding = useState(false);
      var err = useState(null);
      var isAdding = adding[0], setAdding = adding[1];
      var error = err[0], setErr = err[1];

      function reload() {
        setLoading(true);
        fetchJSON(API + "/keys?provider=" + encodeURIComponent(slug))
          .then(function (r) {
            setKeys((r.keys && r.keys[slug]) || []);
            setLoading(false);
          })
          .catch(function (e) { setErr(String((e && e.message) || e)); setLoading(false); });
      }
      useEffect(function () { reload(); }, [slug]);

      function addKey() {
        var lv = (label[0] || "").trim();
        var ev = (env[0] || "").trim();
        var vv = (val[0] || "").trim();
        if (!ev && !vv) { setErr("key_env 或 api_key 至少填一项"); return; }
        setAdding(true); setErr(null);
        fetchJSON(API + "/providers/" + encodeURIComponent(slug) + "/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key_env: ev, api_key: vv, label: lv })
        }).then(function () {
          setAdding(false);
          setLabel(""); setEnv(""); setVal("");
          reload();
          props.onChanged && props.onChanged();
        }).catch(function (e) {
          setAdding(false); setErr(String((e && e.message) || e));
        });
      }

      function delKey(idx, id) {
        if (id === "primary") return;
        fetchJSON(API + "/providers/" + encodeURIComponent(slug) + "/keys/" + idx, { method: "DELETE" })
          .then(function () { reload(); props.onChanged && props.onChanged(); })
          .catch(function () { reload(); });
      }

      return h("div", { className: "dc-modal-overlay" },
        h("div", { className: "dc-modal", onClick: function (e) { e.stopPropagation(); } },
          h("div", { className: "dc-modal-header" },
            h("div", { className: "dc-modal-title" }, T.provKeyTitle + " · " + slug),
            h("button", { type: "button", className: "dc-modal-close", "aria-label": T.cancel, onClick: function () { if (!isAdding) props.onClose && props.onClose(false); } }, "✕")
          ),
          h("div", { className: "dc-modal-body" },
            isLoading
              ? h("div", { className: "dc-inline-err" }, "加载中…")
              : h("div", null,
                h("div", { className: "dc-keys-list-title" }, T.provKeysListTitle),
                kList.length === 0
                  ? h("div", { className: "dc-keys-empty" }, T.provNoKeys)
                  : h("div", { className: "dc-keys-list" },
                    kList.map(function (kObj) {
                      var id = kObj.id;
                      var deletable = id !== "primary";
                      var idx = id === "primary" ? -1 : parseInt(String(id).replace("k_", ""), 10);
                      var lbl = kObj.label || kObj.key_env || kObj.api_key_preview || id;
                      var sub = [];
                      if (kObj.key_env) sub.push(kObj.key_env);
                      if (kObj.api_key_preview) sub.push(kObj.api_key_preview);
                      return h("div", { key: id, className: "dc-key-item" },
                        h("div", { className: "dc-key-item-main" },
                          h("div", { className: "dc-key-item-label" }, lbl),
                          sub.length ? h("div", { className: "dc-key-item-sub" }, sub.join("  ·  ")) : null
                        ),
                        deletable && h("button", { className: "dc-btn dc-btn-sm dc-btn-danger", onClick: function () { delKey(idx, id); } }, T.provKeyRemoveBtn)
                      );
                    })
                  ),
                h("div", { className: "dc-keys-add" },
                  h("div", { className: "dc-keys-add-title" }, "+ " + T.provAddKeyBtn),
                  h("label", { className: "dc-field" },
                    h("span", { className: "dc-field-label" }, T.provKeyNamePh),
                    h("input", { type: "text", value: label[0], onChange: function (e) { setLabel(e.target.value); }, placeholder: T.provKeyNamePh })
                  ),
                  h("label", { className: "dc-field" },
                    h("span", { className: "dc-field-label" }, T.provKeyEnvPh),
                    h("input", { type: "text", value: env[0], onChange: function (e) { setEnv(e.target.value); }, placeholder: T.provKeyEnvPh })
                  ),
                  h("label", { className: "dc-field" },
                    h("span", { className: "dc-field-label" }, T.provKeyValuePh),
                    h("input", { type: "text", value: val[0], onChange: function (e) { setVal(e.target.value); }, placeholder: T.provKeyValuePh })
                  )
                )
              )
          ),
          error && h("div", { className: "dc-inline-err", style: { padding: "0 .2rem" } }, error),
          h("div", { className: "dc-modal-footer" },
            h("button", { type: "button", className: "dc-btn dc-btn-ghost", onClick: function () { if (!isAdding) props.onClose && props.onClose(false); } }, T.cancel),
            h("button", { type: "button", className: "dc-btn dc-btn-primary", onClick: addKey, disabled: isAdding },
              isAdding ? T.adding : T.provAddKeyBtn)
          )
        )
      );
    }

    // ---- Provider card (row + edit / add-key actions) ----------------------
    function ProviderCard(props) {
      var pg = props.pg;
      var disabled = props.disabledSet || {};
      var configured = props.configuredSet || {};
      var keyed = props.keyedSet || {};
      var isDisabled = !!disabled[pg.slug];
      var isConf = !!configured[pg.slug];          // 在 config.yaml 中显式配置
      var isEnvAuth = !!pg.authenticated && !isConf; // 经环境变量自动发现（非 config.yaml）
      var showEdit = useState(false);
      var editOpen = showEdit[0], setEditOpen = showEdit[1];

      function toggleDisabled() {
        var next = !isDisabled;
        fetchJSON(API + "/providers/" + encodeURIComponent(pg.slug), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: next })
        }).then(function () { props.onChanged(); }).catch(function () { props.onChanged(); });
      }
      function removeProvider() {
        if (!window.confirm('确定要移除提供商 "' + pg.slug + '" 吗？\n\n此操作不可撤销。')) return;
        fetchJSON(API + "/providers/" + encodeURIComponent(pg.slug), { method: "DELETE" })
          .then(function () { props.onChanged(); }).catch(function () { props.onChanged(); });
      }

      return h("div", { key: pg.slug, className: cn("dc-prov-row", isDisabled && "disabled") },
        h("span", { className: cn("dc-prov-row-icon", pg.authenticated ? "dc-prov-authed" : "dc-prov-unauth") }, providerIcon(pg.slug)),
        h("div", { className: "dc-prov-row-info" },
          h("div", { className: "dc-prov-row-name" }, pg.name || pg.slug),
          h("div", { className: "dc-prov-row-slug" }, pg.slug)
        ),
        h("div", { className: "dc-prov-row-badges" },
          isConf && Badge(T.configured, "accent"),
          isEnvAuth && Badge("环境变量", "muted")
        ),
        h("div", { className: "dc-prov-row-actions" },
          h("button", { className: "dc-btn dc-btn-sm", onClick: function () { setEditOpen(true); } }, T.provEditBtn),
          h("button", { className: cn("dc-btn dc-btn-sm", isDisabled ? "dc-btn-primary" : ""), onClick: toggleDisabled }, isDisabled ? T.provEnableBtn : T.provDisableBtn),
          isConf && h("button", { className: "dc-btn dc-btn-sm dc-btn-danger", onClick: removeProvider }, T.provRemoveBtn)
        ),
        editOpen && h(ProviderEditModal, { slug: pg.slug, onClose: function (ok) { setEditOpen(false); if (ok) props.onChanged(); } })
      );
    }

    function ProviderManagementSection(props) {
      var modal = useState(false);
      var modalOpen = modal[0], setModalOpen = modal[1];
      var disabled = props.disabledSet || {};
      var activeCount = (props.provRows || []).filter(function (p) { return !disabled[p.slug]; }).length;

      return h("div", null,
        h("div", { className: "dc-section" },
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ".55rem" } },
            h("div", { className: "dc-section-title", style: { margin: 0 } }, T.provTitle),
            h("div", { style: { display: "flex", alignItems: "center", gap: ".5rem" } },
              h("button", { className: "dc-btn dc-btn-primary dc-btn-sm", onClick: function () { setModalOpen(true); } }, "+ " + T.provAddBtn),
              h("span", { className: "dc-vis-count" }, T.provActiveCount + " " + activeCount + " " + T.provTotalCount + " " + (props.provRows || []).length)
            )
          ),
          h("p", { style: { margin: "0 0 .85rem", color: "var(--color-muted-foreground)", fontSize: ".82rem" } }, T.provSub),

          h("div", { className: "dc-prov-list" },
            (props.provRows || []).map(function (pg) {
              return h(ProviderCard, {
                key: pg.slug, pg: pg,
                disabledSet: props.disabledSet, configuredSet: props.configuredSet, keyedSet: props.keyedSet,
                onChanged: props.onChanged
              });
            }),
            modalOpen && h(ProviderAddModal, {
              onClose: function (ok) { setModalOpen(false); if (ok) props.onChanged(); }
            })
          ),
          h("div", { className: "dc-prov-legend" },
            h("span", { className: "dc-prov-legend-item" },
              h("span", { className: "dc-prov-legend-icon dc-prov-authed" }),
              T.authenticated
            ),
            h("span", { className: "dc-prov-legend-item" },
              h("span", { className: "dc-prov-legend-icon dc-prov-unauth" }),
              T.unauth
            )
          )
        )
      );
    }

    // ---- MoA / 智囊团 section --------------------------------------------
    // 真实模型列表由 GET /api/plugins/decuria/moa/models 提供（见 MoASection
    // 内的加载逻辑），圆桌编排结果经 PUT /api/model/moa 写入 Hermes config。

    function MoAModelCard(props) {
      var m = props.model;
      var idx = props.index ?? 0;
      var selected = props.selected || false;
      // 拖放悬停时的临时边框（拖拽过程中）
      var orchHover = props.isOrchHover || false;
      var expertHover = props.isExpertHover || false;
      // 放置后的持久边框（已放在右边席位上）
      var isOrchestrator = props.isOrchestrator || false;
      var isExpert = props.isExpert || false;
      // 该模型占用的专家席位序号(0-based)；非专家时为 undefined
      var expertIndex = props.expertIndex;
      var icon = providerIcon(m.provider);
      // 角标仅在「已放入圆桌」时显示：指挥→皇冠，专家→臭皮匠序号(1/2/3…)
      var showBadge = isOrchestrator || isExpert;
      var badgeContent = isOrchestrator
        ? h("span", { className: "dc-moa-card-crown" }, "\uD83D\uDC51") // 👑 指挥（与右侧编排器一致）
        : h("span", { className: "dc-moa-rank-num" },
            String(expertIndex != null ? expertIndex + 1 : (idx + 1))); // 臭皮匠序号
      return h("div", {
        className: cn(
          "dc-moa-model-card",
          selected && "selected",
          // 持久边框优先于悬停边框（放下后保持）
          isOrchestrator && "orch",
          !isOrchestrator && isExpert && "expert",
          // 拖放过程中尚未放置时显示悬停边框
          !isOrchestrator && !isExpert && orchHover && "orch",
          !isOrchestrator && !isExpert && expertHover && "expert"
        ),
        draggable: true,
        onDragStart: function (e) {
          e.dataTransfer.setData("model", JSON.stringify({ provider: m.provider, id: m.id, name: m.name }));
          e.dataTransfer.effectAllowed = "copy";
          if (props.onDragStart) props.onDragStart(m);
        },
        onClick: function () { if (props.onSelect) props.onSelect(m); }
      },
        h("div", { className: "dc-moa-card-icon-circle" }, icon),
        h("div", { className: "dc-moa-card-text" },
          h("div", { className: "dc-moa-card-name" }, m.name),
          h("div", { className: "dc-moa-card-provider" }, m.provider)
        ),
        // 右侧角标：仅「已拖入圆桌」才显示 —— 指挥👑 / 臭皮匠序号
        showBadge && h("div", { className: "dc-moa-card-rank-badge" }, badgeContent)
      );
    }

    function MoASection(props) {
      var _fs = props && props.fullscreen; // 全屏模式标记
      var search = useState("");
      var query = search[0], setQuery = search[1];
      var sortMode = useState("all");
      var sort = sortMode[0], setSort = sortMode[1];
      var selectedModel = useState(null);
      var selModel = selectedModel[0], setSelModel = selectedModel[1];

      // 聊天内容容器引用，用于自动滚动到底部（最新消息在最下面）
      var chatBodyEl = null;

      // MoA state: 3 expert slots + 1 orchestrator
      var moaState = useState({
        experts: [null, null, null],
        orchestrator: null
      });
      var moa = moaState[0], setMoa = moaState[1];
      var dragOverSlot = useState(null);
      var dragOver = dragOverSlot[0], setDragOver = dragOverSlot[1];
      // 拖放边框反馈：追踪正在拖的模型 + 悬停目标（"orch" | expert-index | null）
      var draggedModelSt = useState(null);
      var draggedModel = draggedModelSt[0], setDraggedModel = draggedModelSt[1];
      var dragOverTargetSt = useState(null);
      var dragOverTarget = dragOverTargetSt[0], setDragOverTarget = dragOverTargetSt[1];
      var copied = useState(false);
      var isCopied = copied[0], setCopied = copied[1];

      // 真实模型列表（来自 /moa/models）+ 加载/应用状态
      var moaModelsSt = useState({ loading: true, error: null, providers: [] });
      var moaModels = moaModelsSt[0], setMoaModels = moaModelsSt[1];
      var byKeySt = useState({});
      var modelByKey = byKeySt[0], setModelByKey = byKeySt[1];
      var applySt = useState({ applying: false, applied: false, error: null });
      var applyState = applySt[0], setApplyState = applySt[1];
      // 完整 MoA 配置（含所有 presets），保存时合并而非整体覆盖
      var moaFullSt = useState(null);
      var moaFull = moaFullSt[0], setMoaFull = moaFullSt[1];
      // 模型用量统计（从 state.db 聚合的 token 用量）
      var moaUsageSt = useState({ models: {}, total_models: 0, grand_total: { input_tokens: 0, output_tokens: 0, total_tokens: 0, session_count: 0 } });
      var moaUsage = moaUsageSt[0], setMoaUsage = moaUsageSt[1];

      // ── 多预设 (Preset) 管理状态 ──
      var activePresetSt = useState("default");
      var activePreset = activePresetSt[0], setActivePreset = activePresetSt[1];
      var newPresetNameSt = useState("");
      var newPresetName = newPresetNameSt[0], setNewPresetName = newPresetNameSt[1];
      var showAddPresetSt = useState(false);
      var showAddPreset = showAddPresetSt[0], setShowAddPreset = showAddPresetSt[1];
      // 辩论轮次（debate rounds）：开启后专家互相看到前一轮意见并迭代
      var debateOnSt = useState(false);
      var debateOn = debateOnSt[0], setDebateOn = debateOnSt[1];
      // 辩论轮次：多轮辩证固定使用上限轮次，由 auto_stop 在达成共识时自动收尾，无需用户设置。
      var debateRounds = 5;
      // 高共识提前结束：多轮辩证默认开启，讨论达成一致即自动回复，无需用户开关。
      var debateAutoStop = true;
      var benchRefreshingSt = useState(false);
      var benchRefreshing = benchRefreshingSt[0], setBenchRefreshing = benchRefreshingSt[1];

      // ── 智囊团聊天（插件自有核心层，按组合方案持久化）──
      var moaChatSt = useState({ loading: false, sessions: [], current: null, running: false, error: null, input: "" });
      var moaChat = moaChatSt[0], setMoaChat = moaChatSt[1];
      // 全量会话详情（sessionId → detail），用于连续聊天流渲染
      var moaAllDetailsSt = useState({});
      var moaAllDetails = moaAllDetailsSt[0], setMoaAllDetails = moaAllDetailsSt[1];
      // 全屏模式
      var chatFsSt = useState(false);
      var chatFullscreen = chatFsSt[0], setChatFullscreen = chatFsSt[1];

      function flattenModels(providers) {
        var list = [];
        (providers || []).forEach(function (p) {
          (p.models || []).forEach(function (m) {
            list.push({
              id: m.id,
              name: m.name || m.id,
              provider: p.slug,
              providerName: p.name || p.slug,
              context: m.context || null
            });
          });
        });
        return list;
      }

      function slotFromConfig(slot, map) {
        var hit = map[(slot.provider || "") + "|" + (slot.model || "")];
        if (hit) {
          var o = Object.assign({}, hit); // 使用完整模型元数据（含 id/context/providerName）
          if (slot.role) o.role = slot.role;
          return o;
        }
        return {
          provider: slot.provider,
          model: slot.model,
          name: slot.model,
          id: slot.model,
          role: slot.role
        };
      }

      // ── 将指定预设的配置填充到圆桌 UI ──
      function loadPresetIntoUI(fullCfg, presetName) {
        if (!fullCfg || !fullCfg.presets || !fullCfg.presets[presetName]) return;
        var ps = fullCfg.presets[presetName];
        var refs = (ps.reference_models || []).map(function (r) { return slotFromConfig(r, modelByKey); });
        var orch = ps.aggregator ? slotFromConfig(ps.aggregator, modelByKey) : null;
        var dr = ps.debate_rounds || 1;
        setMoa({
          orchestrator: orch,
          // 动态专家数：用预设里真实的 reference_models 数量（至少为 3 个空位）
          experts: refs.length ? refs.slice() : [null, null, null]
        });
        setDebateOn(dr > 1);
      }

      // ── 切换当前编辑的预设 ──
      function switchPreset(name) {
        setActivePreset(name);
        loadPresetIntoUI(moaFull, name);
        // 让所选方案成为运行时当前方案（/moa 与智囊团触发会用到它）
        var full = moaFull || {};
        var updated = Object.assign({}, full, { active_preset: name });
        savePresetsToBackend(updated);
        // 切换组合方案后，同步刷新该方案的智囊团聊天
        loadMoaChats(name);
      }

      // ── 获取所有预设名称列表 ──
      function getPresetNames() {
        if (!moaFull || !moaFull.presets) return [];
        return Object.keys(moaFull.presets);
      }

      // ── 添加新预设 ──
      function addPreset() {
        var name = (newPresetName || "").trim();
        if (!name) return;
        var existing = getPresetNames();
        if (existing.indexOf(name) >= 0) { setApplyState({ applying: false, applied: false, error: "预设名已存在: " + name }); return; }
        var full = moaFull || {};
        var presets = full.presets ? Object.assign({}, full.presets) : {};
        presets[name] = { enabled: true, reference_models: [], aggregator: { provider: "", model: "" }, max_tokens: 4096 };
        var updated = Object.assign({}, full, { presets: presets });
        setMoaFull(updated);
        setActivePreset(name);
        setMoa({ orchestrator: null, experts: [null, null, null] });
        saveOrchestratorState(null, [null, null, null]);
        setNewPresetName("");
        setShowAddPreset(false);
        // 立即持久化新预设（空配置）
        savePresetsToBackend(updated);
        // 新方案暂时没有聊天，清空聊天区
        loadMoaChats(name);
      }

      // ── 删除当前预设 ──
      function deleteCurrentPreset() {
        var names = getPresetNames();
        if (names.length <= 1) { setApplyState({ applying: false, applied: false, error: "至少保留一个预设" }); return; }
        var current = activePreset;
        var remaining = names.filter(function (n) { return n !== current; });
        var next = remaining[0];
        var full = moaFull || {};
        var presets = Object.assign({}, full.presets);
        delete presets[current];
        var updated = Object.assign({}, full, {
          presets: presets,
          default_preset: full.default_preset === current ? next : full.default_preset,
          active_preset: full.active_preset === current ? "" : full.active_preset
        });
        setMoaFull(updated);
        setActivePreset(next);
        loadPresetIntoUI(updated, next);
        savePresetsToBackend(updated);
        // 切换到剩余方案后刷新其聊天
        loadMoaChats(next);
      }

      // ── 设为默认预设 ──
      function setAsDefault() {
        var full = moaFull || {};
        var updated = Object.assign({}, full, { default_preset: activePreset });
        setMoaFull(updated);
        savePresetsToBackend(updated);
      }

      // ── 保存预设列表到后端（不改变圆桌内容）──
      function savePresetsToBackend(fullCfg) {
        var payload = {
          default_preset: fullCfg.default_preset || "default",
          active_preset: fullCfg.active_preset || fullCfg.default_preset || "default",
          presets: fullCfg.presets || {}
        };
        fetchJSON("/api/model/moa", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (resp) {
          setMoaFull(resp || fullCfg);
        }).catch(function () {});
      }

      // ── 自动保存当前圆桌编排到后端（拖拽/移除/指挥变更时调用）──
      function autoSaveCurrentPreset(orch, exps, debateOverride) {
        var full = moaFull || {};
        var presets = full.presets ? Object.assign({}, full.presets) : {};
        var pname = activePreset || full.active_preset || full.default_preset || "default";
        var existing = presets[pname] || {};
        var override = debateOverride || {};
        var enabled = Object.prototype.hasOwnProperty.call(override, "debate_enabled") ? !!override.debate_enabled : debateOn;
        var roundsValue = Object.prototype.hasOwnProperty.call(override, "debate_rounds") ? override.debate_rounds : debateRounds;
        var savedRounds = enabled ? Math.max(2, Math.min(5, roundsValue | 0)) : 1;
        // Build reference_models from expert slots (skip null/empty)
        var refs = (exps || []).filter(Boolean).map(function (e) {
          var o = { provider: e.provider, model: e.model };
          if (e.role) o.role = e.role;
          return o;
        });
        presets[pname] = Object.assign({}, existing, {
          reference_models: refs,
          aggregator: orch ? { provider: orch.provider, model: orch.model } : (existing.aggregator || null),
          // 单轮会商始终写 1，不能沿用 preset 中旧的多轮值。
          debate_rounds: savedRounds,
          enabled: true
        });
        var updated = Object.assign({}, full, {
          default_preset: full.default_preset || "default",
          active_preset: full.active_preset || pname,
          presets: presets
        });
        savePresetsToBackend(updated);
      }

      // ── 保存编排器状态到插件私有文件（拖拽/移除/指挥变更时调用）──
      // 这是圆桌 UI 状态的「唯一真相源」，刷新页面后从此恢复，不再依赖 Hermes MoA preset。
      // 未传 override 时保留当前辩证状态，避免拖放/移除模型意外重置控制项。
      function saveOrchestratorState(orch, exps, debateOverride) {
        var override = debateOverride || {};
        var enabled = Object.prototype.hasOwnProperty.call(override, "debate_enabled") ? !!override.debate_enabled : debateOn;
        var roundsValue = Object.prototype.hasOwnProperty.call(override, "debate_rounds") ? override.debate_rounds : debateRounds;
        var autoStop = Object.prototype.hasOwnProperty.call(override, "debate_auto_stop") ? !!override.debate_auto_stop : debateAutoStop;
        var payload = {
          orchestrator: orch ? { provider: orch.provider, model: orch.model, name: orch.name || orch.model } : null,
          experts: (exps || []).map(function (e) {
            var o = e ? { provider: e.provider, model: e.model, name: e.name || e.model } : null;
            if (o && e.role) o.role = e.role;
            return o;
          }),
          debate_enabled: enabled,
          debate_rounds: enabled ? Math.max(2, Math.min(5, roundsValue | 0)) : 1,
          debate_auto_stop: autoStop
        };
        fetchJSON(API + "/orchestrator", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(function () {});
      }

      // ── 智囊团聊天：加载某组合方案的全部会话 + 全量详情（连续聊天流）──
      function loadMoaChats(preset) {
        var pid = preset || activePreset || "default";
        // 1) 先秒显缓存（切回标签页时不再空白闪烁）
        var cached = _moaChatsCache[pid];
        if (cached && cached.sessions) {
          var _latest = cached.sessions.length ? (cached.details[cached.sessions[cached.sessions.length - 1].session_id] || null) : null;
          setMoaAllDetails(cached.details || {});
          setMoaChat({ loading: false, sessions: cached.sessions, current: _latest, running: false, error: null, input: "" });
        } else {
          setMoaChat(function (s) { return Object.assign({}, s, { loading: true }); });
        }

        // 2) 并发去重：同一预设正在加载则复用同一 Promise，避免重复请求
        if (_moaChatsLoading[pid]) return _moaChatsLoading[pid];

        // 3) 后台刷新（缓存已先显示，这里拉最新数据覆盖）
        var p = fetchJSON("/api/plugins/decuria/moa/chats?preset=" + encodeURIComponent(pid), { method: "GET" })
          .then(function (resp) {
            var sessions = (resp && resp.sessions) || [];
            // 前端兜底：强制按 created_at 升序，最新会话排在最后（底部），配合聊天区自动滚到底部
            sessions = sessions.slice().sort(function (a, b) { return (a.created_at || 0) - (b.created_at || 0); });
            if (!sessions.length) {
              _moaChatsCache[pid] = { sessions: [], details: {} };
              setMoaChat({ loading: false, sessions: [], current: null, running: false, error: null, input: "" });
              return;
            }
            // 并行加载全部会话详情
            var detailPs = sessions.map(function (s) {
              return loadMoaChatDetail(s.session_id).catch(function () { return null; });
            });
            return Promise.all(detailPs).then(function (details) {
              var detailMap = {};
              sessions.forEach(function (s, i) { if (details[i]) detailMap[s.session_id] = details[i]; });
              _moaChatsCache[pid] = { sessions: sessions, details: detailMap };
              setMoaAllDetails(detailMap);
              // current 仍指向最新一条（升序后最新在数组末尾，用于 runMoaChat 后追加定位）
              var latestId = sessions[sessions.length - 1].session_id;
              setMoaChat({ loading: false, sessions: sessions, current: detailMap[latestId] || null, running: false, error: null, input: "" });
            }).catch(function () {
              // 详情部分失败时仍显示列表
              _moaChatsCache[pid] = { sessions: sessions, details: {} };
              setMoaChat({ loading: false, sessions: sessions, current: null, running: false, error: null, input: "" });
            });
          })
          .catch(function (e) {
            // 缓存命中时不覆盖为错误态（保留已显示的缓存），仅未缓存时才报错
            if (!cached) setMoaChat(function (s) { return Object.assign({}, s, { loading: false, error: String(e) }); });
          })
          .then(function () { delete _moaChatsLoading[pid]; }, function () { delete _moaChatsLoading[pid]; });
        _moaChatsLoading[pid] = p;
        return p;
      }

      function loadMoaChatDetail(sessionId) {
        return fetchJSON("/api/plugins/decuria/moa/chats/" + encodeURIComponent(sessionId), { method: "GET" });
      }

      // ── 运行一次智囊团讨论（插件核心层执行并持久化）──
      function runMoaChat() {
        var prompt = (moaChat.input || "").trim();
        if (!prompt || moaChat.running) return;
        // 发送消息后失效缓存，确保后续刷新拉到最新会话（而非陈旧缓存）
        delete _moaChatsCache[activePreset || "default"];
        if (_moaChatsLoading[activePreset || "default"]) delete _moaChatsLoading[activePreset || "default"];
        // 发送即清空输入框（本地 prompt 已捕获，不等 API 返回），避免用户误以为没发出去
        setMoaChat(function (s) { return Object.assign({}, s, { running: true, error: null, input: "" }); });
        // ── 从圆桌编排器取实际运行时模型（优先于 config.yaml preset）──
        // 兼容 model / name 两种字段名（orchestrator_state.json 存 name）
        var activeExperts = (moa.experts || []).filter(Boolean).map(function (e) { return Object.assign({}, e, { model: e.model || e.name }); });
        var activeOrch = moa.orchestrator ? Object.assign({}, moa.orchestrator, { model: moa.orchestrator.model || moa.orchestrator.name }) : null;
        var hasRuntimeModels = activeOrch && activeExperts.length > 0;
        var reqBody = { preset_id: activePreset || "default", prompt: prompt, debate: debateOn, debate_rounds: debateOn ? Math.max(2, Math.min(5, debateRounds | 0)) : 1, auto_stop: debateAutoStop };
        if (hasRuntimeModels) {
          reqBody.reference_models_override = activeExperts.map(function (e) { var o = { provider: e.provider, model: e.model }; if (e.role) o.role = e.role; return o; });
          reqBody.aggregator_override = { provider: activeOrch.provider, model: activeOrch.model };
        }
        fetchJSON("/api/plugins/decuria/moa/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody)
        })
          .then(function (resp) {
            var newId = resp && resp.session_id;
            if (!newId) return loadMoaChats(activePreset || "default");
            // 直接展开刚创建的新会话，并刷新会话列表（用于顶部 tab）
            return loadMoaChatDetail(newId)
              .then(function (detail) {
                return fetchJSON("/api/plugins/decuria/moa/chats?preset=" + encodeURIComponent(activePreset || "default"), { method: "GET" })
                  .then(function (listResp) {
                    // 与 loadMoaChats 保持一致（升序：最新在底部，自动滚动到底显示最新）
                    var updatedSessions = ((listResp && listResp.sessions) || []).slice().sort(function (a, b) { return (a.created_at || 0) - (b.created_at || 0); });
                    // 把新会话详情插入全量 map
                    var merged = Object.assign({}, moaAllDetails);
                    if (detail) merged[newId] = detail;
                    setMoaAllDetails(merged);
                    setMoaChat({ loading: false, sessions: updatedSessions, current: detail, running: false, error: null, input: "" });
                  }, function () {
                    var merged = Object.assign({}, moaAllDetails);
                    if (detail) merged[newId] = detail;
                    setMoaAllDetails(merged);
                    setMoaChat({ loading: false, sessions: [], current: detail, running: false, error: null, input: "" });
                  });
              })
              .catch(function () { return loadMoaChats(activePreset || "default"); });
          })
          .catch(function (e) {
            setMoaChat(function (s) { return Object.assign({}, s, { running: false, error: String(e) }); });
          })
          // 安全网：确保 running 一定被清除（防止某条 Promise 链静默失败导致 UI 卡在「讨论中」）
          .then(function () { setMoaChat(function (s) { return s.running ? Object.assign({}, s, { running: false }) : s; }); })
          .catch(function () {});
      }

      // ── 极简 Markdown → React 节点（不使用 dangerouslySetInnerHTML，防 XSS）──
      function renderMd(md) {
        if (!md) return null;
        var lines = String(md).split("\n");
        var out = [];
        var listBuf = null, listOrdered = false;
        function flushList() {
          if (listBuf) { out.push(h(listOrdered ? "ol" : "ul", { className: "dc-md-list" }, listBuf)); listBuf = null; }
        }
        function inline(t) {
          var parts = [], regex = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g, last = 0, m;
          while ((m = regex.exec(t)) !== null) {
            if (m.index > last) parts.push(t.slice(last, m.index));
            if (m[2] !== undefined) parts.push(h("strong", null, m[2]));
            else if (m[3] !== undefined) parts.push(h("em", null, m[3]));
            else if (m[4] !== undefined) parts.push(h("code", { className: "dc-md-code" }, m[4]));
            last = m.index + m[0].length;
          }
          if (last < t.length) parts.push(t.slice(last));
          return parts.length ? parts : [t];
        }
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (/^\s*[-*]\s+/.test(line)) {
            if (!listBuf || listOrdered) { flushList(); listBuf = []; listOrdered = false; }
            listBuf.push(h("li", null, inline(line.replace(/^\s*[-*]\s+/, ""))));
            continue;
          }
          if (/^\s*\d+\.\s+/.test(line)) {
            if (!listBuf || !listOrdered) { flushList(); listBuf = []; listOrdered = true; }
            listBuf.push(h("li", null, inline(line.replace(/^\s*\d+\.\s+/, ""))));
            continue;
          }
          flushList();
          if (/^###\s+/.test(line)) out.push(h("h3", { className: "dc-md-h3" }, inline(line.replace(/^###\s+/, ""))));
          else if (/^##\s+/.test(line)) out.push(h("h2", { className: "dc-md-h2" }, inline(line.replace(/^##\s+/, ""))));
          else if (/^#\s+/.test(line)) out.push(h("h1", { className: "dc-md-h1" }, inline(line.replace(/^#\s+/, ""))));
          else if (line.trim() !== "") out.push(h("p", { className: "dc-md-p" }, inline(line)));
        }
        flushList();
        return out;
      }
      // 复制纯文本到剪贴板
      function copyTextToClipboard(text, btn) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            if (btn) { btn.classList.add("copied"); setTimeout(function () { btn.classList.remove("copied"); }, 1500); }
          }).catch(function () {});
        }
      }
      // 把一轮 MoA 讨论拼成可复制文本
      function moaTurnToText(turn) {
        var lines = [];
        (turn.references || []).forEach(function (ref, i) {
          lines.push("专家 " + (i + 1) + " (" + (ref.provider || "") + "/" + (ref.model || "?") + "):\n" + (ref.content || ""));
        });
        var agg = turn.aggregator || {};
        if (agg.content) lines.push("指挥综合 (" + (agg.provider || "") + "/" + (agg.model || "?") + "):\n" + agg.content);
        return lines.join("\n\n");
      }

      // 渲染「智囊团对话」面板（聊天框形式：连续聊天流 + 全屏按钮）
      function renderMoaChat(innerForFs) {
        var sessions = moaChat.sessions || [];
        var details = moaAllDetails || [];
        var isFs = innerForFs === true; // 内部调用标记：全屏模式用更大字号

        // 构建连续聊天消息流
        var chatMessages = [];
        sessions.forEach(function (s) {
          var d = details[s.session_id];
          // 会话分隔线（含渠道来源标识）
          var srcTag = s.source && s.source !== "panel"
            ? h("span", { className: "dc-chat-src-tag", title: "来自渠道: " + s.source },
                _sourceIcon(s.source), s.source)
            : null;
          chatMessages.push(h("div", { className: "dc-chat-divider" },
            h("span", { className: "dc-chat-divider-time" }, (s.created_at_iso || "").replace("T", " ").slice(5, 16)),
            srcTag,
            h("span", { className: "dc-chat-divider-prompt" }, (s.prompt || "").slice(0, 30) || "讨论")
          ));
          if (d && d.turns) {
            d.turns.forEach(function (turn) {
              // 用户问题气泡（靠右）
              chatMessages.push(h("div", { className: "dc-chat-msg dc-chat-user" },
                h("div", { className: "dc-chat-bubble dc-chat-bubble-user" },
                  h("span", { className: "dc-chat-avatar" }, "🧑"),
                  h("div", { className: "dc-chat-body" },
                    h("span", { className: "dc-chat-sender" }, "你"),
                    h("div", { className: "dc-chat-text" }, d.prompt || s.prompt || "")
                  )
                )
              ));
              // ── 一轮讨论 = 一个「智囊团回复」卡片（专家+指挥合并）──
              var agg = turn.aggregator || {};
              var refs = turn.references || [];
              // 渠道来源（从 session 级继承）
              var _moaSrc = (s && s.source !== "panel") ? s.source : null;
              chatMessages.push(h("div", { className: "dc-chat-msg dc-chat-moa-reply" },
                h("div", { className: "dc-chat-card dc-chat-card-moa" },
                  // 卡片头部：智囊团标识 + 渠道来源
                  h("div", { className: "dc-chat-card-header" },
                    h("span", { className: "dc-chat-card-icon" }, "🤖"),
                    h("span", { className: "dc-chat-card-title" }, "智囊团回复"),
                    _moaSrc ? h("span", { className: "dc-chat-src-badge", title: "来自 " + _moaSrc }, _sourceIcon(_moaSrc), _moaSrc) : null,
                    refs.length ? h("span", { className: "dc-chat-card-meta" }, refs.length + " 位专家 · 指挥综合") : null,
                    h("button", {
                      className: "dc-chat-copy-btn",
                      title: "复制此回复（含专家与指挥）",
                      onClick: function (e) { copyTextToClipboard(moaTurnToText(turn), e.currentTarget); }
                    }, "⧉")
                  ),
                  // 专家观点区
                  h("div", { className: "dc-chat-card-experts" },
                    refs.map(function (ref, i) {
                      return h("div", { className: "dc-chat-expert-item" },
                        h("div", { className: "dc-chat-expert-label" },
                          "专家 " + (i + 1),
                          h("span", { className: "dc-chat-expert-model" }, (ref.provider || "") + "/" + (ref.model || "?"))
                        ),
                        h("div", { className: "dc-chat-expert-text" }, ref.content || "")
                      );
                    })
                  ),
                  // 分隔线（仅当有专家且有指挥时显示）
                  refs.length && agg.content ? h("div", { className: "dc-chat-card-sep" }) : null,
                  // 指挥总结区
                  agg.content ? h("div", { className: "dc-chat-card-agg" },
                    h("div", { className: "dc-chat-agg-label" },
                      h("span", { className: "dc-chat-agg-icon" }, "🧠"),
                      "指挥综合",
                      h("span", { className: "dc-chat-agg-model" }, (agg.provider || "") + "/" + (agg.model || "?"))
                    ),
                    h("div", { className: "dc-chat-agg-text" }, agg.content)
                  ) : null
                )
              ));
            });
          } else if (!d) {
            chatMessages.push(h("div", { className: "dc-chat-loading-hint" }, "加载会话详情中…"));
          }
          // ── 结构化共识报告（P1）：共识/分歧/推荐方案/已砍选项 ──
          if (d && d.consensus_report && d.consensus_report.markdown) {
            chatMessages.push(h("div", { className: "dc-chat-msg dc-chat-moa-reply" },
              h("div", { className: "dc-chat-card dc-chat-card-consensus" },
                h("div", { className: "dc-chat-card-header" },
                  h("span", { className: "dc-chat-card-icon" }, "📊"),
                  h("span", { className: "dc-chat-card-title" }, "共识报告"),
                  d.auto_stopped ? h("span", { className: "dc-chat-card-meta" }, "动态收敛·提前终止") : null,
                  h("button", {
                    className: "dc-chat-copy-btn",
                    title: "复制共识报告",
                    onClick: function (e) { copyTextToClipboard(d.consensus_report.markdown, e.currentTarget); }
                  }, "⧉")
                ),
                h("div", { className: "dc-chat-consensus-text" }, renderMd(d.consensus_report.markdown))
              )
            ));
            // 共识报告时间（框外，与普通消息分隔线风格完全一致）
            if (d.created_at_iso) {
              chatMessages.push(h("div", { className: "dc-chat-divider" },
                h("span", { className: "dc-chat-divider-time" }, (function () {
                  var dt = new Date(d.created_at_iso);
                  var m = String(dt.getMonth() + 1).padStart(2, "0");
                  var dd = String(dt.getDate()).padStart(2, "0");
                  var hh = String(dt.getHours()).padStart(2, "0");
                  var mm = String(dt.getMinutes()).padStart(2, "0");
                  return m + "-" + dd + " " + hh + ":" + mm;
                })())
              ));
            }
          }
        });

        var bodyContent;
        if (moaChat.loading) {
          bodyContent = h("div", { className: "dc-chat-hint" }, "加载中…");
        } else if (moaChat.running) {
          // 运行中：历史消息 + 当前用户输入气泡 + 加载提示
          var runningMessages = chatMessages.slice();
          // 显示当前正在处理的用户消息（prompt 已在 input 中，但尚未持久化到 sessions）
          if ((moaChat.input || "").trim()) {
            runningMessages.push(h("div", { className: "dc-chat-msg dc-chat-user" },
              h("div", { className: "dc-chat-bubble dc-chat-bubble-user" },
                h("span", { className: "dc-chat-avatar" }, "🧑"),
                h("div", { className: "dc-chat-body" },
                  h("span", { className: "dc-chat-sender" }, "你"),
                  h("div", { className: "dc-chat-text" }, moaChat.input.trim())
                )
              )
            ));
          }
          bodyContent = [
            h("div", { className: "dc-chat-messages" }, runningMessages),
            h("div", { className: "dc-chat-running" }, "智囊团正在讨论，请稍候…")
          ];
        } else if (chatMessages.length) {
          bodyContent = h("div", { className: "dc-chat-messages" }, chatMessages);
        } else {
          bodyContent = h("div", { className: "dc-chat-hint" }, "该组合方案暂无讨论记录，在下方输入问题发起智囊团讨论。");
        }

        return h("div", { className: isFs ? "dc-chat dc-chat-fs" : "dc-chat" },
          // 聊天内容区（挂载/更新后自动滚动到底部：最新消息在最下面）
          h("div", {
            className: "dc-chat-body",
            ref: function (el) {
              chatBodyEl = el;
            }
          }, bodyContent),
          // 错误提示
          moaChat.error ? h("div", { className: "dc-chat-err" }, moaChat.error) : null,
          // 输入行
          h("div", { className: "dc-chat-input-row" },
            h("input", {
              className: "dc-chat-input",
              type: "text",
              placeholder: "向智囊团提问…",
              value: moaChat.input,
              onInput: function (e) { setMoaChat(function (s) { return Object.assign({}, s, { input: e.target.value }); }); },
              onKeyDown: function (e) { if (e.key === "Enter") runMoaChat(); }
            }),
            h("button", {
              className: cn("dc-btn dc-btn-sm dc-btn-primary", moaChat.running && "dc-btn-loading"),
              onClick: runMoaChat,
              disabled: moaChat.running
            }, moaChat.running ? "讨论中…" : "发送")
          )
        );
      }

      // 外部可调用：从子窗口触发发送
      window.__dcSend = function(promptText) {
        setMoaChat(function(s){ return Object.assign({},s,{input:promptText||''}); });
        runMoaChat();
      };

      function loadMoa(force) {
        return Promise.all([
          fetchJSON(API + "/moa/models" + (force ? "?refresh=1" : "")).catch(function () { return { providers: [] }; }),
          fetchJSON("/api/model/moa").catch(function () { return null; }),
          fetchJSON(API + "/moa/usage").catch(function () { return { models: {}, total_models: 0, grand_total: { input_tokens: 0, output_tokens: 0, total_tokens: 0, session_count: 0 } }; }),
          // 编排器状态：从插件私有文件读取（优先于 Hermes MoA preset）
          fetchJSON(API + "/orchestrator").catch(function () { return null; })
        ]).then(function (res) {
          var modelsResp = res[0] || { providers: [] };
          var all = flattenModels(modelsResp.providers);
          var map = {};
          all.forEach(function (m) { map[m.provider + "|" + m.id] = m; });
          setMoaModels({ loading: false, error: null, providers: modelsResp.providers || [] });
          setModelByKey(map);
          var cfg = res[1];
          setMoaFull(cfg || null);
          if (res[2] && res[2].models) { setMoaUsage(res[2]); }

          // ── 辩证控制：插件状态逐字段优先于 preset；旧状态由轮次推断开关 ──
          var orchState = res[3];
          var hasOwn = function (obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); };
          var presetName = null;
          var presetCfg = null;
          if (cfg && cfg.presets) {
            var presetNames = Object.keys(cfg.presets);
            presetName = cfg.active_preset || cfg.default_preset || (presetNames.length ? presetNames[0] : null);
            if (presetName && cfg.presets[presetName]) {
              presetCfg = cfg.presets[presetName];
              setActivePreset(presetName);
            }
          }

          var pluginHasEnabled = hasOwn(orchState, "debate_enabled");
          var pluginHasRounds = hasOwn(orchState, "debate_rounds");
          if (pluginHasEnabled || pluginHasRounds) {
            var pluginRounds = pluginHasRounds ? Math.max(1, Math.min(5, orchState.debate_rounds | 0)) : 2;
            // 明确的 false 或 rounds=1 都表示关闭，绝不回退到 preset。
            var pluginEnabled = pluginHasEnabled ? orchState.debate_enabled === true : pluginRounds > 1;
            if (pluginHasRounds && pluginRounds <= 1) pluginEnabled = false;
            setDebateOn(pluginEnabled);
          } else {
            // 仅当插件完全没有辩证模式字段时，才兼容性读取 preset。
            var presetRounds = (presetCfg && presetCfg.debate_rounds) ? Math.max(1, Math.min(5, presetCfg.debate_rounds | 0)) : 1;
            setDebateOn(presetRounds > 1);
          }

          var hasSavedOrch = orchState && (orchState.orchestrator || (orchState.experts || []).some(Boolean));
          if (hasSavedOrch) {
            // 插件文件有保存的编排器状态 → 恢复用户拖拽结果
            // 注意：orchestrator_state.json 存的是 name 字段，UI/override 用 model，这里统一改名
            var restoredOrch = orchState.orchestrator
              ? { provider: orchState.orchestrator.provider, model: orchState.orchestrator.model || orchState.orchestrator.name, name: orchState.orchestrator.name || orchState.orchestrator.model }
              : null;
            var restoredExperts = (orchState.experts || []).map(function (e) {
              return e ? { provider: e.provider, model: e.model || e.name, name: e.name || e.model, role: e.role } : null;
            });
            setMoa({ orchestrator: restoredOrch, experts: restoredExperts });
          } else {
            // 无保存数据 → 全部显示空（不读取系统默认 preset）
            setMoa({ orchestrator: null, experts: [null, null, null] });
          }
        }).catch(function (e) {
          setMoaModels({ loading: false, error: String((e && e.message) || e), providers: [] });
        });
      }

      // 首次挂载：读缓存（快）。之后 universeRev 变化（模型管理开/关模型或刷新宇宙）
      // 立即强制重建 MoA 模型席缓存并重新加载，让新开/新隐藏的模型马上同步到圆桌。
      var loadedOnceSt = useState(false);
      var loadedOnce = loadedOnceSt[0], setLoadedOnce = loadedOnceSt[1];
      useEffect(function () {
        if (!loadedOnce) {
          setLoadedOnce(true);
          loadMoa(false);
        } else {
          loadMoa(true);
        }
        // 初次挂载即拉取当前组合方案的智囊团聊天
        loadMoaChats(activePreset || "default");
      }, [props.universeRev]);

      // ── 圆桌整体等比缩放 + 动态连接线 ──
      // 圆桌以 720px 为设计宽度；卡片变窄时统一 transform，图标、圆、文字、
      // 间距、连线和拖放命中区域一起缩放。负 margin 回收 transform 不参与布局
      // 所留下的原始高度，避免窄屏卡片底部出现大块空白。
      useEffect(function () {
        var canvas = document.querySelector('.dc-moa-roundtable-v');
        var orchestrator = canvas && canvas.closest('.dc-moa-orchestrator');
        if (!canvas || !orchestrator) return;

        var DESIGN_WIDTH = 720;
        var lastAvailableWidth = -1;

        function updatePaths() {
          var svg = canvas.querySelector('.dc-moa-round-svg-v');
          if (!svg) return;
          var svgRect = svg.getBoundingClientRect();
          // viewBox 跟随 transform 后的可见尺寸；这样动态测得的屏幕像素坐标
          // 与 SVG 坐标一一对应，缩放过程中曲线仍精确落在圆的边缘。
          svg.setAttribute('viewBox', '0 0 ' + Math.round(svgRect.width) + ' ' + Math.round(svgRect.height));
          var coreEl = canvas.querySelector('.dc-moa-core-circle');
          if (!coreEl) return;
          var coreRect = coreEl.getBoundingClientRect();
          var sx = Math.round(coreRect.left + coreRect.width / 2 - svgRect.left);
          var sy = Math.round(coreRect.bottom - svgRect.top);
          var allCircles = canvas.querySelectorAll('.dc-moa-expert-circle');
          var realExperts = [];
          for (var j = 0; j < allCircles.length; j++) {
            var slot = allCircles[j].closest('.dc-moa-expert-slot');
            if (slot && !slot.classList.contains('dc-moa-expert-add')) realExperts.push(allCircles[j]);
          }
          for (var i = 0; i < realExperts.length; i++) {
            var eRect = realExperts[i].getBoundingClientRect();
            var ex = Math.round(eRect.left + eRect.width / 2 - svgRect.left);
            var ey = Math.round(eRect.top - svgRect.top);
            var midY = Math.round((sy + ey) / 2);
            var d = 'M' + sx + ',' + sy + ' C' + sx + ',' + midY + ' ' + ex + ',' + midY + ' ' + ex + ',' + ey;
            var track = svg.querySelector('#moa-path-' + i);
            var flows = svg.querySelectorAll('.dc-moa-dash-flow');
            if (track) track.setAttribute('d', d);
            if (flows[i]) flows[i].setAttribute('d', d);
          }
        }

        function layoutRoundtable(force) {
          var styles = window.getComputedStyle(orchestrator);
          var available = Math.max(1, Math.floor(
            orchestrator.clientWidth
            - (parseFloat(styles.paddingLeft) || 0)
            - (parseFloat(styles.paddingRight) || 0)
          ));
          if (!force && available === lastAvailableWidth) return;
          lastAvailableWidth = available;
          var scale = Math.min(1, available / DESIGN_WIDTH);
          var naturalHeight = canvas.offsetHeight;
          canvas.style.transform = 'scale(' + scale + ')';
          canvas.style.marginBottom = (-naturalHeight * (1 - scale)) + 'px';
          canvas.setAttribute('data-responsive-scale', scale.toFixed(4));
          window.requestAnimationFrame(updatePaths);
        }

        window.requestAnimationFrame(function () { layoutRoundtable(true); });
        var observer = null;
        if (window.ResizeObserver) {
          observer = new window.ResizeObserver(function () { layoutRoundtable(false); });
          observer.observe(orchestrator);
        }
        function onResize() { layoutRoundtable(false); }
        window.addEventListener('resize', onResize);
        return function () {
          if (observer) observer.disconnect();
          window.removeEventListener('resize', onResize);
        };
      }, [moa, moaChat.running]);

      // 聊天内容更新后自动滚动到底部（从 render 期 ref 回调里移出 scrollTop 副作用）
      useEffect(function () {
        if (chatBodyEl) { chatBodyEl.scrollTop = chatBodyEl.scrollHeight; }
      }, [moaChat]);

      // Filter and sort models
      var allModels = flattenModels(moaModels.providers);
      var filtered = allModels.filter(function (m) {
        // Exclude image/video generation models — they are unsuitable for MoA reasoning
        var name = (m.name || "").toLowerCase();
        var id = (m.id || "").toLowerCase();
        if (name.indexOf("image") >= 0 || id.indexOf("image") >= 0
          || name.indexOf("video") >= 0 || id.indexOf("video") >= 0) {
          return false;
        }
        if (!query) return true;
        var q = query.toLowerCase();
        return name.indexOf(q) >= 0
          || (m.provider || "").toLowerCase().indexOf(q) >= 0
          || id.indexOf(q) >= 0;
      });

      // Sort based on mode (real fields)
      var sorted = filtered.slice().sort(function (a, b) {
        if (sort === "context") {
          return (b.context || 0) - (a.context || 0);
        }
        if (sort === "name") {
          return (a.name || "").localeCompare(b.name || "", "zh");
        }
        return 0;
      });

      function handleDrop(slot, model) {
        var key = (model.provider || "") + "|" + (model.id || model.model || "");
        var hit = modelByKey[key];
        var slotObj = hit ? Object.assign({}, hit) : {
          provider: model.provider,
          model: model.id || model.model,
          name: model.name || (model.id || model.model),
          id: model.id || model.model
        };
        var next = Object.assign({}, moa);
        next.experts = moa.experts.slice();
        next.experts[slot] = slotObj;
        setMoa(next);
        // 保存到插件私有文件（UI 状态唯一真相源）—— 副作用移到 updater 之外
        saveOrchestratorState(next.orchestrator, next.experts);
        // 同步到 Hermes MoA preset（保持兼容）
        autoSaveCurrentPreset(next.orchestrator, next.experts);
        setDragOver(null);
      }

      function handleRemove(slot) {
        var next = Object.assign({}, moa);
        next.experts = moa.experts.slice();
        next.experts[slot] = null;
        setMoa(next);
        saveOrchestratorState(next.orchestrator, next.experts);
        autoSaveCurrentPreset(next.orchestrator, next.experts);
      }

      function handleOrchDrop(model) {
        var key = (model.provider || "") + "|" + (model.id || model.model || "");
        var hit = modelByKey[key];
        var slotObj = hit ? Object.assign({}, hit) : {
          provider: model.provider,
          model: model.id || model.model,
          name: model.name || (model.id || model.model),
          id: model.id || model.model
        };
        var next = Object.assign({}, moa, { orchestrator: slotObj });
        setMoa(next);
        saveOrchestratorState(next.orchestrator, next.experts);
        autoSaveCurrentPreset(next.orchestrator, next.experts);
      }

      function handleOrchRemove() {
        var next = Object.assign({}, moa, { orchestrator: null });
        setMoa(next);
        saveOrchestratorState(null, next.experts);
        autoSaveCurrentPreset(null, next.experts);
      }

      function buildCopyText(m) {
        var lines = ["moa:"];
        var experts = (m.experts || []).filter(Boolean);
        if (experts.length) {
          lines.push("  reference_models:");
          experts.forEach(function (e) {
            lines.push("    - provider: " + e.provider);
            lines.push("      model: " + e.model);
            if (e.role) lines.push("      role: " + e.role);
          });
        } else {
          lines.push("  reference_models: []");
        }
        if (m.orchestrator) {
          lines.push("  aggregator:");
          lines.push("    provider: " + m.orchestrator.provider);
          lines.push("    model: " + m.orchestrator.model);
        } else {
          lines.push("  aggregator: null");
        }
        lines.push("  enabled: true");
        lines.push("  max_tokens: 4096");
        lines.push("  debate_rounds: " + (debateOn ? Math.max(2, Math.min(5, debateRounds | 0)) : 1));
        return lines.join("\n");
      }

      function handleCopy() {
        var text = buildCopyText(moa);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            setCopied(true);
            setTimeout(function () { setCopied(false); }, 2000);
          }).catch(function () {});
        }
      }

      function applyToHermes() {
        if (!moa.orchestrator) {
          setApplyState({ applying: false, applied: false, error: "请先放置核心编排器 (CORE)" });
          return;
        }
        var experts = moa.experts.filter(Boolean);
        if (!experts.length) {
          setApplyState({ applying: false, applied: false, error: "请至少放置 1 个专家模型" });
          return;
        }
        // 合并保留已有 presets：只更新当前激活的 preset，不整体覆盖 moa 配置。
        var full = moaFull || {};
        var presets = full.presets ? Object.assign({}, full.presets) : {};
        var active = activePreset || full.default_preset || "default";
        if (!presets[active]) {
          presets[active] = { enabled: true, reference_models: [], aggregator: { provider: "", model: "" } };
        }
        presets[active] = Object.assign({}, presets[active], {
          reference_models: experts.map(function (e) { var o = { provider: e.provider, model: e.model }; if (e.role) o.role = e.role; return o; }),
          aggregator: { provider: moa.orchestrator.provider, model: moa.orchestrator.model },
          enabled: true,
          max_tokens: 4096,
          debate_rounds: debateOn ? Math.max(2, Math.min(5, debateRounds | 0)) : 1
        });
        var payload = {
          default_preset: full.default_preset || active,
          active_preset: active,
          presets: presets
        };
        setApplyState({ applying: true, applied: false, error: null });
        fetchJSON("/api/model/moa", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (resp) {
          setMoaFull(resp || full);
          // 应用成功后顺便把当前方案也复制到剪贴板
          try { handleCopy(); } catch (_) { /* 非关键路径，忽略 */ }
          setApplyState({ applying: false, applied: true, error: null });
          setTimeout(function () {
            setApplyState(function (s) { return Object.assign({}, s, { applied: false }); });
          }, 3000);
        }).catch(function (e) {
          setApplyState({ applying: false, applied: false, error: String((e && e.message) || e) });
        });
      }

      var NUM_SEATS = 3;
      var orchIcon = moa.orchestrator ? providerIcon(moa.orchestrator.provider) : null;

      function toggleSeat(i) {
        var m = moa.experts[i];
        if (m) {
          setSelModel(m); // 点击图标只选中显示详情，不删除；删除仅由红叉触发
        }
        // 空位点击不自动添加——只能从左边拖放
      }

      function toggleOrch() {
        if (moa.orchestrator) {
          setSelModel(moa.orchestrator); // 点击图标只选中显示详情，不删除；删除仅由红叉触发
        }
        // 空位点击不自动添加——只能从左边拖放
      }

      // ── 动态专家席位：增 / 删 ──
      function addExpert() {
        if (moa.experts.length >= 8) return; // 上限，避免无限膨胀
        var next = Object.assign({}, moa);
        next.experts = moa.experts.concat([null]);
        setMoa(next);
        autoSaveCurrentPreset(next.orchestrator, next.experts);
        saveOrchestratorState(next.orchestrator, next.experts);
      }
      function removeExpert(i) {
        var next = Object.assign({}, moa);
        next.experts = moa.experts.slice();
        if (i < 3) {
          // 前三个默认位置只清空模型，不删除席位
          next.experts[i] = null;
        } else {
          next.experts.splice(i, 1);
        }
        setMoa(next);
        autoSaveCurrentPreset(next.orchestrator, next.experts);
        saveOrchestratorState(next.orchestrator, next.experts);
      }
      function refreshBench() {
        if (benchRefreshing) return;
        setBenchRefreshing(true);
        loadMoa(true).then(
          function () { setBenchRefreshing(false); },
          function () { setBenchRefreshing(false); }
        );
      }

      function applyDefault() {
        var list = flattenModels(moaModels.providers);
        if (!list.length) return;
        setMoa({
          orchestrator: { provider: list[0].provider, model: list[0].id, name: list[0].name },
          experts: list.slice(1, NUM_SEATS + 1)
            .map(function (m) { return { provider: m.provider, model: m.id, name: m.name }; })
            .concat([null, null, null]).slice(0, NUM_SEATS)
        });
      }

      function renderSummaryPanel() {
        var items = [];
        if (moa.orchestrator) items.push({ role: "指挥", model: moa.orchestrator });
        moa.experts.forEach(function (m, i) {
          if (m) items.push({ role: "臭皮匠 " + (i + 1), model: m });
        });
        // MoA 专属总量（非 Hermes 全局）
        // Compute max from actual per-model data (grand_total may be empty)
        var _moaModels = (moaUsage && moaUsage.moa_models) || {};
        var _allMoaToks = items.map(function(it){
          var _mid = (it.model && (it.model.name || it.model.model)) || "";
          var _mu = _moaModels[_mid] || {};
          return (_mu.input_tokens||0) + (_mu.output_tokens||0);
        });
        var maxMoaTok = Math.max.apply(null, _allMoaToks.concat([1]));
        var _allMoaSess = items.map(function(it){
          var _mid = (it.model && (it.model.name || it.model.model)) || "";
          return ((_moaModels[_mid] || {}).session_count || 0);
        });
        var moaTotalSessions = Math.max.apply(null, _allMoaSess.concat([0]));
        // Fallback to grand_total if available (for footer display)
        var moaGrand = (moaUsage && moaUsage.grand_total) || {};
        // 将渠道来源（含微信）数据纳入 MoA 总计
        var _srcTotals = (function () {
          var _bs = (moaUsage && moaUsage.by_source) || {};
          var _tok = 0, _sess = 0;
          Object.keys(_bs).forEach(function (k) {
            if (k === "panel") return;
            var d = _bs[k] || {};
            _tok += d.total_tokens || 0;
            _sess += d.session_count || 0;
          });
          return { tokens: _tok, sessions: _sess };
        })();
        var moaTotalIn = moaGrand.moa_input_tokens || (_allMoaToks.reduce(function(a,b){return a+b;},0) + _srcTotals.tokens);
        var moaTotalOut = (moaGrand.moa_output_tokens || 0); // output 通常已含在 grand_total
        // 会话总计也纳入渠道来源
        moaTotalSessions = Math.max(moaTotalSessions, _srcTotals.sessions);
        return h("div", { className: "dc-moa-detail-card" },
          h("div", { className: "dc-moa-detail-head" },
            h("div", { className: "dc-moa-detail-meta" },
              h("div", { className: "dc-moa-detail-topline" },
                h("span", { className: "dc-moa-detail-name" }, "智囊团用量总览")
              ),
              h("div", { className: "dc-moa-detail-provider" }, "组合方案：" + (activePreset || "default"))
            )
          ),
          h("div", { className: "dc-moa-summary-list" },
            items.length === 0
              ? h("div", { className: "dc-moa-summary-empty" }, "当前圆桌未放置任何模型")
              : items.map(function (item, idx) {
                  // 用 MoA 专属用量数据（expert 用 name/model 作 key，不是 id）
                  var _mid = (item.model && (item.model.name || item.model.model)) || "";
                  var mu = (moaUsage && moaUsage.moa_models && moaUsage.moa_models[_mid]) || {};
                  var moaTok = (mu.input_tokens || 0) + (mu.output_tokens || 0);
                  return h("div", { key: "sum-" + idx, className: "dc-moa-summary-row-flat" },
                    h("div", { className: "dc-moa-summary-name-flat" },
                      h("span", { className: "dc-moa-summary-model-name" }, item.model.name),
                      item.role !== "指挥"
                        ? h("span", { className: "dc-moa-summary-role-flat" }, item.role)
                        : null
                    ),
                    // MoA TOKEN 行
                    h("div", { className: "dc-moa-bar-row dc-moa-bar-row-compact" },
                      h("span", { className: "dc-moa-bar-lbl" }, "MoA TOKEN"),
                      h("div", { className: "dc-moa-bar-track" },
                        h("div", {
                          className: "dc-moa-bar-fill dc-moa-bar-cost",
                          style: { width: (maxMoaTok > 0 ? Math.min(moaTok / maxMoaTok * 100, 100) : 0) + "%" }
                        })
                      ),
                      h("span", { className: "dc-moa-bar-val" }, fmtTok(moaTok))
                    ),
                    // MoA 会话行
                    h("div", { className: "dc-moa-bar-row dc-moa-bar-row-compact" },
                      h("span", { className: "dc-moa-bar-lbl" }, "MoA 会话"),
                      h("div", { className: "dc-moa-bar-track" },
                        h("div", {
                          className: "dc-moa-bar-fill dc-moa-bar-session",
                          style: { width: (moaTotalSessions > 0
                            ? Math.min((mu.session_count || 0) / moaTotalSessions * 100, 100) : 0) + "%" }
                        })
                      ),
                      h("span", { className: "dc-moa-bar-val" }, String(mu.session_count || 0) + " 会话")
                    )
                  );
                })
          ),
          // ── 渠道来源数据已纳入上方 MoA 总计，不再单独展示 ──
          null,
          h("div", { className: "dc-moa-detail-footer" },
            "总计：MoA TOKEN " + fmtTok(moaTotalIn + moaTotalOut) +
            " · MoA 会话 " + moaTotalSessions
          )
        );
      }

      // ── 全屏模式：仅渲染智囊团对话面板（铺满整屏，作为独立页面）──
      if (_fs) {
        return h("div", { className: "dc-moa-fs-only" },
          h("div", { className: "dc-moa-copy-panel" },
            h("div", { className: "dc-moa-copy-header" },
              h("div", { className: "dc-moa-copy-header-left" },
                h("span", null, "智囊团对话"),
                h("div", { className: "dc-moa-copy-select-wrap" },
                  h("select", {
                    className: "dc-moa-copy-select",
                    value: activePreset,
                    title: "切换组合方案",
                    onChange: function (e) { switchPreset(e.target.value); }
                  },
                    getPresetNames().map(function (name) {
                      return h("option", { key: name, value: name, selected: name === activePreset }, name);
                    })
                  )
                )
              ),
              h("div", { className: "dc-moa-copy-actions" },
                h("button", {
                  className: "dc-btn dc-btn-sm dc-btn-ghost",
                  onClick: function () { try { window.close(); } catch (e) { history.back(); } },
                  title: "关闭窗口"
                }, "✕ 关闭")
              )
            ),
            applyState.error ? h("div", { className: "dc-moa-apply-err" }, applyState.error) : null,
            renderMoaChat(true)
          )
        );
      }

      return h("div", { className: "dc-moa-wrapper" },

        // ── 预设管理栏（Preset Bar）──
        h("div", { className: "dc-moa-preset-bar" },
          h("div", { className: "dc-moa-preset-label" }, "组合方案"),
          // 预设选择器（下拉/标签式）
          h("div", { className: "dc-moa-preset-selector" },
            getPresetNames().map(function (name) {
              return h("button", {
                key: name,
                className: cn("dc-moa-preset-tab", name === activePreset && "active"),
                onClick: function () { switchPreset(name); }
              }, name);
            })
          ),
          // 操作按钮组
          h("div", { className: "dc-moa-preset-actions" },
            // 添加预设
            showAddPreset
              ? h("div", { className: "dc-moa-add-preset-row" },
                  h("input", {
                    className: "dc-moa-preset-input",
                    type: "text",
                    placeholder: "新预设名称",
                    value: newPresetName,
                    onChange: function (e) { setNewPresetName(e.target.value); },
                    onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); addPreset(); } },
                    autoFocus: true
                  }),
                  h("button", { className: cn("dc-btn dc-moa-preset-btn"), onClick: addPreset }, "创建"),
                  h("button", { className: cn("dc-btn dc-moa-preset-btn", "dc-btn-ghost"), onClick: function () { setShowAddPreset(false); setNewPresetName(""); } }, "取消")
                )
              : h("button", { className: cn("dc-btn dc-moa-preset-btn"), onClick: function () { setShowAddPreset(true); } }, "+ 预设"),
            // 删除预设
            h("button", {
              className: cn("dc-btn dc-moa-preset-btn", getPresetNames().length <= 1 && "dc-btn-disabled"),
              onClick: deleteCurrentPreset,
              disabled: getPresetNames().length <= 1
            }, "删除"),
            // 设为默认
            h("button", {
              className: cn("dc-btn dc-moa-preset-btn", (moaFull && moaFull.default_preset === activePreset) && "dc-btn-success"),
              onClick: setAsDefault
            }, (moaFull && moaFull.default_preset === activePreset) ? "默认 ✓" : "设默认")
          )
        ),

        h("div", { className: "dc-moa-main" },
          // 左侧：模型席（标题栏右侧内嵌搜索 + 按钮）
          h("div", { className: "dc-moa-bench" },
            h("div", { className: "dc-moa-panel-header" },
              h("div", { className: "dc-moa-panel-title-block" },
                h("div", { className: "dc-moa-panel-title" }, T.moaBenchTitle),
                h("div", { className: "dc-moa-panel-sub" }, T.moaBenchSub)
              ),
              h("input", {
                className: "dc-moa-search",
                type: "text",
                placeholder: T.moaSearchPh,
                value: query,
                onChange: function (e) { setQuery(e.target.value); }
              })
            ),
            h("div", { className: "dc-moa-tabs-row" },
              h("div", { className: "dc-moa-tabs" },
                h("button", { className: cn("dc-moa-tab", sort === "all" && "active"), onClick: function () { setSort("all"); } }, T.moaTabArena),
                h("button", { className: cn("dc-moa-tab", sort === "context" && "active"), onClick: function () { setSort("context"); } }, T.moaTabCost),
                h("button", { className: cn("dc-moa-tab", sort === "name" && "active"), onClick: function () { setSort("name"); } }, T.moaTabSpeed)
              ),
              h("button", {
                className: "dc-moa-refresh-btn",
                title: T.refresh,
                onClick: refreshBench,
                disabled: benchRefreshing
              }, T.refresh)
            ),
            h("div", { className: "dc-moa-model-grid" },
              moaModels.loading
                ? h("div", { className: "dc-moa-bench-loading" }, T.loading + "…")
                : moaModels.error
                  ? h("div", { className: "dc-moa-bench-err" }, T.errTitle + ": " + moaModels.error)
                  : sorted.length === 0
                    ? h("div", { className: "dc-moa-bench-empty" }, T.moaUnconfigured)
                    :                       sorted.map(function (m, idx) {
                        // 检查该模型是否已被放到右边席位（优先 id+provider 精确匹配，fallback 用 name）
                        var orch = moa.orchestrator;
                        var isOrch = orch && (
                          (orch.model === m.id && orch.provider === m.provider) ||
                          (orch.name && orch.name === m.name)
                        );
                        // 找到该模型占用的专家席位序号（0-based），用于左侧卡片显示臭皮匠编号
                        var expIdx = -1;
                        moa.experts.forEach(function (e, i) {
                          if (e && (
                            (e.model === m.id && e.provider === m.provider) ||
                            (e.name && e.name === m.name)
                          )) { expIdx = i; }
                        });
                        var isExp = expIdx >= 0;
                        return h(MoAModelCard, {
                          key: m.id,
                          model: m,
                          index: idx,
                          expertIndex: isExp ? expIdx : undefined,
                          selected: selModel && selModel.id === m.id,
                          onSelect: setSelModel,
                          onDragStart: setDraggedModel,
                          // 拖放悬停边框
                          isOrchHover: draggedModel && dragOverTarget === "orch" && draggedModel.id === m.id,
                          isExpertHover: draggedModel && typeof dragOverTarget === "number" && draggedModel.id === m.id,
                          // 放置后持久边框
                          isOrchestrator: isOrch,
                          isExpert: isExp
                        });
                      })
            )
          ),

          // 右侧：核心 · 编排器（竖向布局：CORE在上，EXPERTS在下）
          h("div", { className: "dc-moa-orchestrator" },
          h("div", { className: "dc-moa-panel-header" },
            h("div", { className: "dc-moa-panel-title" }, T.moaCoreTitle),
            h("div", { className: "dc-moa-debate-wrap" },
              h("div", { className: "dc-moa-debate-modes", role: "group", "aria-label": "会商模式" },
                h("button", {
                  type: "button",
                  className: cn("dc-moa-debate-mode", !debateOn && "active"),
                  "aria-pressed": !debateOn,
                  "aria-describedby": "dc-moa-single-tip",
                  onClick: function () {
                    if (!debateOn) return;
                    var override = { debate_enabled: false, debate_rounds: 1, debate_auto_stop: debateAutoStop };
                    setDebateOn(false);
                    saveOrchestratorState(moa.orchestrator, moa.experts, override);
                    autoSaveCurrentPreset(moa.orchestrator, moa.experts, override);
                  }
                },
                  "单轮会商",
                  h("span", { id: "dc-moa-single-tip", className: "dc-moa-debate-tooltip", role: "tooltip" },
                    "各专家并行独立作答，由指挥统一汇总"
                  )
                ),
                h("button", {
                  type: "button",
                  className: cn("dc-moa-debate-mode", debateOn && "active"),
                  "aria-pressed": debateOn,
                  "aria-describedby": "dc-moa-multi-tip",
                  onClick: function () {
                    if (debateOn) return;
                    var rounds = Math.max(2, Math.min(5, debateRounds | 0));
                    var override = { debate_enabled: true, debate_rounds: rounds, debate_auto_stop: debateAutoStop };
                    setDebateOn(true);
                    saveOrchestratorState(moa.orchestrator, moa.experts, override);
                    autoSaveCurrentPreset(moa.orchestrator, moa.experts, override);
                  }
                },
                  "多轮辩证",
                  h("span", { id: "dc-moa-multi-tip", className: "dc-moa-debate-tooltip", role: "tooltip" },
                    "专家每轮并行分析；下一轮基于上一轮观点交叉质疑与修正，形成高共识后可提前结束（最多 5 轮）"
                  )
                )
              )
            )
          ),
            h("div", {
                className: cn("dc-moa-roundtable-v", moaChat.running && "moa-running")
              },

              // ── SVG 连接线层：D3 curveBumpY，路径由 useEffect 动态测量 DOM 生成 ──
              // 不再硬编码坐标 — 渲染后 JS 测量圆的真实位置，曲线精确连接圆的边缘
              h("svg", { className: "dc-moa-round-svg-v", viewBox: "0 0 100 100", preserveAspectRatio: "none" },
                (function () {
                  var n = moa.experts.length;
                  if (n === 0 || n > 5) return [];
                  var pathIdBase = "moa-path-";
                  var paths = [];
                  for (var i = 0; i < n; i++) {
                    var pid = pathIdBase + i;
                    paths.push(
                      h("path", { key: "track-" + i, id: pid, d: "M0,0", fill: "none", className: "dc-moa-dash-track" }),
                      h("path", { key: "flow-" + i, d: "M0,0", fill: "none", className: "dc-moa-dash-flow" }),
                      h("circle", {
                        key: "particle-" + i,
                        r: "2.5",
                        fill: "#eab308",
                        className: "dc-moa-particle",
                        style: { "--particle-delay": (i * 0.45) + "s" }
                      },
                      h("animateMotion", {
                        dur: "2.2s",
                        repeatCount: "indefinite",
                        keyPoints: "0;1",
                        calcMode: "linear",
                        begin: (i * 0.45) + "s"
                      },
                      h("mpath", { href: "#" + pid })
                      )
                      )
                    );
                  }
                  return paths;
                })()
              ),

              // 运行态状态标签
              moaChat.running && h("div", { className: "dc-moa-running-badge" },
                h("span", { className: "dc-moa-running-dot" }),
                T.moaRunning || "推理中…"
              ) || null,

              // ── CORE（上方圆）── 标签 → 圆 → 模型名（已移除顶部 emoji）
              h("div", { className: "dc-moa-core-section" },
                h("span", { className: "dc-moa-core-label-top" }, T.moaOrchestrator.toUpperCase() + " \u00B7 " + T.moaConductor.toUpperCase()),
                h("div", {
                  className: cn("dc-moa-core-circle", moa.orchestrator && "filled"),
                  onClick: toggleOrch,
                  onDragOver: function (e) { e.preventDefault(); e.dataTransfer.dropEffect = moa.orchestrator ? "move" : "copy"; },
                  onDragEnter: function (e) { e.preventDefault(); setDragOverTarget("orch"); },
                  onDragLeave: function () { setDragOverTarget(null); },
                  onDrop: function (e) {
                    e.preventDefault();
                    setDragOverTarget(null);
                    setDraggedModel(null);
                    try { var data = JSON.parse(e.dataTransfer.getData("model")); handleOrchDrop(data); } catch (err) {}
                  }
                },
                  moa.orchestrator
                    ? h("div", { className: "dc-moa-core-inner" },
                        h("div", { className: "dc-moa-icon-bg" }, orchIcon),
                        h("span", { className: "dc-moa-crown-badge" }, "\uD83D\uDC51")  // 👑
                      )
                    : null,
                  moa.orchestrator
                    ? h("button", {
                        className: "dc-moa-core-remove",
                        title: "移除指挥模型",
                        onClick: function (e) { e.stopPropagation(); handleOrchRemove(); }
                      }, "×")
                    : null
                ),
                moa.orchestrator
                  ? h("div", { className: "dc-moa-core-name" }, moa.orchestrator.name)
                  : h("div", { className: "dc-moa-core-empty-hint" }, T.moaNoModel)
              ),

              // ── EXPERTS（下方一排，动态席位：可增删）───
              h("div", { className: "dc-moa-experts-row" },
                moa.experts.map(function (m, i) {
                  return h("div", { key: "exp-" + i, className: "dc-moa-expert-slot", style: { "--seat-idx": i } },
                    h("span", { className: "dc-moa-expert-label" },
                      T.moaExpert.toUpperCase() + " " + (i + 1)
                    ),
                    h("div", {
                      className: cn(
                        "dc-moa-expert-circle",
                        m && "filled",
                        selModel && m && selModel.id === m.id && "selected"
                      ),
                      onClick: function () { toggleSeat(i); },
                      onDragOver: function (e) { e.preventDefault(); setDragOver(i); setDragOverTarget(i); },
                      onDragLeave: function () { setDragOver(null); setDragOverTarget(null); },
                      onDrop: function (e) {
                        e.preventDefault();
                        setDragOverTarget(null);
                        setDraggedModel(null);
                        try { var data = JSON.parse(e.dataTransfer.getData("model")); handleDrop(i, data); } catch (err) {}
                      }
                    },
                      m
                        ? h("div", { className: "dc-moa-expert-inner" }, h("div", { className: "dc-moa-icon-bg" }, providerIcon(m.provider)))
                        : null,
                      !m && h("span", { className: "dc-moa-expert-empty" }, "+"),
                      m
                        ? h("button", {
                            className: "dc-moa-expert-remove",
                            title: "移除该专家",
                            onClick: function (e) { e.stopPropagation(); removeExpert(i); }
                          }, "×")
                        : null
                    ),
                    m
                      ? h("div", { className: "dc-moa-expert-name" }, m.name)
                      : null
                  );
                }),
                // 末尾「+ 添加专家」席位
                h("div", { key: "add-exp", className: "dc-moa-expert-slot dc-moa-expert-add" },
                  h("span", { className: "dc-moa-expert-label" }, "添加"),
                  h("div", {
                    className: "dc-moa-expert-circle dc-moa-expert-add-circle",
                    onClick: addExpert,
                    title: "添加一个专家席位"
                  },
                    h("span", { className: "dc-moa-expert-empty" }, "+")
                  )
                )
              ),
              h("div", { className: "dc-moa-drag-hint" }, T.moaClickHint)
            )
          )
        ),

        // ── 底部双栏：左=模型详情(真实元数据 + 用量统计) / 右=COPY + 应用到 Hermes ──
        (function () {
          // 当前选中模型的用量（闭包捕获，供下方渲染使用）
          window.__moa_sel_usage = (selModel && moaUsage && moaUsage.models) ? (moaUsage.models[selModel.id] || null) : null;
          // Also capture MoA-only stats if available
          window.__moa_sel_moa_usage = (selModel && moaUsage && moaUsage.moa_models) ? (moaUsage.moa_models[selModel.id] || null) : null;
          if (window.__moa_sel_usage && window.__moa_sel_moa_usage) {
            Object.assign(window.__moa_sel_usage, {
              moa_session_count: window.__moa_sel_moa_usage.session_count || 0,
              moa_input_tokens: window.__moa_sel_moa_usage.input_tokens || 0,
              moa_output_tokens: window.__moa_sel_moa_usage.output_tokens || 0
            });
          }
          return null;
        })(),
        h("div", { className: "dc-moa-bottom" },
          // 左栏：选中模型详情（上下文长度 + Token 用量 + 会话数）
          selModel
            ? h("div", { className: "dc-moa-detail-card" },
                h("div", { className: "dc-moa-detail-head" },
                  h("div", { className: "dc-moa-detail-icon" }, h("div", { className: "dc-moa-icon-bg" }, providerIcon(selModel.provider))),
                  h("div", { className: "dc-moa-detail-meta" },
                    h("div", { className: "dc-moa-detail-topline" },
                      h("span", { className: "dc-moa-detail-name" }, selModel.name)
                    ),
                    h("div", { className: "dc-moa-detail-provider" },
                      (selModel.providerName || selModel.provider || "").toUpperCase() + " · " + (selModel.context ? formatCtx(selModel.context) : "上下文未知")
                    )
                  )
                ),
                h("p", { className: "dc-moa-detail-desc" }, "模型 ID：" + selModel.id),
                // ── 辩论角色编辑（仅专家席位；P2 差异化视角注入）──
                (function () {
                  if (!moa || !moa.experts) return null;
                  var idx = -1;
                  for (var k = 0; k < moa.experts.length; k++) {
                    var e = moa.experts[k];
                    if (e && selModel && e.id === selModel.id) { idx = k; break; }
                  }
                  if (idx < 0) return null; // 选中的是指挥模型，不编辑角色
                  function updRole(v) {
                    var exps = moa.experts.slice();
                    exps[idx] = Object.assign({}, exps[idx], { role: v });
                    setMoa(Object.assign({}, moa, { experts: exps }));
                    autoSaveCurrentPreset(moa.orchestrator, exps);
                    // 同时持久化到圆桌真相源，否则刷新页面后 role 找不到（P2-2）
                    saveOrchestratorState(moa.orchestrator, exps);
                  }
                  return h("div", { className: "dc-moa-role-edit" },
                    h("label", { className: "dc-moa-role-lbl" }, "辩论角色（差异化视角）"),
                    h("input", {
                      className: "dc-moa-role-input",
                      type: "text",
                      placeholder: "如：逻辑主审 / 事实核查 / 创意发散",
                      value: (moa.experts[idx].role) || "",
                      onChange: function (ev) { updRole(ev.target.value); }
                    })
                  );
                })(),
                h("div", { className: "dc-moa-bars" },
                  h("div", { className: "dc-moa-bar-row" },
                    h("span", { className: "dc-moa-bar-lbl" }, T.moaAgentStat),
                    h("div", { className: "dc-moa-bar-track" },
                      h("div", {
                        className: "dc-moa-bar-fill dc-moa-bar-agent",
                        style: { width: (selModel.context ? Math.min(selModel.context / 1000000 * 100, 100) : 0) + "%" }
                      })
                    ),
                    h("span", { className: "dc-moa-bar-val" }, selModel.context ? formatCtx(selModel.context) : "—")
                  ),
                  h("div", { className: "dc-moa-bar-row" },
                    h("span", { className: "dc-moa-bar-lbl" }, T.moaCostM),
                    h("div", { className: "dc-moa-bar-track" },
                      h("div", {
                        className: "dc-moa-bar-fill dc-moa-bar-cost",
                        style: { width: (moaUsage.grand_total && moaUsage.grand_total.input_tokens > 0
                          ? Math.min(((window.__moa_sel_usage || {}).input_tokens || 0) / moaUsage.grand_total.input_tokens * 100, 100) : 0) + "%" }
                      })
                    ),
                    h("span", { className: "dc-moa-bar-val" }, fmtTok((window.__moa_sel_usage || {}).input_tokens))
                  ),
                  h("div", { className: "dc-moa-bar-row" },
                    h("span", { className: "dc-moa-bar-lbl" }, T.moaTps),
                    h("div", { className: "dc-moa-bar-track" },
                      h("div", {
                        className: "dc-moa-bar-fill dc-moa-bar-speed",
                        style: { width: (moaUsage.grand_total && moaUsage.grand_total.output_tokens > 0
                          ? Math.min(((window.__moa_sel_usage || {}).output_tokens || 0) / moaUsage.grand_total.output_tokens * 100, 100) : 0) + "%" }
                      })
                    ),
                    h("span", { className: "dc-moa-bar-val" }, fmtTok((window.__moa_sel_usage || {}).output_tokens))
                  ),
                  h("div", { className: "dc-moa-bar-row" },
                    h("span", { className: "dc-moa-bar-lbl" }, "会话数"),
                    h("div", { className: "dc-moa-bar-track" },
                      h("div", {
                        className: "dc-moa-bar-fill dc-moa-bar-session",
                        style: { width: (moaUsage.grand_total && moaUsage.grand_total.session_count > 0
                          ? Math.min(((window.__moa_sel_usage || {}).session_count || 0) / moaUsage.grand_total.session_count * 100, 100) : 0) + "%" }
                      })
                    ),
                    h("span", { className: "dc-moa-bar-val" }, String((window.__moa_sel_usage || {}).session_count || 0))
                  ),
                  // ── MoA 专属统计：该模型作为智囊团成员产生的会话和 Token ──
                  h("div", { className: "dc-moa-bar-row" },
                    h("span", { className: "dc-moa-bar-lbl dc-moa-bar-lbl-moa" }, "MoA 会话"),
                    h("div", { className: "dc-moa-bar-track" },
                      h("div", {
                        className: "dc-moa-bar-fill dc-moa-bar-moa-session",
                        style: { width: (moaUsage.moa_grand_total && moaUsage.moa_grand_total.session_count > 0
                          ? Math.min(((window.__moa_sel_usage || {}).moa_session_count || 0) / moaUsage.moa_grand_total.session_count * 100, 100) : 0) + "%" }
                      })
                    ),
                    h("span", { className: "dc-moa-bar-val" }, String((window.__moa_sel_usage || {}).moa_session_count || 0))
                  ),
                  h("div", { className: "dc-moa-bar-row" },
                    h("span", { className: "dc-moa-bar-lbl dc-moa-bar-lbl-moa" }, "MoA TOKEN"),
                    h("div", { className: "dc-moa-bar-track" },
                      h("div", {
                        className: "dc-moa-bar-fill dc-moa-bar-moa-token",
                        style: { width: (moaUsage.moa_grand_total && (moaUsage.moa_grand_total.input_tokens + moaUsage.moa_grand_total.output_tokens) > 0
                          ? Math.min((((window.__moa_sel_usage || {}).moa_input_tokens || 0) + ((window.__moa_sel_usage || {}).moa_output_tokens || 0)) / (moaUsage.moa_grand_total.input_tokens + moaUsage.moa_grand_total.output_tokens) * 100, 100) : 0) + "%" }
                      })
                    ),
                    h("span", { className: "dc-moa-bar-val" }, fmtTok(((window.__moa_sel_usage || {}).moa_input_tokens || 0) + ((window.__moa_sel_usage || {}).moa_output_tokens || 0)))
                  ),
                  // ── 新增：总 TOKEN（输入+输出合计）──
                  h("div", { className: "dc-moa-bar-row" },
                    h("span", { className: "dc-moa-bar-lbl" }, "总 Token"),
                    h("div", { className: "dc-moa-bar-track" },
                      h("div", {
                        className: "dc-moa-bar-fill dc-moa-bar-total",
                        style: { width: (moaUsage.grand_total && moaUsage.grand_total.total_tokens > 0
                          ? Math.min(((window.__moa_sel_usage || {}).total_tokens || ((window.__moa_sel_usage || {}).input_tokens||0) + ((window.__moa_sel_usage || {}).output_tokens||0)) / moaUsage.grand_total.total_tokens * 100, 100) : 0) + "%" }
                      })
                    ),
                    h("span", { className: "dc-moa-bar-val" },
                      fmtTok(((window.__moa_sel_usage || {}).input_tokens || 0) + ((window.__moa_sel_usage || {}).output_tokens || 0))
                    )
                  ),
                  // ── 新增：平均每会话 Token ──
                  h("div", { className: "dc-moa-bar-row" },
                    h("span", { className: "dc-moa-bar-lbl" }, "平均/会话"),
                    h("div", { className: "dc-moa-bar-track dc-moa-bar-track-avg",
                      title: "该模型每次会话平均消耗的 Token 数"
                    },
                      h("div", {
                        className: "dc-moa-bar-fill dc-moa-bar-avg",
                        style: {
                          width: function() {
                            var sc = (window.__moa_sel_usage || {}).session_count || 0;
                            var tot = ((window.__moa_sel_usage || {}).input_tokens || 0) + ((window.__moa_sel_usage || {}).output_tokens || 0);
                            return sc > 0 ? Math.min(tot / sc / 200000 * 100, 100) : 0; /* 200K = 100% */
                          }() + "%"
                        }
                      })
                    ),
                    h("span", { className: "dc-moa-bar-val" },
                      function() {
                        var sc = (window.__moa_sel_usage || {}).session_count || 0;
                        var tot = ((window.__moa_sel_usage || {}).input_tokens || 0) + ((window.__moa_sel_usage || {}).output_tokens || 0);
                        return sc > 0 ? fmtTok(Math.round(tot / sc)) : "—";
                      }()
                    )
                  ),
                  // ── 新增：最近活跃（从 MoA 会话记录推算）──
                  h("div", { className: "dc-moa-bar-row dc-moa-bar-row-last" },
                    h("span", { className: "dc-moa-bar-lbl" }, "最近活跃"),
                    h("div", { className: "dc-moa-bar-val dc-moa-bar-val-wide", style: { flex: 1, textAlign: 'left', paddingLeft: '.4rem' } },
                      (function() {
                        var u = window.__moa_sel_usage;
                        if (!u || !u.session_count || u.session_count <= 0) return "暂无使用记录";
                        if (u.last_used_at) {
                          try {
                            var d = new Date(u.last_used_at);
                            var ago = Date.now() - d.getTime();
                            if (ago < 60000) return "刚刚";
                            if (ago < 3600000) return Math.floor(ago / 60000) + " 分钟前";
                            if (ago < 86400000) return Math.floor(ago / 3600000) + " 小时前";
                            return Math.floor(ago / 86400000) + " 天前";
                          } catch(e) { return String(u.last_used_at); }
                        }
                        return "有 " + u.session_count + " 次会话";
                      })()
                    )
                  )
                ),
                h("div", { className: "dc-moa-detail-footer" }, "MIXTURE OF AGENTS · Token 用量统计")
              )
            : renderSummaryPanel(),

          // 右栏：智囊团对话（聊天框形式，插件自有核心层）
          h("div", { className: "dc-moa-copy-panel" },
            h("div", { className: "dc-moa-copy-header" },
              h("div", { className: "dc-moa-copy-header-left" },
                h("span", null, "智囊团对话"),
                h("div", { className: "dc-moa-copy-select-wrap" },
                  h("select", {
                    className: "dc-moa-copy-select",
                    value: activePreset,
                    title: "切换组合方案（与上方「组合方案」同一设置）",
                    onChange: function (e) { switchPreset(e.target.value); }
                  },
                    getPresetNames().map(function (name) {
                      return h("option", { key: name, value: name, selected: name === activePreset }, name);
                    })
                  )
                )
              ),
              h("div", { className: "dc-moa-copy-actions" },
                h("a", {
                  className: "dc-btn dc-btn-sm dc-btn-ghost",
                  href: "/dashboard-plugins/decuria/index.html?view=moa-full"
                    + ((typeof window !== "undefined" && window.__HERMES_SESSION_TOKEN__)
                        ? ("#tk=" + encodeURIComponent(window.__HERMES_SESSION_TOKEN__)) : ""),
                  target: "_blank",
                  rel: "noopener noreferrer",
                  title: "在新窗口打开对话页面",
                  style: { textDecoration: "none" }
                }, "⛶ 新窗口"),
                h("button", {
                  className: cn("dc-btn dc-btn-sm", applyState.applied && "dc-btn-success", applyState.applying && "dc-btn-loading"),
                  onClick: applyToHermes,
                  disabled: applyState.applying,
                  title: "将圆桌配置持久化到 Hermes（自动同步复制 YAML 到剪贴板）"
                }, applyState.applied ? "已应用 + 已复制 ✓" : (applyState.applying ? "应用中…" : "应用到 Hermes"))
              )
            ),
            applyState.error ? h("div", { className: "dc-moa-apply-err" }, applyState.error) : null,
            renderMoaChat()
          )
        ),
      );
    }

    // ---- data hook --------------------------------------------------------
    // Two-phase load for instant first paint ("秒开"):
    //   Phase 1 (fast, ~ms): /channels + /visibility + /providers — render the
    //     shell + current config immediately, do NOT block on the heavy call.
    //   Phase 2 (cached, ~ms warm): /model-universe — fills the picker's
    //     provider/model option lists. Loaded async so the UI never waits.
    function useDecuriaData() {
      var fastSt = useState({ loading: true, error: null, channels: null, visibility: null, providerState: null, keys: null, fallback: null });
      var fast = fastSt[0], setFast = fastSt[1];
      var uniSt = useState(null);
      var universe = uniSt[0], setUniverse = uniSt[1];

      function loadFast() {
        setFast({ loading: true, error: null, channels: null, visibility: null, providerState: null, keys: null, fallback: null });
        // Fallback models ride along in Phase 1 (cheap config.yaml read). Each
        // request is individually guarded so a missing/old backend endpoint can
        // never break the shell load — it just yields null (empty inputs).
        Promise.all([
          fetchJSON(API + "/channels"),
          fetchJSON(API + "/visibility"),
          fetchJSON(API + "/providers"),
          fetchJSON(API + "/keys"),
          fetchJSON(API + "/fallback").catch(function () { return null; })
        ]).then(function (r) {
          setFast({ loading: false, error: null, channels: r[0], visibility: r[1], providerState: r[2], keys: r[3] || { keys: {} }, fallback: r[4] || null });
        }).catch(function (err) {
          setFast({ loading: false, error: String((err && err.message) || err), channels: null, visibility: null, providerState: null, keys: null, fallback: null });
        });
      }

      function loadUniverse(refresh, generation) {
        var query = [];
        if (refresh) query.push("refresh=1");
        if (generation) query.push("generation=" + encodeURIComponent(generation));
        var url = API + "/model-universe" + (query.length ? ("?" + query.join("&")) : "");
        return fetchJSON(url)
          .then(function (u) { setUniverse(u); return u; })
          .catch(function (err) {
            if (refresh || generation) throw err;
            return null;
          });
      }

      function waitForUniverseRefresh(result, attempt) {
        attempt = attempt || 0;
        if (!result) return Promise.resolve(result);
        if (result.refresh_status === "error") {
          return Promise.reject(new Error(result.refresh_error || "模型刷新失败"));
        }
        if (!result.refreshing && result.refresh_status !== "refreshing") {
          return Promise.resolve(result);
        }
        if (attempt >= 60) {
          return Promise.reject(new Error("模型刷新后台任务超时"));
        }
        var generation = result.refresh_generation;
        return new Promise(function (resolve) { setTimeout(resolve, 2000); })
          .then(function () { return loadUniverse(false, generation); })
          .then(function (next) { return waitForUniverseRefresh(next, attempt + 1); });
      }

      useEffect(function () { loadFast(); }, []);
      useEffect(function () { loadUniverse(false); }, []);

      // After a provider add/remove/edit the universe cache is marked stale and
      // rebuilt in a BACKGROUND thread. Re-fetch once shortly after so the
      // 模型管理 tab reflects the change without the user manually refreshing.
      function reloadAll() { loadFast(); loadUniverse(false); setTimeout(function () { loadUniverse(false); }, 3000); }
      function reloadUniverse() { return loadUniverse(false); }
      // MoA 模型席 (/moa/models) 有独立缓存（TTL 15min），且后端会按 visibility
      // 过滤模型。可见性变更或模型宇宙刷新后必须重建这份缓存，否则新开 / 新隐藏
      // 的模型不会同步到智囊团模型席。重建只重读 universe 缓存并按 visibility
      // 过滤，无网络探测，成本极低。
      var universeRevSt = useState(0);
      var universeRev = universeRevSt[0], setUniverseRev = universeRevSt[1];
      function syncMoaCache(strict) {
        setUniverseRev(function (n) { return n + 1; });
        var request = fetchJSON(API + "/moa/models?refresh=1");
        return strict ? request : request.catch(function () { return null; });
      }
      function refreshUniverse() {
        return loadUniverse(true)
          .then(function (u) { return waitForUniverseRefresh(u, 0); })
          .then(function (u) {
            if (!u || u.refresh_status === "error") {
              throw new Error((u && u.refresh_error) || "模型刷新失败");
            }
            return syncMoaCache(true).then(function () { return u; });
          });
      }
      // Optimistically mirror a toggle's HIDDEN set into the canonical
      // fast.visibility state. Without this, switching tabs unmounts
      // VisibilitySection (losing its local visOn), and on return it
      // re-seeds from the STALE fast.visibility — so a just-toggled model
      // would appear "off" until a full page refresh re-fetches the backend.
      function patchVisibility(hiddenObj) {
        setFast(function (prev) {
          var prevVis = prev.visibility || { hidden: {} };
          return Object.assign({}, prev, {
            visibility: Object.assign({}, prevVis, { hidden: hiddenObj || {} })
          });
        });
      }
      // Optimistically mirror a channel/global SAVE into the canonical
      // fast.channels state. Without this, switching tabs unmounts
      // GlobalBar/ChannelRow (losing local state); on return they re-seed from
      // the STALE fast.channels and show the PRE-save value until a full page
      // refresh re-fetches the backend. Mirroring keeps the displayed value
      // correct across tab switches.
      function patchChannels(merge) {
        setFast(function (prev) {
          var ch = prev.channels || { global: {}, channels: [] };
          return Object.assign({}, prev, { channels: merge(ch) });
        });
      }
      function patchGlobal(data) {
        patchChannels(function (ch) {
          return Object.assign({}, ch, { global: Object.assign({}, ch.global, data) });
        });
      }
      function patchChannel(platform, channel_id, data) {
        patchChannels(function (ch) {
          var list = (ch.channels || []).map(function (c) {
            if (c.platform === platform && c.channel_id === channel_id) {
              return Object.assign({}, c, data);
            }
            return c;
          });
          return Object.assign({}, ch, { channels: list });
        });
      }
      function patchFallback(kind, data) {
        if (kind !== "image" && kind !== "vision" && kind !== "video") return;
        setFast(function (prev) {
          var fb = prev.fallback || { image: { model: "", provider: "", key: "" }, vision: { model: "", provider: "", key: "" }, video: { model: "", provider: "", key: "" } };
          var next = Object.assign({}, fb);
          next[kind] = Object.assign({}, next[kind], data);
          return Object.assign({}, prev, { fallback: next });
        });
      }
      function patchConfigBatch(payload) {
        if (payload.global_model) { patchGlobal(payload.global_model); }
        if (payload.fallback_image) { patchFallback("image", payload.fallback_image); }
        if (payload.fallback_vision) { patchFallback("vision", payload.fallback_vision); }
        if (payload.fallback_video) { patchFallback("video", payload.fallback_video); }
        if (payload.channels && payload.channels.length) {
          payload.channels.forEach(function (ch) {
            if (ch.model && ch.provider) { patchChannel(ch.platform, ch.channel_id, ch); }
          });
        }
      }
      return {
        fast: fast,
        universe: universe,
        reloadAll: reloadAll,
        reloadUniverse: reloadUniverse,
        refreshUniverse: refreshUniverse,
        syncMoaCache: syncMoaCache,
        universeRev: universeRev,
        patchVisibility: patchVisibility,
        patchGlobal: patchGlobal,
        patchChannel: patchChannel,
        patchFallback: patchFallback,
        patchConfigBatch: patchConfigBatch
      };
    }
    function App() {
      // 全屏聊天页：以 ?view=moa-full 在新窗口打开，仅渲染智囊团对话
      if (typeof window !== "undefined" && /[?&]view=moa-full\b/.test(window.location.search)) {
        return h("div", { className: "dc-moa-fullscreen-page" }, h(MoASection, { fullscreen: true }));
      }
      var tab = useState("config");
      var active = tab[0], setActive = tab[1];
      var d = useDecuriaData();
      var fast = d.fast;

      // Fast phase gates only a brief spinner; the heavy model universe is
      // loaded separately and never blocks the first paint.
      if (fast.loading) return h("div", { className: "dc-page" }, h(Hero, null), h(Spinner));
      if (fast.error) return h("div", { className: "dc-page" }, h(Hero, null), h(ErrorBanner, { message: fast.error }));

      var channels = fast.channels || { global: {}, channels: [] };
      var visibility = fast.visibility || { hidden: {} };
      var rawHidden = visibility.hidden || {};
      var providerState = fast.providerState || { disabled: [], configured: [], keyed: [] };
      var providerKeys = (fast.keys && fast.keys.keys) || {};

      var disabledSet = {};
      (providerState.disabled || []).forEach(function (s) { disabledSet[s] = true; });
      var configuredSet = {};
      (providerState.configured || []).forEach(function (s) { configuredSet[s] = true; });
      var keyedSet = {};
      (providerState.keyed || []).forEach(function (s) { keyedSet[s] = true; });

      var universe = d.universe;
      var provRowsRaw = (universe && universe.providers) || [];

      // Models currently referenced by channel_overrides / the global default
      // are "in use" and therefore ON by default in 模型管理. Everything else
      // defaults to OFF (hidden). This implements the "off-by-default,
      // enable-to-load" rule while keeping existing channel wiring working.
      var usedSet = {};
      function markUsed(provider, model) {
        if (!provider || !model) return;
        usedSet[provider] = usedSet[provider] || [];
        if (usedSet[provider].indexOf(model) < 0) usedSet[provider].push(model);
      }
      var g0 = channels.global || {};
      markUsed(g0.provider, g0.model);
      (channels.channels || []).forEach(function (ch) { markUsed(ch.provider, ch.model); });

      // effectiveHidden[slug] = models that are OFF.
      // Rule: if a provider has NO explicit visibility record in visibility.json,
      // apply "off-by-default" — every model not used by a channel is hidden.
      // If the provider HAS a record, the user has taken control: the hidden
      // set IS exactly fileHidden. Any model absent from fileHidden was
      // explicitly turned on by the user (removed from the hidden list), so it
      // stays visible — even if no channel currently uses it. This is what
      // makes toggles survive a refresh.
      var effectiveHidden = {};
      provRowsRaw.forEach(function (p) {
        var used = usedSet[p.slug] || [];
        var fileHidden = rawHidden[p.slug]; // undefined => no explicit record
        var eff = [];
        if (fileHidden === undefined) {
          // No record yet → off-by-default for non-used models.
          (p.models || []).forEach(function (m) {
            if (used.indexOf(m) < 0) eff.push(m);
          });
        } else {
          // Explicit record exists → the hidden set IS exactly fileHidden.
          // Any model absent from fileHidden was explicitly turned on by the
          // user (removed from the hidden list), so it stays visible — even if
          // no channel currently uses it. This is what makes toggles persist.
          // "*" keeps this provider default-OFF across future refreshes.
          // Explicit !visible:<model> entries are the user's enabled exceptions.
          if (fileHidden.indexOf("*") >= 0) {
            var allowed = {};
            fileHidden.forEach(function (item) {
              if (typeof item === "string" && item.indexOf("!visible:") === 0) {
                allowed[item.slice("!visible:".length)] = true;
              }
            });
            (p.models || []).forEach(function (m) {
              if (!allowed[m] && used.indexOf(m) < 0 && eff.indexOf(m) < 0) eff.push(m);
            });
          } else {
            fileHidden.forEach(function (m) { if (eff.indexOf(m) < 0) eff.push(m); });
          }
        }
        if (eff.length) effectiveHidden[p.slug] = eff;
      });

      // Seed current model/provider from /channels so the selects show the
      // saved value even before the universe finishes loading.
      var seedModels = {};
      var seedProviders = {};
      function seed(model, provider) {
        if (model) seedModels[model] = true;
        if (provider) seedProviders[provider] = true;
      }
      seed(g0.model, g0.provider);
      (channels.channels || []).forEach(function (ch) { seed(ch.model, ch.provider); });

      // Selectable models in 通道配置 = models that are ENABLED (not hidden)
      // in 模型管理, plus the currently-selected (seeded) values so existing
      // channel wiring never disappears from the dropdown.
      var allModelsSet = {};
      provRowsRaw.forEach(function (p) {
        var list = effectiveHidden[p.slug] || [];
        (p.models || []).forEach(function (m) {
          if (list.indexOf(m) < 0) allModelsSet[m] = true; // enabled
        });
      });
      Object.keys(seedModels).forEach(function (m) { allModelsSet[m] = true; });
      var allModels = Object.keys(allModelsSet).sort();

      // Provider -> enabled-models 联动查找：通道配置的模型下拉必须与所选
      // provider 关联——选了某 provider，模型列表只显示该 provider 下「开启」
      // 的模型；当前已选值作为 seed 兜底（宇宙未就绪、或已选模型被关时仍可见）。
      var provMap = {};
      provRowsRaw.forEach(function (p) { provMap[p.slug] = p; });
      function modelsForProvider(providerSlug, currentModel) {
        if (!providerSlug) return [];
        var p = provMap[providerSlug];
        if (!p) return currentModel ? [currentModel] : []; // 宇宙未就绪：仅保当前值
        var off = effectiveHidden[providerSlug] || [];
        var list = (p.models || []).filter(function (m) { return off.indexOf(m) < 0; });
        if (currentModel && list.indexOf(currentModel) < 0) list.push(currentModel);
        return list.sort();
      }

      // 通道配置 / 候补模型的供应商下拉：只显示「模型商管理」里已配置/已填密钥
      // 的提供商（configuredSet || keyedSet）。providers 管理页与 universe 里的
      // 未配置种子（OpenRouter/Nvidia/Google 等）一律不出现。
      var providerOptions = [];
      var pOptSeen = {};
      (providerState.providers || []).forEach(function (p) {
        var s = p.slug || "";
        if (!s || pOptSeen[s] || disabledSet[s]) return;
        if (!configuredSet[s] && !keyedSet[s]) return; // 只显示已配置/已填密钥的
        pOptSeen[s] = true;
        providerOptions.push({ slug: s, name: p.name || s });
      });
      // 兜底：渠道/fallback 实际引用且确为已配置的 provider，仍保留可见防断连。
      Object.keys(seedProviders).forEach(function (slug) {
        if (pOptSeen[slug] || disabledSet[slug]) return;
        if (!configuredSet[slug] && !keyedSet[slug]) return;
        pOptSeen[slug] = true;
        var uProv = null;
        for (var ui = 0; ui < provRowsRaw.length; ui++) {
          if (provRowsRaw[ui].slug === slug) { uProv = provRowsRaw[ui]; break; }
        }
        providerOptions.push({ slug: slug, name: (uProv && uProv.name) || slug });
      });

      // Providers-tab rows: built from the FAST /providers payload (no model
      // universe required), so 提供商管理 opens instantly. Green/yellow icon
      // reflects whether a credential is configured (keyed), which is what the
      // user cares about on this tab — the slow model probe is irrelevant here.
      // 最近添加的提供商固定排在第 1 位（后端在 state.last_added 中持久化）。
      var lastAdded = providerState.last_added || null;
      // 前端安全网：按名称去重（防止后端遗漏的重复提供商）
      var rawProviders = (providerState.providers || []);
      var seenMgmtNames = {};
      var dedupedProviders = [];
      rawProviders.forEach(function (p) {
        var norm = (p.name || p.slug || "").toLowerCase();
        if (!norm || seenMgmtNames[norm]) return;
        seenMgmtNames[norm] = true;
        dedupedProviders.push(p);
      });
      var provRowsForMgmt = dedupedProviders.slice().sort(function (a, b) {
        if (lastAdded) {
          if (a.slug === lastAdded) return -1;
          if (b.slug === lastAdded) return 1;
        }
        var ak = a.keyed ? 1 : 0;
        var bk = b.keyed ? 1 : 0;
        if (ak !== bk) return bk - ak;
        return (a.name || a.slug || "").localeCompare(b.name || b.slug || "");
      }).map(function (p) {
        return { slug: p.slug, name: p.name || p.slug, authenticated: !!p.authenticated, keyed: !!p.keyed };
      });

      // Provider management order: 填了 k 的排上面，没填的自动在下面；组内按名排序。
      var provRows = provRowsRaw.slice().sort(function (a, b) {
        var ak = keyedSet[a.slug] ? 1 : 0;
        var bk = keyedSet[b.slug] ? 1 : 0;
        if (ak !== bk) return bk - ak;
        return (a.name || a.slug || "").localeCompare(b.name || b.slug || "");
      });

      var onCountAll = 0, totalAllCount = 0;
      provRowsRaw.forEach(function (p) {
        var list = effectiveHidden[p.slug] || [];
        (p.models || []).forEach(function (m) {
          totalAllCount++;
          if (list.indexOf(m) < 0) onCountAll++;
        });
      });

      var TABS = [
        { key: "config", label: T.tabConfig },
        { key: "visibility", label: T.tabVisibility },
        { key: "providers", label: T.tabProviders },
        { key: "moa", label: T.tabMoA }
      ];

      var content;
      switch (active) {
        case "config":
          content = h(ConfigSection, { channels: channels, modelsResolver: modelsForProvider, providerOptions: providerOptions, providerKeys: providerKeys, fallback: fast.fallback, onSavedAll: d.patchConfigBatch });
          break;
        case "visibility":
          // Prefer the full universe; fall back to the fast provider list so the
          // tab ALWAYS opens (never stuck on "加载中") even during a one-time
          // cold universe build. Models fill in once the universe arrives.
          var visRows = universe ? provRows : (providerState.providers || []).map(function (p) {
            return { slug: p.slug, name: p.name || p.slug, models: [], authenticated: !!p.authenticated };
          });
          content = h(VisibilitySection, { provRows: visRows, hiddenByProvider: effectiveHidden, rawHiddenByProvider: rawHidden, lastAdded: lastAdded, onVisibilityChange: d.patchVisibility, onVisibilitySaved: d.syncMoaCache, onRefresh: d.refreshUniverse });
          break;
        case "providers":
          // Decoupled from the (slow, probed) model universe — built from the
          // fast /providers payload so the tab is instant even on first paint.
          content = (providerState.providers && providerState.providers.length)
            ? h(ProviderManagementSection, { provRows: provRowsForMgmt, disabledSet: disabledSet, configuredSet: configuredSet, keyedSet: keyedSet, onChanged: d.reloadAll })
            : h(Loader, { text: "提供商清单加载中…" });
          break;
        case "moa":
          content = h(MoASection, { universeRev: d.universeRev });
          break;
        default:
          content = h("div", { className: "dc-empty" }, "Unknown tab");
      }

      return h("div", { className: "dc-page" },
        h("div", { className: "dc-hero" },
          h("div", { className: "dc-hero-text" },
            h("div", { className: "dc-kicker" }, T.heroKicker),
            h("h1", { className: "dc-hero-title" }, T.heroTitle),
            h("p", null, T.heroSub)
          ),
          h(Stats, {
            channelCount: (channels.channels || []).length,
            providerCount: provRowsRaw.length || (providerState.configured || []).length,
            modelCount: universe ? allModels.length : "…",
            visibleCount: onCountAll
          })
        ),
        h(Tabs, { tabs: TABS, active: active, onTab: setActive }),
        content,
        active === "config" && h("div", { className: "dc-footer" },
          h("div", { className: "dc-banner dc-banner-warn" }, T.footerNote)
        )
      );
    }

    REG.register("decuria", App);

    // 独立模式：Dashboard 不会帮我们渲染，需要自己挂载到 #decuria-root
    if (window.__hermes_boot_standalone) {
      var rootEl = document.getElementById("decuria-root");
      if (rootEl && window.preact && window.preact.render) {
        try { window.preact.render(h(App), rootEl); } catch(e) { console.error("[decuria] standalone mount failed:", e); }
      }
    }
  }

  if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
