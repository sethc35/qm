(() => {
  if (globalThis.__qmSharedBrowserLoaded) return;
  globalThis.__qmSharedBrowserLoaded = true;
  const requestChannel = "qm-shared-browser-request";
  const responseChannel = "qm-shared-browser-response";
  const refs = new WeakMap();
  const elements = new Map();
  const actorSequences = new Map();
  const cursors = new Map();
  const auditRecords = [];
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
    let hash = 0;
    for (const char of actorId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 75% 48%)`;
  };

  const showActor = (actorId, element) => {
    let cursor = cursors.get(actorId);
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.dataset.qmSharedBrowserOverlay = "true";
      Object.assign(cursor.style, {
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "none",
        color: "white",
        background: colorFor(actorId),
        borderRadius: "999px",
        padding: "3px 7px",
        font: "12px system-ui, sans-serif",
        boxShadow: "0 1px 4px rgb(0 0 0 / 35%)",
        transition: "transform 80ms linear",
      });
      cursor.textContent = actorId;
      document.documentElement.appendChild(cursor);
      cursors.set(actorId, cursor);
    }
    const rect = element.getBoundingClientRect();
    cursor.style.transform = `translate(${Math.max(0, rect.left)}px, ${Math.max(0, rect.top - 24)}px)`;
  };

  const apply = (actorId, operation) => {
    if (operation.kind === "observe") return observe();
    if (operation.kind === "audit") return auditRecords.slice();
    const element = elements.get(operation.ref);
    if (!element || !element.isConnected) throw new Error("stale or unknown element ref; observe again");
    if (!visible(element)) throw new Error("target is not visible");
    showActor(actorId, element);
    element.scrollIntoView({ block: "center", inline: "nearest" });
    if (operation.kind === "fill") setNativeValue(element, String(operation.value ?? ""));
    else if (operation.kind === "append")
      setNativeValue(element, `${"value" in element ? element.value : ""}${operation.value ?? ""}`);
    else if (operation.kind === "click") element.click();
    else if (operation.kind === "check") {
      if ("checked" in element && !element.checked) element.click();
      else if (!("checked" in element) && element.getAttribute("aria-checked") !== "true") element.click();
    } else if (operation.kind === "uncheck") {
      if ("checked" in element && element.checked) element.click();
      else if (!("checked" in element) && element.getAttribute("aria-checked") === "true") element.click();
    } else if (operation.kind === "select") setNativeValue(element, String(operation.value ?? ""));
    else if (operation.kind !== "scroll") throw new Error(`unsupported action kind: ${operation.kind}`);
    return {
      ref: operation.ref,
      kind: operation.kind,
      value: "value" in element ? text(element.value) : "",
      checked: "checked" in element ? Boolean(element.checked) : element.getAttribute("aria-checked") === "true",
      label: labelFor(element),
    };
  };

  addEventListener("message", (event) => {
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
      response = { ok: true, result: apply(actorId, operation) };
      if (operation.kind !== "audit") {
        auditRecords.push({
          actorId,
          durationMs: Date.now() - startedAt,
          operation,
          sequence,
          startedAt,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    window.postMessage({ channel: responseChannel, requestId, ...response }, "*");
  });
})();
