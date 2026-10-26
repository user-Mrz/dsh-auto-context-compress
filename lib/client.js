// dsh-auto-context-compress — browser half.
//
// Contract: the DSH client-module scanner bundles `exports["./client"]` and the
// page evaluates it under `window.__ModuleLoader__`. The factory receives a
// `require` (unused here: this overlay has no dependencies) and must return an
// object carrying `inject` and `apply`.
//
// Why raw DOM instead of a slot + React, exactly like the sibling
// `dsh-token-usage-hud`: a floating readout is shell chrome, not conversation
// content. Appending to `document.body` keeps the whole contribution inside one
// `ctx.effect`, so unloading the plugin removes every node and listener without
// touching the product's layout or any seat it declares.
//
// The current conversation is read from DSH 0.2's `uiSession.current` binding
// (`key` is the session id), with two fallbacks: the shipped UI's
// `byId[id].retainedBy.mainView` retention fact, and the 0.1 list snapshot's
// `current` field. Desktop renders this same web client inside `dsh-app://app/`,
// so the route is fetched through a document-relative URL and the shell forwards
// it to the loopback host.

window.__ModuleLoader__.load({
  id: "dsh-auto-context-compress",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    //#region dsh-auto-context-compress client
    /** Services required by the browser half. */
    const inject = ["sessions"];
    // No leading slash on purpose: the Web shell may be mounted under a path
    // prefix (`--public-url`), and Desktop serves the same document from
    // `dsh-app://app/`. A relative URL keeps the request on the document's own
    // mount, exactly like the official connection client does.
    const API_PATH = "api/auto-context-compress";
    const HIDDEN_KEY = "dsh-auto-context-compress.hidden";
    const POS_KEY = "dsh-auto-context-compress.pos";
    const DEFAULT_POLL_MS = 2000;

    function resolveClientConfig(config) {
      const cfg = config ?? {};
      return {
        pollMs:
          typeof cfg.pollMs === "number" && Number.isFinite(cfg.pollMs) && cfg.pollMs >= 300
            ? Math.round(cfg.pollMs)
            : DEFAULT_POLL_MS,
        position: cfg.position === "bottom-right" || cfg.position === "top-center" ? cfg.position : "top-right",
        visible: cfg.visible !== false,
      };
    }

    function trimZero(s) {
      return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    }

    function fmtTokens(n) {
      if (!Number.isFinite(n) || n <= 0) return "0";
      if (n >= 1e6) return trimZero((n / 1e6).toFixed(2)) + "M";
      if (n >= 1e3) return trimZero((n / 1e3).toFixed(1)) + "k";
      return String(Math.round(n));
    }

    function fmtPercent(ratio) {
      if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "--";
      const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
      return (clamped * 100).toFixed(1) + "%";
    }

    function apply(ctx, config) {
      const options = resolveClientConfig(config);

      ctx.effect(() => {
        let timer = null;
        let unsubList = null;
        let unsubCurrent = null;
        let root = null;
        let pill = null;
        let bodyEl = null;
        let gaugeFill = null;
        let infoEl = null;
        let actionsEl = null;
        let toggleBtn = null;
        let forceBtn = null;
        let currentId = null;
        let disposed = false;
        let lastPayload = null;

        // ── stylesheet (one tag per plugin, removed on dispose) ──────────────
        (() => {
          const css = [
            '[data-acx="box"]{position:fixed;z-index:2147483000;width:236px;padding:8px 10px;border-radius:10px;',
            'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));',
            'background:var(--dsw-alias-bg-layer-3, rgba(15,20,26,.92));color:var(--dsw-alias-label-primary, #d8e0ea);',
            'font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 6px 24px rgba(0,0,0,.28);',
            'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);user-select:none;pointer-events:auto}',
            '[data-acx="box"][data-position="top-right"]{top:10px;right:12px}',
            '[data-acx="box"][data-position="top-center"]{top:10px;left:50%;transform:translateX(-50%)}',
            '[data-acx="box"][data-position="bottom-right"]{bottom:10px;right:12px}',
            // Desktop draws native caption buttons over the top edge; the
            // shipped shell publishes its titlebar height as a CSS variable
            // and drops it in fullscreen (`data-fullscreen`).
            'html[data-windows-titlebar] [data-acx="box"][data-position="top-right"],',
            'html[data-windows-titlebar] [data-acx="box"][data-position="top-center"]',
            '{top:calc(var(--dsh-windows-titlebar-height, 40px) + 10px)}',
            'html[data-windows-titlebar][data-fullscreen] [data-acx="box"][data-position="top-right"],',
            'html[data-windows-titlebar][data-fullscreen] [data-acx="box"][data-position="top-center"],',
            'html[data-windows-titlebar][data-fullscreen] [data-acx="pill"][data-position="top-right"],',
            'html[data-windows-titlebar][data-fullscreen] [data-acx="pill"][data-position="top-center"]',
            '{top:10px !important}',
            '[data-acx="box"] [data-acx="head"]{display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:grab;touch-action:none}',
            '[data-acx="box"][data-dragging="true"] [data-acx="head"]{cursor:grabbing}',
            '[data-acx="box"] [data-acx="title"]{flex:1;font-weight:600;color:var(--dsw-alias-label-secondary, #9fb3c8);letter-spacing:.02em}',
            '[data-acx="box"] [data-acx="dot"]{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
            '[data-acx="box"][data-level="ok"] [data-acx="dot"]{color:var(--dsw-alias-state-success-primary, #37d67a)}',
            '[data-acx="box"][data-level="soft"] [data-acx="dot"]{color:var(--dsw-alias-state-warn-primary, #f5b85c)}',
            '[data-acx="box"][data-level="hard"] [data-acx="dot"]{color:var(--dsw-alias-state-error-primary, #f06a6a)}',
            '[data-acx="box"][data-level="unknown"] [data-acx="dot"]{color:var(--dsw-alias-label-secondary, #9fb3c8)}',
            '[data-acx="box"] [data-acx="close"]{appearance:none;border:0;background:none;color:var(--dsw-alias-label-secondary, #9fb3c8);cursor:pointer;font:12px/1 monospace;padding:1px 4px;border-radius:4px}',
            '[data-acx="box"] [data-acx="close"]:hover{color:var(--dsw-alias-label-primary, #d8e0ea);background:rgba(255,255,255,.08)}',
            '[data-acx="box"] [data-acx="gauge"]{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.10));overflow:hidden;margin-bottom:6px}',
            '[data-acx="box"] [data-acx="fill"]{display:block;height:100%;width:0;background:currentColor;transition:width .25s ease}',
            '[data-acx="box"][data-level="ok"] [data-acx="fill"]{color:var(--dsw-alias-state-success-primary, #37d67a)}',
            '[data-acx="box"][data-level="soft"] [data-acx="fill"]{color:var(--dsw-alias-state-warn-primary, #f5b85c)}',
            '[data-acx="box"][data-level="hard"] [data-acx="fill"]{color:var(--dsw-alias-state-error-primary, #f06a6a)}',
            '[data-acx="box"] [data-acx="body"]{margin:0;white-space:pre-wrap;word-break:break-word;color:inherit}',
            '[data-acx="box"] [data-acx="actions"]{display:flex;gap:6px;margin-top:7px}',
            '[data-acx="box"] [data-acx="actions"] button{flex:1;appearance:none;cursor:pointer;padding:3px 6px;border-radius:6px;',
            'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06));',
            'color:var(--dsw-alias-label-secondary, #9fb3c8);font:11px/1.5 ui-monospace,Menlo,Consolas,monospace}',
            '[data-acx="box"] [data-acx="actions"] button:hover{color:var(--dsw-alias-label-primary, #d8e0ea)}',
            '[data-acx="box"] [data-acx="actions"] button:disabled{opacity:.5;cursor:progress}',
            '[data-acx="box"] [data-acx="actions"] button[data-on="true"]{color:var(--dsw-alias-brand-primary, #6ab0ff);border-color:var(--dsw-alias-brand-primary, #6ab0ff)}',
            '[data-acx="pill"]{position:fixed;z-index:2147483000;top:10px;right:12px;padding:4px 10px;border-radius:999px;',
            'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-3, rgba(15,20,26,.92));',
            'color:var(--dsw-alias-label-secondary, #9fb3c8);font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;cursor:pointer;',
            'box-shadow:0 4px 16px rgba(0,0,0,.24)}',
            '[data-acx="pill"]:hover{color:var(--dsw-alias-label-primary, #d8e0ea)}',
          ].join('');
          if (
            typeof document !== "undefined" &&
            document.querySelector('style[data-plugin-css="dsh-auto-context-compress"]') === null
          ) {
            const tag = document.createElement("style");
            tag.dataset.plugin = "dsh-auto-context-compress";
            tag.dataset.pluginCss = "dsh-auto-context-compress";
            tag.textContent = css;
            document.head.appendChild(tag);
          }
        })();

        const hidden = () => {
          try {
            return localStorage.getItem(HIDDEN_KEY) === "1";
          } catch {
            return false;
          }
        };

        const readSavedPos = () => {
          try {
            const raw = localStorage.getItem(POS_KEY);
            if (raw === null) return null;
            const parsed = JSON.parse(raw);
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              typeof parsed.left === "number" &&
              typeof parsed.top === "number" &&
              Number.isFinite(parsed.left) &&
              Number.isFinite(parsed.top)
            ) {
              return { left: parsed.left, top: parsed.top };
            }
          } catch {
            /* ignore */
          }
          return null;
        };

        const writeSavedPos = (left, top) => {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
          } catch {
            /* ignore */
          }
        };

        const clearSavedPos = () => {
          try {
            localStorage.removeItem(POS_KEY);
          } catch {
            /* ignore */
          }
        };

        const positionCss = (position) => {
          const top = "calc(var(--dsh-windows-titlebar-height, 0px) + 10px)";
          if (position === "top-center") return `top:${top};left:50%;transform:translateX(-50%)`;
          if (position === "bottom-right") return "bottom:10px;right:12px";
          return `top:${top};right:12px`;
        };

        const ensureVisible = () => {
          if (disposed) return;
          if (typeof document === "undefined" || document.body === null) return;
          if (!options.visible) return;
          if (hidden()) {
            showPill();
            return;
          }
          showBox();
        };

        const showPill = () => {
          if (pill !== null || typeof document === "undefined" || document.body === null) return;
          pill = document.createElement("button");
          pill.dataset.acx = "pill";
          pill.textContent = "⚡ 压缩";
          const saved = readSavedPos();
          if (saved !== null) {
            pill.style.left = saved.left + "px";
            pill.style.top = saved.top + "px";
          } else {
            pill.setAttribute("data-position", options.position);
            pill.style.cssText = positionCss(options.position);
          }
          pill.addEventListener("click", () => {
            try {
              localStorage.setItem(HIDDEN_KEY, "0");
            } catch {
              /* ignore */
            }
            hidePill();
            showBox();
            poll();
          });
          document.body.appendChild(pill);
        };

        const hidePill = () => {
          if (pill !== null) pill.remove();
          pill = null;
        };

        /** Header drag: pointer capture, persisted on release, double-click resets. */
        const attachDrag = (handle) => {
          let dragging = false;
          let startX = 0;
          let startY = 0;
          let rect = null;
          const onDown = (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            dragging = true;
            startX = event.clientX;
            startY = event.clientY;
            rect = root.getBoundingClientRect();
            root.setAttribute("data-dragging", "true");
            try {
              handle.setPointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
            event.preventDefault();
          };
          const onMove = (event) => {
            if (!dragging || rect === null) return;
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - root.offsetHeight);
            const left = Math.min(Math.max(rect.left + dx, 0), maxLeft);
            const top = Math.min(Math.max(rect.top + dy, 0), maxTop);
            root.removeAttribute("data-position");
            root.style.left = left + "px";
            root.style.top = top + "px";
          };
          const onUp = (event) => {
            if (!dragging) return;
            dragging = false;
            rect = null;
            root.removeAttribute("data-dragging");
            try {
              handle.releasePointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
            writeSavedPos(parseFloat(root.style.left) || 0, parseFloat(root.style.top) || 0);
          };
          handle.addEventListener("pointerdown", onDown);
          handle.addEventListener("pointermove", onMove);
          handle.addEventListener("pointerup", onUp);
          handle.addEventListener("pointercancel", onUp);
          handle.addEventListener("dblclick", () => {
            if (root === null) return;
            clearSavedPos();
            root.removeAttribute("data-dragging");
            root.style.left = "";
            root.style.top = "";
            root.setAttribute("data-position", options.position);
          });
        };

        const showBox = () => {
          if (root !== null || typeof document === "undefined" || document.body === null) return;

          root = document.createElement("div");
          root.dataset.acx = "box";
          root.setAttribute("data-position", options.position);
          root.setAttribute("data-level", "unknown");
          const saved = readSavedPos();
          if (saved !== null) {
            root.removeAttribute("data-position");
            root.style.left = saved.left + "px";
            root.style.top = saved.top + "px";
          }

          const head = document.createElement("div");
          head.dataset.acx = "head";
          const title = document.createElement("span");
          title.dataset.acx = "title";
          title.textContent = "上下文压缩";
          const dot = document.createElement("span");
          dot.dataset.acx = "dot";
          const close = document.createElement("button");
          close.dataset.acx = "close";
          close.type = "button";
          close.textContent = "×";
          close.title = "收起为小圆点（不会关闭自动压缩）";
          close.addEventListener("click", () => {
            try {
              localStorage.setItem(HIDDEN_KEY, "1");
            } catch {
              /* ignore */
            }
            hideBox();
            showPill();
          });
          head.appendChild(title);
          head.appendChild(dot);
          head.appendChild(close);
          attachDrag(head);

          const gauge = document.createElement("div");
          gauge.dataset.acx = "gauge";
          gaugeFill = document.createElement("span");
          gaugeFill.dataset.acx = "fill";
          gauge.appendChild(gaugeFill);

          bodyEl = document.createElement("pre");
          bodyEl.dataset.acx = "body";
          bodyEl.textContent = "加载中…";

          infoEl = document.createElement("div");
          infoEl.dataset.acx = "body";
          infoEl.style.marginTop = "6px";
          infoEl.style.color = "var(--dsw-alias-label-secondary, #9fb3c8)";

          actionsEl = document.createElement("div");
          actionsEl.dataset.acx = "actions";
          forceBtn = document.createElement("button");
          forceBtn.type = "button";
          forceBtn.textContent = "立即压缩";
          forceBtn.addEventListener("click", () => {
            request(currentId, { force: "prune" });
          });
          toggleBtn = document.createElement("button");
          toggleBtn.type = "button";
          toggleBtn.addEventListener("click", () => {
            const nowOn = lastPayload !== null && lastPayload.enabled === true;
            request(currentId, { enabled: nowOn ? "0" : "1" });
          });
          actionsEl.appendChild(forceBtn);
          actionsEl.appendChild(toggleBtn);

          root.appendChild(head);
          root.appendChild(gauge);
          root.appendChild(bodyEl);
          root.appendChild(infoEl);
          root.appendChild(actionsEl);
          document.body.appendChild(root);
        };

        const hideBox = () => {
          if (root !== null) root.remove();
          root = null;
          bodyEl = null;
          gaugeFill = null;
          infoEl = null;
          actionsEl = null;
          toggleBtn = null;
          forceBtn = null;
        };

        /** Render one route payload. Only textContent is used — never innerHTML. */
        const render = (payload) => {
          if (bodyEl === null) return;
          if (payload === null || payload === undefined) {
            bodyEl.textContent = "读取中…";
            if (gaugeFill !== null) gaugeFill.style.width = "0";
            if (infoEl !== null) infoEl.textContent = "";
            return;
          }
          const capacity = payload.capacity;
          const level = capacity !== null && capacity !== undefined && typeof capacity.level === "string" ? capacity.level : "unknown";
          root.setAttribute("data-level", level);

          const lines = [];
          if (typeof payload.title === "string" && payload.title.length > 0) {
            lines.push(payload.title);
          }
          if (capacity === null || capacity === undefined) {
            lines.push("无容量读数（对话未激活或投影不可用）");
            if (gaugeFill !== null) gaugeFill.style.width = "0";
          } else {
            const percent = fmtPercent(capacity.ratio);
            const used = fmtTokens(capacity.usedTokens);
            const window_ = capacity.contextWindow !== null && capacity.contextWindow !== undefined
              ? fmtTokens(capacity.contextWindow)
              : "?";
            lines.push("占用 " + percent + "   " + used + " / " + window_);
            lines.push("级别 " + level);
            if (gaugeFill !== null) {
              const ratio = typeof capacity.ratio === "number" && Number.isFinite(capacity.ratio) ? capacity.ratio : 0;
              const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
              gaugeFill.style.width = (clamped * 100).toFixed(1) + "%";
            }
          }
          bodyEl.textContent = lines.join("\n");

          const info = [];
          if (capacity !== null && capacity !== undefined && capacity.breakdown !== null && capacity.breakdown !== undefined) {
            const b = capacity.breakdown;
            info.push("系统 " + fmtTokens(b.systemTokens) + " · 工具 " + fmtTokens(b.toolsTokens) + " · 消息 " + fmtTokens(b.messageTokens));
          }
          info.push("已裁剪 " + (payload.prunedResults ?? 0) + " 条 · 回收 " + fmtTokens(payload.reclaimedTokens));
          if (typeof payload.summaries === "number" && payload.summaries > 0) {
            info.push("摘要 " + payload.summaries + " 次");
          }
          if (payload.armed === true) {
            info.push("已预约：下次请求前会先询问");
          }
          if (typeof payload.error === "string" && payload.error.length > 0) {
            info.push("⚠ " + payload.error);
          } else if (typeof payload.lastDetail === "string" && payload.lastDetail.length > 0) {
            info.push("上次 " + payload.lastDetail);
          }
          if (infoEl !== null) infoEl.textContent = info.join("\n");

          if (toggleBtn !== null) {
            const enabled = payload.enabled === true;
            toggleBtn.textContent = enabled ? "自动：开" : "自动：关";
            toggleBtn.setAttribute("data-on", enabled ? "true" : "false");
            toggleBtn.title = enabled ? "点击关闭自动压缩（全局）" : "点击开启自动压缩（全局）";
          }
          if (forceBtn !== null) {
            forceBtn.disabled = currentId === null || currentId === undefined;
            forceBtn.title = "对该对话预约一次裁剪；将在它下一次模型请求前弹确认卡";
          }
        };

        const request = async (sessionId, params) => {
          if (typeof sessionId !== "string" || sessionId.length === 0) return;
          if (forceBtn !== null) forceBtn.disabled = true;
          if (toggleBtn !== null) toggleBtn.disabled = true;
          let query = "?session=" + encodeURIComponent(sessionId);
          if (params !== null && params !== undefined) {
            if (typeof params.force === "string") query += "&force=" + encodeURIComponent(params.force);
            if (typeof params.enabled === "string") query += "&enabled=" + encodeURIComponent(params.enabled);
          }
          try {
            const response = await fetch(API_PATH + query, { cache: "no-store" });
            if (response.ok) {
              const payload = await response.json();
              if (!disposed && payload !== null && typeof payload === "object") {
                lastPayload = payload;
                render(payload);
              }
            }
          } catch (error) {
            console.debug("[dsh-auto-context-compress] request degraded:", error);
          } finally {
            if (!disposed) {
              if (forceBtn !== null) forceBtn.disabled = false;
              if (toggleBtn !== null) toggleBtn.disabled = false;
            }
          }
        };

        const poll = async () => {
          if (disposed || root === null) return;
          if (typeof currentId !== "string" || currentId.length === 0) {
            render(null);
            if (infoEl !== null) infoEl.textContent = "无活动对话";
            return;
          }
          let payload = null;
          try {
            const response = await fetch(API_PATH + "?session=" + encodeURIComponent(currentId), { cache: "no-store" });
            if (response.ok) {
              const body = await response.json();
              if (body !== null && typeof body === "object") payload = body;
            }
          } catch (error) {
            console.debug("[dsh-auto-context-compress] poll degraded:", error);
          }
          if (disposed) return;
          if (payload === null) {
            if (infoEl !== null) infoEl.textContent = "压缩服务不可用";
            return;
          }
          lastPayload = payload;
          render(payload);
        };

        const asId = (value) => (typeof value === "string" && value.length > 0 ? value : null);

        /**
         * The current conversation id, across DSH client generations.
         *
         * DSH 0.2 removed the `current` field from the session list snapshot and
         * records "what the main view is showing" as `uiSession.current`, whose
         * binding value carries the session id in `key`. The retention count
         * (`byId[id].retainedBy.mainView`) is the same fact the shipped UI uses
         * to choose the main conversation, so it is the fallback when
         * `uiSession` has not materialized yet. The 0.1 `snapshot.current` shape
         * stays readable at the end.
         */
        const currentSessionOf = () => {
          try {
            const ui = ctx.get("uiSession");
            const value = ui?.current?.getSnapshot?.();
            const key = value !== null && typeof value === "object" ? asId(value.key) : null;
            if (key !== null) return key;
          } catch {
            /* optional service */
          }
          try {
            const sessions = ctx.get("sessions");
            const snapshot = sessions?.list?.getSnapshot?.() ?? null;
            if (snapshot === null || typeof snapshot !== "object") return null;
            const legacy = asId(snapshot.current);
            if (legacy !== null) return legacy;
            const byId = snapshot.byId;
            if (byId === null || typeof byId !== "object") return null;
            for (const id of Object.keys(byId)) {
              const row = byId[id];
              const retained = row !== null && typeof row === "object" ? row.retainedBy : undefined;
              if (retained !== null && typeof retained === "object" && (retained.mainView ?? 0) > 0) return id;
            }
          } catch {
            /* no usable session list */
          }
          return null;
        };

        /** Follow the current conversation, exactly like the sibling HUD. */
        const refresh = () => {
          attachCurrent();
          const next = currentSessionOf();
          if (next !== currentId) {
            currentId = next;
            if (bodyEl !== null) bodyEl.textContent = "加载中…";
          }
          if (disposed) return;
          ensureVisible();
          poll();
        };

        /**
         * Subscribe to `uiSession.current` once it exists.
         *
         * The overlay may materialize before the 0.2 Session UI plugin, so the
         * service is looked up on every refresh until its source is found; the
         * 2 s poll still bounds every case where it never appears.
         */
        const attachCurrent = () => {
          if (unsubCurrent !== null || disposed) return;
          try {
            const ui = ctx.get("uiSession");
            const dispose = ui?.current?.subscribe?.(refresh);
            if (typeof dispose === "function") unsubCurrent = dispose;
          } catch (error) {
            console.debug("[dsh-auto-context-compress] uiSession subscribe degraded:", error);
          }
        };

        try {
          const sessions = ctx.get("sessions");
          const dispose = sessions?.list?.subscribe?.(refresh);
          unsubList = typeof dispose === "function" ? dispose : null;
        } catch (error) {
          console.debug("[dsh-auto-context-compress] list subscribe degraded:", error);
        }
        attachCurrent();

        if (!options.visible) {
          return () => {
            disposed = true;
            clearInterval(timer);
            unsubList?.();
            unsubCurrent?.();
            hideBox();
            hidePill();
          };
        }

        timer = setInterval(refresh, options.pollMs);
        refresh();

        return () => {
          disposed = true;
          clearInterval(timer);
          unsubList?.();
          unsubCurrent?.();
          hideBox();
          hidePill();
          try {
            const tag = document.querySelector('style[data-plugin-css="dsh-auto-context-compress"]');
            if (tag !== null) tag.remove();
          } catch {
            /* ignore */
          }
        };
      }, "dsh-auto-context-compress: overlay");
    }
    //#endregion
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
