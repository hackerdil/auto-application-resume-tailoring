/**
 * In-page collector, evaluated in each allowed frame. Kept as a string because this package does not compile
 * against DOM types. It only reads the DOM; it never changes it. Elements are returned alongside the data so the
 * Node side can hold ElementHandles (the page cannot remap them).
 */
export const COLLECTOR = String.raw`(() => {
  const items = [];
  const els = [];
  const text = (n) => (n ? (n.textContent || "").replace(/\s+/g, " ").trim() : "");
  const byId = (root, id) => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return (r.width > 1 && r.height > 1) || el.type === "file";
  };
  const labelOf = (el, root) => {
    const parts = [];
    const lb = el.getAttribute("aria-labelledby");
    if (lb) parts.push(lb.split(/\s+/).map((id) => text(byId(root, id))).join(" "));
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
    if (el.labels && el.labels.length) parts.push(Array.from(el.labels).map(text).join(" "));
    const wrap = el.closest("label");
    if (!parts.length && wrap) parts.push(text(wrap));
    if (!parts.length && el.placeholder) parts.push(el.placeholder);
    if (!parts.length && el.title) parts.push(el.title);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };
  const groupLabel = (el) => {
    const fs = el.closest("fieldset");
    const lg = fs && fs.querySelector("legend");
    if (lg) return text(lg);
    const grp = el.closest("[role=radiogroup],[role=group]");
    if (grp) return grp.getAttribute("aria-label") || text(grp.querySelector("[id='" + (grp.getAttribute("aria-labelledby") || "") + "']"));
    return "";
  };
  const errorOf = (el, root) => {
    const ids = [el.getAttribute("aria-describedby"), el.getAttribute("aria-errormessage")].filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
    return ids.map((id) => text(byId(root, id))).filter(Boolean).join(" ");
  };
  const SELECTOR = "input, select, textarea, button, a[href], [role=button], [role=combobox], [role=option], [contenteditable=true]";
  const walk = (root, shadow) => {
    for (const el of root.querySelectorAll(SELECTOR)) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || (tag === "button" ? (el.closest("form") ? "submit" : "button") : tag === "input" ? "text" : tag)).toLowerCase();
      if (type === "hidden") continue;
      const isVisible = visible(el);
      if (!isVisible && type !== "file") continue;
      const form = el.form || el.closest("form");
      items.push({
        tag,
        type,
        role: el.getAttribute("role") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        label: labelOf(el, root),
        groupLabel: type === "radio" || type === "checkbox" ? groupLabel(el) : "",
        placeholder: el.getAttribute("placeholder") || "",
        required: !!el.required || el.getAttribute("aria-required") === "true",
        value: tag === "select" ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : "") : "value" in el ? String(el.value || "") : text(el),
        checked: !!el.checked,
        options: tag === "select" ? Array.from(el.options).map((o) => o.textContent.trim()).filter((t) => t) : [],
        disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
        visible: isVisible,
        inForm: !!form,
        formAction: form && form.getAttribute ? form.getAttribute("action") || "" : "",
        formMethod: form && form.getAttribute ? (form.getAttribute("method") || "get").toLowerCase() : "",
        text: tag === "button" || tag === "a" || el.getAttribute("role") === "button" || el.getAttribute("role") === "option" ? text(el).slice(0, 120) : "",
        href: tag === "a" ? el.getAttribute("href") || "" : "",
        invalid: el.getAttribute("aria-invalid") === "true",
        errorText: errorOf(el, root),
        autocomplete: el.getAttribute("autocomplete") || "",
        ariaAutocomplete: el.getAttribute("aria-autocomplete") || "",
        accept: el.getAttribute("accept") || "",
        multiple: !!el.multiple,
        shadow,
      });
      els.push(el);
    }
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) walk(host.shadowRoot, true);
  };
  walk(document, false);
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, legend")).filter(visible).map(text).filter(Boolean).slice(0, 30);
  const signals = {
    passwordField: !!document.querySelector("input[type=password]"),
    captcha: !!document.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[title*='captcha' i], [data-captcha]"),
    atsMarker: (document.querySelector("meta[name='ca-fixture-ats']") || { content: "" }).content,
  };
  return { items, els, headings, title: document.title, signals };
})()`;
