(() => {
  if (globalThis.__qmSharedBrowserLoaded) return;
  globalThis.__qmSharedBrowserLoaded = true;
  const requestChannel = "qm-shared-browser-request";
  const responseChannel = "qm-shared-browser-response";
  const refs = new WeakMap();
  const elements = new Map();
  const actorSequences = new Map();
  const cursors = new Map();
  const barriers = new Map();
  const auditRecords = [];
  let hud;
  let nextRef = 1;

  const refFor = (element) => {
    const current = refs.get(element);
    if (current) return current;
    const ref = `qm-${nextRef++}`;
    refs.set(element, ref);
    elements.set(ref, element);
    return ref;
  };

  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };

  const text = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);

  const labelFor = (element) => {
    const aria = element.getAttribute("aria-label");
    if (aria) return text(aria);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (label.trim()) return text(label);
    }
    if (element.labels?.length)
      return text(
        Array.from(element.labels)
          .map((label) => label.textContent ?? "")
          .join(" "),
      );
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return text(placeholder);
    const roleLabel = element.closest("[role=listitem], [role=group], [role=radiogroup]")?.textContent;
    if (roleLabel) return text(roleLabel);
    return text(element.textContent || element.getAttribute("name") || element.id);
  };

  const observe = () => {
    const selector = [
      "input:not([type=hidden])",
      "textarea",
      "select",
      "button",
      "a[href]",
      "[role=button]",
      "[role=checkbox]",
      "[role=radio]",
      "[contenteditable=true]",
    ].join(",");
    const interactables = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 500);
    return {
      url: location.href,
      title: document.title,
      elements: interactables.map((element) => ({
        ref: refFor(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        type: element.getAttribute("type") || "",
        label: labelFor(element),
        value: "value" in element ? text(element.value) : "",
        checked: "checked" in element ? Boolean(element.checked) : element.getAttribute("aria-checked") === "true",
        disabled: "disabled" in element ? Boolean(element.disabled) : element.getAttribute("aria-disabled") === "true",
      })),
    };
  };

  const setNativeValue = (element, value) => {
    if (element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return;
    }
    let prototype = HTMLInputElement.prototype;
    if (element instanceof HTMLTextAreaElement) prototype = HTMLTextAreaElement.prototype;
    else if (element instanceof HTMLSelectElement) prototype = HTMLSelectElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("element has no native value setter");
    setter.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const colorFor = (actorId) => {
    const palette = ["#2563eb", "#ef4444", "#16a34a", "#a855f7", "#ea580c", "#0891b2", "#db2777", "#65a30d"];
    let hash = 0;
    for (const char of actorId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return palette[hash % palette.length];
  };

  const ensureHud = () => {
    if (hud?.isConnected) return hud;
    hud = document.createElement("div");
    hud.dataset.qmSharedBrowserOverlay = "true";
    Object.assign(hud.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483647",
      width: "270px",
      overflow: "hidden",
      color: "white",
      background: "rgb(17 24 39 / 94%)",
      border: "1px solid rgb(255 255 255 / 18%)",
      borderRadius: "12px",
      boxShadow: "0 12px 30px rgb(0 0 0 / 30%)",
      font: "12px system-ui, sans-serif",
      pointerEvents: "none",
    });
    const heading = document.createElement("div");
    Object.assign(heading.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "10px 12px",
      fontWeight: "650",
      borderBottom: "1px solid rgb(255 255 255 / 12%)",
    });
    const liveDot = document.createElement("span");
    const title = document.createElement("span");
    const live = document.createElement("span");
    Object.assign(liveDot.style, {
      width: "8px",
      height: "8px",
      borderRadius: "50%",
      background: "#22c55e",
      boxShadow: "0 0 0 4px rgb(34 197 94 / 18%)",
    });
    title.textContent = "QM shared computer use";
    live.textContent = "LIVE";
    Object.assign(live.style, { marginLeft: "auto", fontSize: "10px", color: "#86efac" });
    heading.append(liveDot, title, live);
    hud.appendChild(heading);
    document.documentElement.appendChild(hud);
    return hud;
  };

  const ensureActor = (actorId) => {
    let overlay = cursors.get(actorId);
    if (overlay) return overlay;
    const color = colorFor(actorId);
    const cursor = document.createElement("div");
    const pointer = document.createElement("div");
    const label = document.createElement("div");
    const ring = document.createElement("div");
    const panel = document.createElement("div");
    const status = document.createElement("div");
    cursor.dataset.qmSharedBrowserOverlay = "true";
    ring.dataset.qmSharedBrowserOverlay = "true";
    panel.dataset.qmSharedBrowserOverlay = "true";
    Object.assign(cursor.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      display: "flex",
      alignItems: "flex-start",
      gap: "2px",
      transition: "transform 180ms ease-out",
    });
    Object.assign(pointer.style, {
      width: "18px",
      height: "22px",
      background: color,
      clipPath: "polygon(0 0, 100% 68%, 58% 72%, 42% 100%)",
      filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 55%))",
    });
    Object.assign(label.style, {
      marginTop: "15px",
      color: "white",
      background: color,
      borderRadius: "999px",
      padding: "3px 8px",
      whiteSpace: "nowrap",
      font: "600 12px system-ui, sans-serif",
      boxShadow: "0 2px 5px rgb(0 0 0 / 35%)",
    });
    label.textContent = actorId;
    cursor.append(pointer, label);
    Object.assign(ring.style, {
      position: "fixed",
      zIndex: "2147483646",
      pointerEvents: "none",
      border: `3px solid ${color}`,
      borderRadius: "8px",
      boxShadow: `0 0 0 4px color-mix(in srgb, ${color} 22%, transparent)`,
      transition: "left 180ms ease-out, top 180ms ease-out, width 180ms ease-out, height 180ms ease-out",
    });
    Object.assign(panel.style, {
      display: "grid",
      gridTemplateColumns: "10px 1fr",
      columnGap: "8px",
      padding: "9px 12px",
      borderBottom: "1px solid rgb(255 255 255 / 10%)",
    });
    const dot = document.createElement("span");
    Object.assign(dot.style, { width: "8px", height: "8px", marginTop: "3px", borderRadius: "50%", background: color });
    const details = document.createElement("div");
    const name = document.createElement("div");
    name.textContent = actorId;
    Object.assign(name.style, { fontWeight: "650", lineHeight: "14px" });
    Object.assign(status.style, { marginTop: "2px", color: "#cbd5e1", lineHeight: "15px" });
    details.append(name, status);
    panel.append(dot, details);
    ensureHud().appendChild(panel);
    document.documentElement.append(cursor, ring);
    overlay = { cursor, ring, status, element: undefined };
    cursors.set(actorId, overlay);
    return overlay;
  };

  const positionActor = (overlay, element) => {
    const rect = element.getBoundingClientRect();
    overlay.cursor.style.transform = `translate(${Math.max(0, rect.left - 10)}px, ${Math.max(0, rect.top - 18)}px)`;
    Object.assign(overlay.ring.style, {
      left: `${Math.max(0, rect.left - 5)}px`,
      top: `${Math.max(0, rect.top - 5)}px`,
      width: `${rect.width + 10}px`,
      height: `${rect.height + 10}px`,
    });
    overlay.element = element;
  };

  const showActor = (actorId, element, operation, state) => {
    const overlay = ensureActor(actorId);
    positionActor(overlay, element);
    const target = labelFor(element) || operation.ref;
    const suffix = state === "waiting" ? `waiting for ${operation.participants} agents` : state;
    overlay.status.textContent = `${operation.kind} · ${target} · ${suffix}`;
  };

  const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

  const rendezvous = (actorId, operation) => {
    if (!operation.syncKey) return Promise.resolve({ releasedAt: Date.now() });
    const participants = Number(operation.participants ?? 2);
    if (!Number.isSafeInteger(participants) || participants < 2)
      throw new Error("participants must be an integer of at least 2");
    let barrier = barriers.get(operation.syncKey);
    if (!barrier) {
      barrier = { actors: new Set(), participants, waiters: [], timer: undefined };
      barriers.set(operation.syncKey, barrier);
    }
    if (barrier.participants !== participants) throw new Error("barrier participant count does not match");
    if (barrier.actors.has(actorId)) throw new Error(`actor already joined barrier: ${actorId}`);
    barrier.actors.add(actorId);
    return new Promise((resolve, reject) => {
      barrier.waiters.push({ actorId, resolve, reject });
      if (!barrier.timer)
        barrier.timer = setTimeout(() => {
          barriers.delete(operation.syncKey);
          for (const waiter of barrier.waiters) waiter.reject(new Error(`barrier timed out: ${operation.syncKey}`));
        }, 30000);
      if (barrier.waiters.length !== participants) return;
      clearTimeout(barrier.timer);
      barriers.delete(operation.syncKey);
      const releasedAt = Date.now();
      for (const waiter of barrier.waiters) waiter.resolve({ releasedAt });
    });
  };

  const typeValue = async (element, value, durationMs) => {
    setNativeValue(element, "");
    const interval = value.length ? Math.max(16, Math.floor(durationMs / value.length)) : 0;
    for (const char of value) {
      setNativeValue(element, `${element.isContentEditable ? element.textContent : element.value}${char}`);
      if (interval) await sleep(interval);
    }
  };

  const apply = async (actorId, operation) => {
    if (operation.kind === "observe") return observe();
    if (operation.kind === "audit") return auditRecords.slice();
    const element = elements.get(operation.ref);
    if (!element || !element.isConnected) throw new Error("stale or unknown element ref; observe again");
    if (!visible(element)) throw new Error("target is not visible");
    element.scrollIntoView({ block: "center", inline: "nearest" });
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    showActor(actorId, element, operation, operation.syncKey ? "waiting" : "working");
    const concurrency = await rendezvous(actorId, operation);
    showActor(actorId, element, operation, "working");
    const durationMs = Math.max(0, Math.min(10000, Number(operation.durationMs ?? 0)));
    if (operation.kind === "type") await typeValue(element, String(operation.value ?? ""), durationMs);
    else if (durationMs) await sleep(durationMs);
    if (operation.kind === "fill") setNativeValue(element, String(operation.value ?? ""));
    else if (operation.kind === "append") {
      let currentValue = "";
      if (element.isContentEditable) currentValue = element.textContent ?? "";
      else if ("value" in element) currentValue = element.value;
      setNativeValue(element, `${currentValue}${operation.value ?? ""}`);
    } else if (operation.kind === "click") element.click();
    else if (operation.kind === "check") {
      if ("checked" in element && !element.checked) element.click();
      else if (!("checked" in element) && element.getAttribute("aria-checked") !== "true") element.click();
    } else if (operation.kind === "uncheck") {
      if ("checked" in element && element.checked) element.click();
      else if (!("checked" in element) && element.getAttribute("aria-checked") === "true") element.click();
    } else if (operation.kind === "select") setNativeValue(element, String(operation.value ?? ""));
    else if (operation.kind !== "scroll" && operation.kind !== "type")
      throw new Error(`unsupported action kind: ${operation.kind}`);
    showActor(actorId, element, operation, "done");
    return {
      ref: operation.ref,
      kind: operation.kind,
      value: "value" in element ? text(element.value) : "",
      checked: "checked" in element ? Boolean(element.checked) : element.getAttribute("aria-checked") === "true",
      label: labelFor(element),
      concurrency: { ...concurrency, syncKey: operation.syncKey ?? null, participants: operation.participants ?? 1 },
    };
  };

  addEventListener(
    "scroll",
    () => {
      for (const overlay of cursors.values()) if (overlay.element?.isConnected) positionActor(overlay, overlay.element);
    },
    true,
  );
  addEventListener("resize", () => {
    for (const overlay of cursors.values()) if (overlay.element?.isConnected) positionActor(overlay, overlay.element);
  });

  addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || !message || message.channel !== requestChannel) return;
    const { requestId, actorId, sequence, operation } = message;
    if (typeof requestId !== "string" || typeof actorId !== "string" || !Number.isSafeInteger(sequence)) return;
    let response;
    const startedAt = Date.now();
    try {
      const previous = actorSequences.get(actorId) ?? 0;
      if (sequence <= previous) throw new Error("duplicate or out-of-order actor sequence");
      actorSequences.set(actorId, sequence);
      response = { ok: true, result: await apply(actorId, operation) };
      if (operation.kind !== "audit") {
        const finishedAt = Date.now();
        auditRecords.push({
          actorId,
          durationMs: finishedAt - startedAt,
          finishedAt,
          operation,
          sequence,
          startedAt,
          timestamp: finishedAt,
        });
      }
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    window.postMessage({ channel: responseChannel, requestId, ...response }, "*");
  });
})();
