/* ============================================================
   PDF Toolbox - reusable UI kit
   Small factory functions that return DOM nodes plus a `value`
   accessor, so tool code stays declarative and short.
   ============================================================ */
(function () {
  "use strict";
  const PT = window.PT;
  const el = PT.el;
  const ui = (PT.ui = {});

  /* ---------- generic option wrapper ---------- */
  function wrap(label, node, desc) {
    return el("div", { class: "opt" }, [
      label ? el("label", { class: "lbl", text: label }) : null,
      node,
      desc ? el("div", { class: "desc", text: desc }) : null,
    ]);
  }

  ui.chips = function (label, options, value, onChange, desc) {
    const row = el("div", { class: "chips" });
    let current = value;
    const btns = options.map((o) =>
      el("button", {
        type: "button",
        "aria-pressed": String(o.v === current),
        text: o.l,
        onclick: () => {
          current = o.v;
          btns.forEach((b, i) => b.setAttribute("aria-pressed", String(options[i].v === current)));
          if (onChange) onChange(current);
        },
      })
    );
    btns.forEach((b) => row.appendChild(b));
    const node = wrap(label, row, desc);
    Object.defineProperty(node, "value", {
      get: () => current,
      set: (v) => {
        current = v;
        btns.forEach((b, i) => b.setAttribute("aria-pressed", String(options[i].v === current)));
      },
    });
    return node;
  };

  ui.select = function (label, options, value, onChange, desc) {
    const sel = el("select", { onchange: () => onChange && onChange(sel.value) },
      options.map((o) => el("option", { value: o.v, text: o.l, selected: String(o.v) === String(value) })));
    sel.value = value;
    const node = wrap(label, sel, desc);
    Object.defineProperty(node, "value", { get: () => sel.value, set: (v) => (sel.value = v) });
    return node;
  };

  ui.slider = function (label, opts) {
    const fmt = opts.format || ((v) => String(v));
    const out = el("span", { text: fmt(opts.value) });
    const input = el("input", {
      type: "range", min: opts.min, max: opts.max, step: opts.step || 1, value: opts.value,
      oninput: () => { out.textContent = fmt(+input.value); if (opts.onChange) opts.onChange(+input.value); },
    });
    const head = el("div", { class: "range-head" }, [el("span", { text: label }), out]);
    const node = el("div", { class: "opt" }, [head, input, opts.desc ? el("div", { class: "desc", text: opts.desc }) : null]);
    Object.defineProperty(node, "value", {
      get: () => +input.value,
      set: (v) => { input.value = v; out.textContent = fmt(+v); },
    });
    return node;
  };

  ui.toggle = function (title, desc, checked, onChange) {
    let state = !!checked;
    const sw = el("button", {
      class: "switch", type: "button", role: "switch", "aria-checked": String(state),
      onclick: () => { state = !state; sw.setAttribute("aria-checked", String(state)); if (onChange) onChange(state); },
    });
    const node = el("div", { class: "switch-row" }, [
      el("div", {}, [el("div", { class: "t", text: title }), desc ? el("div", { class: "d", text: desc }) : null]),
      sw,
    ]);
    Object.defineProperty(node, "value", {
      get: () => state,
      set: (v) => { state = !!v; sw.setAttribute("aria-checked", String(state)); },
    });
    return node;
  };

  ui.textInput = function (label, opts) {
    opts = opts || {};
    const input = el("input", { type: opts.type || "text", placeholder: opts.placeholder || "", value: opts.value || "" });
    if (opts.type === "number") { input.min = opts.min; input.max = opts.max; input.step = opts.step || 1; }
    const node = wrap(label, input, opts.desc);
    Object.defineProperty(node, "value", { get: () => input.value, set: (v) => (input.value = v) });
    return node;
  };

  ui.note = function (text) {
    return el("div", { class: "note" }, [PT.iconEl("alert"), el("div", { text: text })]);
  };

  ui.sectionTitle = function (text, hint) {
    return el("div", { class: "section-title" }, [el("span", { text: text }), hint ? el("span", { class: "hint", text: hint }) : null]);
  };

  ui.empty = function (icon, text) {
    return el("div", { class: "empty" }, [PT.iconEl(icon), el("div", { text: text })]);
  };

  /* ---------- file picker with drag & drop + reorderable list ---------- */
  ui.picker = function (opts) {
    opts = opts || {};
    const accept = opts.accept || "*/*";
    const multiple = opts.multiple !== false;
    let files = [];

    const input = el("input", { type: "file", accept: accept, multiple: multiple ? true : null, class: "hidden" });
    const camera = opts.camera
      ? el("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, class: "hidden" })
      : null;

    const list = el("div", { class: "file-list" });
    const zone = el("div", { class: "dropzone" }, [
      el("div", { class: "dz-ic" }, PT.iconEl(opts.camera ? "camera" : "upload")),
      el("strong", { text: opts.title || (multiple ? "เลือกไฟล์ (เลือกได้หลายไฟล์)" : "เลือกไฟล์") }),
      el("span", { text: opts.hint || "แตะเพื่อเลือก หรือ ลากไฟล์มาวางตรงนี้" }),
      opts.camera
        ? el("div", { class: "dz-actions" }, [
            el("button", { class: "btn", type: "button", onclick: (e) => { e.stopPropagation(); camera.click(); } }, [PT.iconEl("camera"), el("span", { text: "ถ่ายรูป" })]),
            el("button", { class: "btn ghost", type: "button", onclick: (e) => { e.stopPropagation(); input.click(); } }, [PT.iconEl("folder"), el("span", { text: "เลือกจากเครื่อง" })]),
          ])
        : null,
    ]);
    if (!opts.camera) zone.addEventListener("click", () => input.click());

    ["dragenter", "dragover"].forEach((ev) =>
      zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); })
    );
    zone.addEventListener("drop", (e) => add(e.dataTransfer.files));

    function typeOk(f) {
      if (accept === "*/*") return true;
      const parts = accept.split(",").map((s) => s.trim().toLowerCase());
      const name = f.name.toLowerCase();
      const mime = (f.type || "").toLowerCase();
      return parts.some((p) => (p.startsWith(".") ? name.endsWith(p) : p.endsWith("/*") ? mime.startsWith(p.slice(0, -1)) : mime === p));
    }

    function add(fileList) {
      const incoming = Array.from(fileList || []).filter((f) => {
        if (!typeOk(f)) { PT.toast("ข้ามไฟล์ " + f.name + " (ชนิดไฟล์ไม่รองรับ)", "err"); return false; }
        return true;
      });
      if (!incoming.length) return;
      files = multiple ? files.concat(incoming) : [incoming[0]];
      render();
      if (opts.onChange) opts.onChange(files);
    }

    input.addEventListener("change", () => { add(input.files); input.value = ""; });
    if (camera) camera.addEventListener("change", () => { add(camera.files); camera.value = ""; });

    function move(i, d) {
      const j = i + d;
      if (j < 0 || j >= files.length) return;
      const t = files[i]; files[i] = files[j]; files[j] = t;
      render();
      if (opts.onChange) opts.onChange(files);
    }

    function render() {
      list.innerHTML = "";
      files.forEach((f, i) => {
        const row = el("div", { class: "file-row" }, [
          el("div", { class: "fi" }, PT.iconEl(opts.fileIcon || "file")),
          el("div", { class: "meta" }, [
            el("div", { class: "name", text: f.name }),
            el("div", { class: "sub", text: PT.fmtBytes(f.size) }),
          ]),
          el("div", { class: "ops" }, [
            multiple && files.length > 1 ? el("button", { class: "mini-btn", type: "button", title: "เลื่อนขึ้น", onclick: () => move(i, -1) }, PT.iconEl("left")) : null,
            multiple && files.length > 1 ? el("button", { class: "mini-btn", type: "button", title: "เลื่อนลง", onclick: () => move(i, 1) }, PT.iconEl("right")) : null,
            el("button", {
              class: "mini-btn danger", type: "button", title: "ลบ",
              onclick: () => { files.splice(i, 1); render(); if (opts.onChange) opts.onChange(files); },
            }, PT.iconEl("trash")),
          ]),
        ]);
        list.appendChild(row);
      });
      zone.querySelector("strong").textContent = files.length
        ? "เลือกแล้ว " + files.length + " ไฟล์ • แตะเพื่อเพิ่ม"
        : opts.title || (multiple ? "เลือกไฟล์ (เลือกได้หลายไฟล์)" : "เลือกไฟล์");
    }

    const node = el("div", {}, [zone, input, camera, list]);
    node.files = () => files;
    node.setFiles = (f) => { files = f; render(); };
    node.clear = () => { files = []; render(); };
    return node;
  };

  /* ---------- runner: action button + progress + results ---------- */
  ui.runner = function (opts) {
    opts = opts || {};
    const bar = el("i");
    const txt = el("div", { class: "txt", text: "" });
    const prog = el("div", { class: "progress hidden" }, [el("div", { class: "bar" }, bar), txt]);
    const results = el("div", {});
    let busy = false;

    const btn = el("button", { class: "btn wide", type: "button", onclick: run }, [
      PT.iconEl(opts.icon || "sparkles"),
      el("span", { text: opts.label || "เริ่มทำงาน" }),
    ]);

    function setProgress(p, message) {
      prog.classList.remove("hidden");
      bar.style.width = Math.max(0, Math.min(100, Math.round(p * 100))) + "%";
      txt.textContent = message || "";
    }

    async function run() {
      if (busy) return;
      busy = true;
      results.innerHTML = "";
      btn.disabled = true;
      btn.querySelector("span").textContent = "กำลังทำงาน...";
      setProgress(0.02, "เริ่มต้น...");
      try {
        await opts.onRun({
          progress: (p, m) => setProgress(p, m),
          done: (list, stat) => showResults(list, stat),
        });
      } catch (err) {
        console.error(err);
        prog.classList.add("hidden");
        PT.toast((err && err.message) || "ทำงานไม่สำเร็จ", "err");
        results.appendChild(el("div", { class: "note" }, [PT.iconEl("alert"), el("div", { text: (err && err.message) || "เกิดข้อผิดพลาด" })]));
      } finally {
        busy = false;
        btn.disabled = false;
        btn.querySelector("span").textContent = opts.label || "เริ่มทำงาน";
      }
    }

    function showResults(list, stat) {
      prog.classList.add("hidden");
      results.innerHTML = "";
      if (!list || !list.length) return;
      const box = el("div", { class: "result" });
      box.appendChild(el("h4", {}, [PT.iconEl("checkCircle"), el("span", { text: "เสร็จแล้ว " + list.length + " ไฟล์" })]));
      if (stat) box.appendChild(el("div", { class: "stat", text: stat }));

      list.forEach((r) => {
        const row = el("div", { class: "file-row", style: { marginTop: "10px" } }, [
          el("div", { class: "fi" }, PT.iconEl(r.icon || "file")),
          el("div", { class: "meta" }, [
            el("div", { class: "name", text: r.name }),
            el("div", { class: "sub", text: PT.fmtBytes(r.blob.size) + (r.note ? " • " + r.note : "") }),
          ]),
          el("div", { class: "ops" }, [
            el("button", { class: "mini-btn", type: "button", title: "แชร์", onclick: () => PT.share(r.blob, r.name) }, PT.iconEl("share")),
            el("button", { class: "mini-btn", type: "button", title: "ดาวน์โหลด", onclick: () => PT.download(r.blob, r.name) }, PT.iconEl("download")),
          ]),
        ]);
        box.appendChild(row);
      });

      results.appendChild(box);
      list.forEach((r) => {
        PT.recents.add(r.blob, r.name, opts.toolId, r.thumb);
        if (PT.settings.autoDownload) PT.download(r.blob, r.name);
      });
      PT.toast(PT.settings.autoDownload ? "บันทึกไฟล์แล้ว" : "ทำงานเสร็จแล้ว", "ok");
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    const node = el("div", {}, [el("div", { class: "btn-row" }, btn), prog, results]);
    node.button = btn;
    node.reset = () => { results.innerHTML = ""; prog.classList.add("hidden"); };
    return node;
  };

  /* ---------- pointer-based drag & drop reordering for thumbnails ---------- */
  ui.enableReorder = function (container, opts) {
    // opts: { itemSelector, handleSelector, onReorder(from, to) }
    let dragEl = null, startIdx = -1;

    function items() { return Array.from(container.querySelectorAll(opts.itemSelector)); }

    container.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(opts.handleSelector);
      if (!handle) return;
      const item = handle.closest(opts.itemSelector);
      if (!item) return;
      e.preventDefault();
      dragEl = item;
      startIdx = items().indexOf(item);
      item.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);

      const move = (ev) => {
        if (!dragEl) return;
        const list = items();
        let best = null, bestDist = Infinity;
        list.forEach((n) => {
          if (n === dragEl) return;
          const r = n.getBoundingClientRect();
          const d = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2));
          if (d < bestDist) { bestDist = d; best = n; }
        });
        if (best && bestDist < 130) {
          const list2 = items();
          const from = list2.indexOf(dragEl), to = list2.indexOf(best);
          if (from !== to) best.parentNode.insertBefore(dragEl, from < to ? best.nextSibling : best);
        }
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        if (!dragEl) return;
        dragEl.classList.remove("dragging");
        const endIdx = items().indexOf(dragEl);
        dragEl = null;
        if (endIdx !== startIdx && opts.onReorder) opts.onReorder(startIdx, endIdx);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  };
})();
