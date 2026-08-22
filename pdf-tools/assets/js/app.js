/* ============================================================
   PDF Toolbox - shell: tab bar, hash router, home/recent/settings
   ============================================================ */
(function () {
  "use strict";
  const PT = window.PT;
  const el = PT.el;
  const view = document.getElementById("view");

  const TABS = [
    { id: "home", label: "หน้าแรก", icon: "home", route: "#/" },
    { id: "tools", label: "เครื่องมือ", icon: "grid", route: "#/tools" },
    { id: "scan", label: "สแกน", icon: "scan", route: "#/t/scan" },
    { id: "recent", label: "ล่าสุด", icon: "clock", route: "#/recent" },
    { id: "settings", label: "ตั้งค่า", icon: "settings", route: "#/settings" },
  ];

  /* ---------- chrome ---------- */
  function buildChrome() {
    document.getElementById("brand-mark").appendChild(PT.iconEl("file"));
    const home = document.getElementById("btn-home");
    home.appendChild(PT.iconEl("home"));
    home.addEventListener("click", () => (location.hash = "#/"));

    const themeBtn = document.getElementById("btn-theme");
    const paintTheme = () => {
      themeBtn.innerHTML = "";
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      themeBtn.appendChild(PT.iconEl(dark ? "sun" : "moon"));
    };
    themeBtn.addEventListener("click", () => {
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      PT.settings.theme = dark ? "light" : "dark";
      PT.saveSettings();
      paintTheme();
    });
    const mo = new MutationObserver(paintTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    paintTheme();

    const bar = document.getElementById("tabbar");
    TABS.forEach((t) => {
      const b = el("button", { type: "button", "data-tab": t.id, onclick: () => (location.hash = t.route) }, [
        PT.iconEl(t.icon),
        el("span", { text: t.label }),
      ]);
      bar.appendChild(b);
    });
  }

  function setActiveTab(id) {
    document.querySelectorAll("#tabbar button").forEach((b) => {
      b.setAttribute("aria-current", String(b.dataset.tab === id));
    });
  }

  /* ---------- shared pieces ---------- */
  function toolCard(tool) {
    const card = el("button", { class: "tool-card", type: "button", onclick: () => (location.hash = "#/t/" + tool.id) }, [
      tool.flag ? el("span", { class: "flag", text: tool.flag }) : null,
      el("div", { class: "ic" }, PT.iconEl(tool.icon)),
      el("h3", { text: tool.title }),
      el("p", { text: tool.desc }),
    ]);
    return PT.paintAccent(card, tool.color);
  }

  function quickBtn(tool) {
    const b = el("button", { type: "button", onclick: () => (location.hash = "#/t/" + tool.id) }, [
      el("div", { class: "ic" }, PT.iconEl(tool.icon)),
      el("span", { text: tool.short || tool.title }),
    ]);
    return PT.paintAccent(b, tool.color);
  }

  /* ---------- screens ---------- */
  async function screenHome() {
    setActiveTab("home");
    view.innerHTML = "";

    view.appendChild(
      el("div", { class: "hero" }, [
        el("div", { class: "blob b1" }),
        el("div", { class: "blob b2" }),
        el("h2", { text: "จัดการไฟล์ PDF ได้ครบ จบในมือถือ" }),
        el("p", { text: "รวม แยก ลดขนาด สแกน ใส่ลายน้ำ และลดขนาดวิดีโอ ทุกอย่างประมวลผลในเครื่องคุณเอง" }),
        el("div", { class: "pills" }, [
          el("span", { class: "pill", text: "🔒 ไฟล์ไม่ถูกอัปโหลด" }),
          el("span", { class: "pill", text: "⚡ ใช้งานออฟไลน์ได้" }),
          el("span", { class: "pill", text: "🆓 ฟรี ไม่มีลายน้ำ" }),
        ]),
      ])
    );

    view.appendChild(PT.ui.sectionTitle("ใช้บ่อย"));
    const quick = el("div", { class: "quick" });
    ["scan", "merge", "compress-pdf", "video-compress"].forEach((id) => {
      const t = PT.toolMap[id];
      if (t) quick.appendChild(quickBtn(t));
    });
    view.appendChild(quick);

    view.appendChild(PT.ui.sectionTitle("เครื่องมือแนะนำ", "ดูทั้งหมด " + PT.tools.length + " รายการ"));
    const grid = el("div", { class: "tool-grid" });
    ["scan", "merge", "organize", "split", "compress-pdf", "image-compress"]
      .map((id) => PT.toolMap[id])
      .filter(Boolean)
      .forEach((t) => grid.appendChild(toolCard(t)));
    view.appendChild(grid);
    view.appendChild(
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn ghost wide", type: "button", onclick: () => (location.hash = "#/tools") }, [
          PT.iconEl("grid"), el("span", { text: "ดูเครื่องมือทั้งหมด" }),
        ]),
      ])
    );

    const recents = await PT.recents.list();
    if (recents.length) {
      view.appendChild(PT.ui.sectionTitle("ไฟล์ล่าสุด"));
      const box = el("div", { class: "file-list" });
      recents.slice(0, 3).forEach((r) => box.appendChild(recentRow(r, () => screenHome())));
      view.appendChild(box);
    }
  }

  function screenTools() {
    setActiveTab("tools");
    view.innerHTML = "";
    view.appendChild(el("h2", { class: "page-title", text: "เครื่องมือทั้งหมด" }));
    view.appendChild(el("p", { class: "page-sub", text: "รวมเครื่องมือ " + PT.tools.length + " รายการ ทุกอย่างทำงานในเครื่องคุณ ไม่ส่งไฟล์ออกไปไหน" }));

    const groups = [
      { key: "pdf", label: "งาน PDF" },
      { key: "image", label: "รูปภาพ" },
      { key: "video", label: "วิดีโอ" },
    ];
    groups.forEach((g) => {
      const list = PT.tools.filter((t) => t.group === g.key);
      if (!list.length) return;
      view.appendChild(PT.ui.sectionTitle(g.label, list.length + " รายการ"));
      const grid = el("div", { class: "tool-grid" });
      list.forEach((t) => grid.appendChild(toolCard(t)));
      view.appendChild(grid);
    });
  }

  function recentRow(item, refresh) {
    const box = el("div", { class: "thumbbox" });
    if (item.thumb) box.appendChild(el("img", { src: item.thumb, alt: "" }));
    else box.appendChild(PT.iconEl(item.type && item.type.startsWith("video") ? "video" : item.type && item.type.startsWith("image") ? "image" : "file"));
    const tool = PT.toolMap[item.tool];
    return el("div", { class: "recent-row" }, [
      box,
      el("div", { class: "meta", style: { flex: "1", minWidth: "0" } }, [
        el("div", { class: "name", text: item.name, style: { fontSize: "13.5px", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }),
        el("div", { class: "sub", style: { fontSize: "11.5px", color: "var(--text-dim)" }, text: PT.fmtBytes(item.size) + " • " + PT.fmtDate(item.ts) + (tool ? " • " + tool.title : "") }),
      ]),
      el("div", { class: "ops" }, [
        el("button", { class: "mini-btn", type: "button", title: "แชร์", onclick: () => PT.share(item.blob, item.name) }, PT.iconEl("share")),
        el("button", { class: "mini-btn", type: "button", title: "ดาวน์โหลด", onclick: () => PT.download(item.blob, item.name) }, PT.iconEl("download")),
        el("button", {
          class: "mini-btn danger", type: "button", title: "ลบ",
          onclick: async () => { await PT.recents.remove(item.id); PT.toast("ลบแล้ว"); refresh(); },
        }, PT.iconEl("trash")),
      ]),
    ]);
  }

  async function screenRecent() {
    setActiveTab("recent");
    view.innerHTML = "";
    view.appendChild(el("h2", { class: "page-title", text: "ไฟล์ล่าสุด" }));
    view.appendChild(el("p", { class: "page-sub", text: "เก็บไฟล์ผลลัพธ์ล่าสุดไว้ในเครื่อง (สูงสุด 24 ไฟล์)" }));
    const list = await PT.recents.list();
    if (!list.length) {
      view.appendChild(PT.ui.empty("clock", "ยังไม่มีไฟล์ • ผลลัพธ์จากเครื่องมือต่าง ๆ จะมาแสดงที่นี่"));
      return;
    }
    const box = el("div", { class: "file-list", style: { marginTop: "14px" } });
    list.forEach((r) => box.appendChild(recentRow(r, screenRecent)));
    view.appendChild(box);
    view.appendChild(
      el("div", { class: "btn-row" }, [
        el("button", {
          class: "btn ghost wide", type: "button",
          onclick: async () => {
            if (!confirm("ลบไฟล์ล่าสุดทั้งหมด?")) return;
            await PT.recents.clear();
            PT.toast("ล้างรายการแล้ว");
            screenRecent();
          },
        }, [PT.iconEl("trash"), el("span", { text: "ล้างทั้งหมด" })]),
      ])
    );
  }

  function screenSettings() {
    setActiveTab("settings");
    view.innerHTML = "";
    view.appendChild(el("h2", { class: "page-title", text: "ตั้งค่า" }));

    const card = el("div", { class: "card", style: { marginTop: "14px" } });
    card.appendChild(
      PT.ui.chips("ธีม", [
        { v: "auto", l: "ตามระบบ" }, { v: "light", l: "สว่าง" }, { v: "dark", l: "มืด" },
      ], PT.settings.theme, (v) => { PT.settings.theme = v; PT.saveSettings(); })
    );
    card.appendChild(
      PT.ui.slider("คุณภาพภาพเริ่มต้น", {
        min: 0.4, max: 0.95, step: 0.05, value: PT.settings.quality,
        format: (v) => Math.round(v * 100) + "%",
        onChange: (v) => { PT.settings.quality = v; PT.saveSettings(); },
        desc: "ใช้เป็นค่าตั้งต้นของเครื่องมือที่ต้องบีบอัดภาพ",
      })
    );
    card.appendChild(
      PT.ui.toggle("ดาวน์โหลดอัตโนมัติ", "บันทึกไฟล์ทันทีเมื่อทำงานเสร็จ", PT.settings.autoDownload, (v) => {
        PT.settings.autoDownload = v; PT.saveSettings();
      })
    );
    card.appendChild(
      PT.ui.toggle("เก็บไฟล์ล่าสุด", "เก็บผลลัพธ์ไว้ในเครื่องเพื่อเปิดซ้ำภายหลัง", PT.settings.keepRecent, (v) => {
        PT.settings.keepRecent = v; PT.saveSettings();
      })
    );
    view.appendChild(card);

    view.appendChild(PT.ui.sectionTitle("พื้นที่จัดเก็บ"));
    const storeCard = el("div", { class: "card" });
    const info = el("div", { class: "desc", text: "กำลังตรวจสอบ..." });
    storeCard.appendChild(info);
    storeCard.appendChild(
      el("div", { class: "btn-row" }, [
        el("button", {
          class: "btn ghost wide", type: "button",
          onclick: async () => { await PT.recents.clear(); PT.toast("ล้างข้อมูลแล้ว"); screenSettings(); },
        }, [PT.iconEl("trash"), el("span", { text: "ล้างไฟล์ที่เก็บไว้" })]),
      ])
    );
    view.appendChild(storeCard);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((e) => {
        info.textContent = "ใช้ไปแล้ว " + PT.fmtBytes(e.usage || 0) + " จากโควตาราว " + PT.fmtBytes(e.quota || 0);
      }).catch(() => (info.textContent = "ตรวจสอบพื้นที่ไม่ได้"));
    } else {
      info.textContent = "เบราว์เซอร์นี้ไม่รายงานพื้นที่จัดเก็บ";
    }

    view.appendChild(PT.ui.sectionTitle("เกี่ยวกับ"));
    view.appendChild(
      el("div", { class: "card" }, [
        el("div", { style: { display: "flex", gap: "10px", alignItems: "flex-start" } }, [
          PT.iconEl("shield"),
          el("div", {}, [
            el("div", { style: { fontWeight: "700" }, text: "ไฟล์ของคุณไม่ถูกอัปโหลด" }),
            el("div", { class: "desc", text: "ทุกเครื่องมือในแอปนี้ประมวลผลด้วย JavaScript ในเบราว์เซอร์ของคุณเอง ไม่มีการส่งไฟล์ไปยังเซิร์ฟเวอร์ใด ๆ และเมื่อเปิดครบหนึ่งครั้งแล้วยังใช้งานแบบออฟไลน์ได้" }),
          ]),
        ]),
        el("div", { class: "desc", style: { marginTop: "12px" }, text: "ใช้ไลบรารีโอเพนซอร์ส: pdf-lib, pdf.js, fontkit, JSZip, mp4-muxer และฟอนต์ Sarabun (SIL OFL)" }),
      ])
    );
  }

  function screenTool(id) {
    const tool = PT.toolMap[id];
    if (!tool) { location.hash = "#/tools"; return; }
    setActiveTab(id === "scan" ? "scan" : "tools");
    view.innerHTML = "";

    const head = PT.paintAccent(
      el("div", { class: "tool-head" }, [
        el("button", { class: "icon-btn", type: "button", title: "ย้อนกลับ", onclick: () => history.back() }, PT.iconEl("back")),
        el("div", { class: "ic" }, PT.iconEl(tool.icon)),
        el("div", {}, [el("h2", { text: tool.title }), el("p", { text: tool.long || tool.desc })]),
      ]),
      tool.color
    );
    view.appendChild(head);

    const body = el("div", {});
    view.appendChild(body);
    try {
      tool.build(body);
    } catch (err) {
      console.error(err);
      body.appendChild(PT.ui.note("เปิดเครื่องมือไม่สำเร็จ: " + err.message));
    }
    window.scrollTo(0, 0);
  }

  /* ---------- router ---------- */
  function route() {
    const hash = location.hash || "#/";
    const m = hash.match(/^#\/t\/([\w-]+)/);
    if (m) return screenTool(m[1]);
    if (hash.startsWith("#/tools")) return screenTools();
    if (hash.startsWith("#/recent")) return screenRecent();
    if (hash.startsWith("#/settings")) return screenSettings();
    return screenHome();
  }

  window.addEventListener("hashchange", route);

  PT.applyTheme();
  buildChrome();
  route();

  /* service worker keeps the app usable offline */
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register(PT.base + "sw.js").catch(() => {});
    });
  }
})();
