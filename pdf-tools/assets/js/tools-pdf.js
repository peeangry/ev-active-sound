/* ============================================================
   PDF Toolbox - PDF tools
   merge / organize / split / compress / to-image / page numbers /
   watermark / rotate / extract text / signature
   ============================================================ */
(function () {
  "use strict";
  const PT = window.PT;
  const el = PT.el;
  const ui = PT.ui;

  /* ---------- shared helpers ---------- */
  async function loadDoc(file) {
    const { PDFDocument } = await PT.libs.pdfLib();
    try {
      return await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
    } catch (e) {
      throw new Error("เปิดไฟล์ " + file.name + " ไม่ได้ (อาจเสียหายหรือมีรหัสผ่าน)");
    }
  }

  /* Maps a point given in *displayed* page coordinates (bottom-left origin,
     after the page's /Rotate is applied) back to raw PDF coordinates. */
  function place(page, dispX, dispY) {
    const { width: W, height: H } = page.getSize();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    if (rot === 90) return { x: W - dispY, y: dispX, rot: 90 };
    if (rot === 180) return { x: W - dispX, y: H - dispY, rot: 180 };
    if (rot === 270) return { x: dispY, y: H - dispX, rot: 270 };
    return { x: dispX, y: dispY, rot: 0 };
  }

  function displaySize(page) {
    const { width: W, height: H } = page.getSize();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    return rot === 90 || rot === 270 ? { w: H, h: W } : { w: W, h: H };
  }

  const COLORS = [
    { v: "#111827", l: "ดำ" }, { v: "#e11d48", l: "แดง" }, { v: "#2563eb", l: "น้ำเงิน" },
    { v: "#6b7280", l: "เทา" }, { v: "#16a34a", l: "เขียว" },
  ];
  async function rgbOf(hex) {
    const { rgb } = await PT.libs.pdfLib();
    const n = parseInt(hex.slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  async function pdfBlob(doc) {
    const bytes = await doc.save({ useObjectStreams: true });
    return new Blob([bytes], { type: "application/pdf" });
  }

  /* Renders thumbnails of every page; returns an array of canvases. */
  async function renderThumbs(file, onProgress, maxWidth) {
    const doc = await PT.openPdfJs(file);
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const scale = Math.min(1.6, (maxWidth || 150) / vp.width);
      out.push(await PT.renderPageToCanvas(page, scale));
      if (onProgress) onProgress(i / doc.numPages);
      await PT.nextFrame();
    }
    return out;
  }

  /* =========================================================
     1. รวมไฟล์ PDF
     ========================================================= */
  PT.registerTool({
    id: "merge", group: "pdf", icon: "merge", color: "blue", short: "รวมไฟล์",
    title: "รวมไฟล์ PDF",
    desc: "ต่อหลายไฟล์เข้าด้วยกันตามลำดับที่จัดไว้",
    long: "เลือกไฟล์ PDF ตั้งแต่ 2 ไฟล์ขึ้นไป จัดลำดับด้วยปุ่มลูกศร แล้วรวมเป็นไฟล์เดียว",
    build(root) {
      const picker = ui.picker({ accept: ".pdf,application/pdf", multiple: true, fileIcon: "file", hint: "เลือกไฟล์ PDF หลายไฟล์ แล้วจัดลำดับด้วยปุ่มลูกศร" });
      root.appendChild(picker);
      const runner = ui.runner({
        label: "รวมไฟล์", icon: "merge", toolId: "merge",
        onRun: async (ctx) => {
          const files = picker.files();
          if (files.length < 2) throw new Error("ต้องเลือกอย่างน้อย 2 ไฟล์");
          const { PDFDocument } = await PT.libs.pdfLib();
          const out = await PDFDocument.create();
          let pages = 0;
          for (let i = 0; i < files.length; i++) {
            ctx.progress(i / files.length, "กำลังอ่าน " + files[i].name);
            const src = await loadDoc(files[i]);
            const copied = await out.copyPages(src, src.getPageIndices());
            copied.forEach((p) => { out.addPage(p); pages++; });
          }
          ctx.progress(0.95, "กำลังบันทึก...");
          const blob = await pdfBlob(out);
          ctx.done([{ blob, name: PT.safeName(PT.baseName(files[0].name)) + "-รวม.pdf", note: pages + " หน้า" }],
            "รวม " + files.length + " ไฟล์ = " + pages + " หน้า");
        },
      });
      root.appendChild(runner);
    },
  });

  /* =========================================================
     2. จัดหน้า PDF (เรียง / หมุน / ลบ)
     ========================================================= */
  PT.registerTool({
    id: "organize", group: "pdf", icon: "grid", color: "violet", short: "จัดหน้า",
    title: "จัดหน้า PDF",
    desc: "ลากสลับลำดับ หมุนหน้าที่วางผิด หรือลบหน้าที่ไม่ต้องการ",
    long: "เปิดไฟล์แล้วจัดการรายหน้า: ลากที่มุมซ้ายบนเพื่อสลับลำดับ กดหมุน หรือกดลบหน้าที่ไม่ต้องการ",
    build(root) {
      let pages = [];   // { src, rotate, canvas }
      let srcFile = null;
      const grid = el("div", { class: "thumbs" });
      const bar = el("div", { class: "btn-row hidden" }, [
        el("button", { class: "btn ghost", type: "button", onclick: () => { pages.forEach((p) => (p.rotate = (p.rotate + 90) % 360)); paint(); } },
          [PT.iconEl("rotate"), el("span", { text: "หมุนทุกหน้า" })]),
        el("button", { class: "btn ghost", type: "button", onclick: () => { pages = pages.slice().reverse(); paint(); } },
          [PT.iconEl("refresh"), el("span", { text: "กลับลำดับ" })]),
      ]);

      const picker = ui.picker({
        accept: ".pdf,application/pdf", multiple: false, fileIcon: "file",
        title: "เลือกไฟล์ PDF ที่ต้องการจัดหน้า",
        onChange: async (files) => {
          if (!files.length) return;
          srcFile = files[0];
          grid.innerHTML = "";
          const loading = el("div", { class: "progress" }, [el("div", { class: "bar" }, el("i", { style: { width: "5%" } })), el("div", { class: "txt", text: "กำลังเปิดไฟล์..." })]);
          root.insertBefore(loading, grid);
          try {
            const canvases = await renderThumbs(srcFile, (p) => {
              loading.querySelector("i").style.width = Math.round(p * 100) + "%";
              loading.querySelector(".txt").textContent = "กำลังสร้างตัวอย่าง " + Math.round(p * 100) + "%";
            });
            pages = canvases.map((c, i) => ({ src: i, rotate: 0, canvas: c }));
            paint();
            bar.classList.remove("hidden");
          } catch (e) {
            PT.toast(e.message, "err");
          } finally {
            loading.remove();
          }
        },
      });

      function paint() {
        grid.innerHTML = "";
        pages.forEach((p, i) => {
          const holder = el("div", { class: "thumb", "data-i": i });
          const img = el("img", { src: p.canvas.toDataURL("image/jpeg", 0.7), alt: "" });
          img.style.transform = "rotate(" + p.rotate + "deg)";
          img.style.maxWidth = p.rotate % 180 ? "72%" : "100%";
          holder.appendChild(img);
          holder.appendChild(el("div", { class: "grip" }, PT.iconEl("grip")));
          holder.appendChild(el("div", { class: "n", text: "หน้า " + (p.src + 1) }));
          holder.appendChild(
            el("div", { class: "tops" }, [
              el("button", { type: "button", title: "หมุน", onclick: () => { p.rotate = (p.rotate + 90) % 360; paint(); } }, PT.iconEl("rotate")),
              el("button", { type: "button", title: "ลบ", onclick: () => { pages.splice(i, 1); paint(); } }, PT.iconEl("trash")),
            ])
          );
          grid.appendChild(holder);
        });
        count.textContent = pages.length ? "เหลือ " + pages.length + " หน้า" : "";
      }

      const count = el("div", { class: "desc" });
      root.appendChild(picker);
      root.appendChild(bar);
      root.appendChild(count);
      root.appendChild(grid);

      ui.enableReorder(grid, {
        itemSelector: ".thumb", handleSelector: ".grip",
        onReorder: (from, to) => {
          const moved = pages.splice(from, 1)[0];
          pages.splice(to, 0, moved);
          paint();
        },
      });

      root.appendChild(ui.note("ลากที่จุดมุมซ้ายบนของหน้าเพื่อสลับลำดับ (ใช้ได้ทั้งเมาส์และนิ้ว)"));

      root.appendChild(ui.runner({
        label: "บันทึกไฟล์ใหม่", icon: "check", toolId: "organize",
        onRun: async (ctx) => {
          if (!srcFile) throw new Error("ยังไม่ได้เลือกไฟล์");
          if (!pages.length) throw new Error("ต้องเหลืออย่างน้อย 1 หน้า");
          const { PDFDocument, degrees } = await PT.libs.pdfLib();
          const src = await loadDoc(srcFile);
          const out = await PDFDocument.create();
          ctx.progress(0.4, "กำลังคัดลอกหน้า...");
          const copied = await out.copyPages(src, pages.map((p) => p.src));
          copied.forEach((page, i) => {
            const base = ((page.getRotation().angle % 360) + 360) % 360;
            page.setRotation(degrees((base + pages[i].rotate) % 360));
            out.addPage(page);
          });
          ctx.progress(0.9, "กำลังบันทึก...");
          const blob = await pdfBlob(out);
          ctx.done([{ blob, name: PT.safeName(PT.baseName(srcFile.name)) + "-จัดหน้า.pdf", note: pages.length + " หน้า" }]);
        },
      }));
    },
  });

  /* =========================================================
     3. แยกไฟล์ PDF
     ========================================================= */
  PT.registerTool({
    id: "split", group: "pdf", icon: "split", color: "teal", short: "แยกไฟล์",
    title: "แยกไฟล์ PDF",
    desc: "ดึงเฉพาะหน้าที่ต้องการออกมา หรือแบ่งเป็นหลายไฟล์",
    long: "ดึงเฉพาะหน้าที่ระบุ แยกทีละหน้า หรือแบ่งเป็นชุดละหลายหน้า (ได้ผลลัพธ์เป็นไฟล์ ZIP เมื่อมีหลายไฟล์)",
    build(root) {
      let info = el("div", { class: "desc" });
      const picker = ui.picker({
        accept: ".pdf,application/pdf", multiple: false, fileIcon: "file",
        onChange: async (files) => {
          if (!files.length) return;
          try {
            const doc = await loadDoc(files[0]);
            info.textContent = "ไฟล์นี้มี " + doc.getPageCount() + " หน้า";
          } catch (e) { info.textContent = e.message; }
        },
      });
      root.appendChild(picker);
      root.appendChild(info);

      const mode = ui.chips("รูปแบบการแยก", [
        { v: "pick", l: "ดึงหน้าที่เลือก" },
        { v: "each", l: "แยกทีละหน้า" },
        { v: "chunk", l: "แบ่งทุก N หน้า" },
      ], "pick", () => sync());
      const ranges = ui.textInput("หน้าที่ต้องการ", { placeholder: "เช่น 1-3, 5, 8-10", value: "1-3", desc: "ใส่เลขหน้าหรือช่วงหน้า คั่นด้วยเครื่องหมายจุลภาค" });
      const chunk = ui.textInput("จำนวนหน้าต่อไฟล์", { type: "number", value: "2", min: 1, max: 500 });
      root.appendChild(mode); root.appendChild(ranges); root.appendChild(chunk);

      function sync() {
        ranges.classList.toggle("hidden", mode.value !== "pick");
        chunk.classList.toggle("hidden", mode.value !== "chunk");
      }
      sync();

      root.appendChild(ui.runner({
        label: "แยกไฟล์", icon: "scissors", toolId: "split",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกไฟล์");
          const { PDFDocument } = await PT.libs.pdfLib();
          const src = await loadDoc(files[0]);
          const total = src.getPageCount();
          const base = PT.safeName(PT.baseName(files[0].name));
          const groups = [];

          if (mode.value === "pick") {
            const idx = PT.parseRanges(ranges.value, total);
            if (!idx.length) throw new Error("ระบุหน้าไม่ถูกต้อง (ไฟล์มี " + total + " หน้า)");
            groups.push({ name: base + "-หน้าที่เลือก.pdf", idx });
          } else if (mode.value === "each") {
            for (let i = 0; i < total; i++) groups.push({ name: base + "-หน้า" + (i + 1) + ".pdf", idx: [i] });
          } else {
            const n = Math.max(1, parseInt(chunk.value, 10) || 1);
            for (let i = 0; i < total; i += n) {
              const idx = [];
              for (let j = i; j < Math.min(i + n, total); j++) idx.push(j);
              groups.push({ name: base + "-ชุด" + (groups.length + 1) + ".pdf", idx });
            }
          }

          const made = [];
          for (let g = 0; g < groups.length; g++) {
            ctx.progress(g / groups.length, "กำลังสร้างไฟล์ " + (g + 1) + "/" + groups.length);
            const out = await PDFDocument.create();
            const copied = await out.copyPages(src, groups[g].idx);
            copied.forEach((p) => out.addPage(p));
            made.push({ name: groups[g].name, blob: await pdfBlob(out) });
          }

          if (made.length === 1) { ctx.done([{ blob: made[0].blob, name: made[0].name }]); return; }
          ctx.progress(0.92, "กำลังบีบเป็น ZIP...");
          const JSZip = await PT.libs.jszip();
          const zip = new JSZip();
          made.forEach((m) => zip.file(m.name, m.blob));
          const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
          ctx.done([{ blob, name: base + "-แยกไฟล์.zip", icon: "zip", note: made.length + " ไฟล์" }]);
        },
      }));
    },
  });

  /* =========================================================
     4. ลดขนาด PDF
     ========================================================= */
  PT.registerTool({
    id: "compress-pdf", group: "pdf", icon: "compress", color: "amber", short: "ลดขนาด PDF",
    title: "ลดขนาด PDF",
    desc: "บีบอัดภาพในเอกสารให้ไฟล์เล็กลง ส่งไลน์/อีเมลได้ง่าย",
    long: "โหมดเร็วจะจัดโครงสร้างไฟล์ใหม่โดยคงความคมชัดเดิม ส่วนโหมดแปลงเป็นภาพจะลดขนาดได้มากที่สุด (ข้อความจะกลายเป็นภาพ)",
    build(root) {
      const picker = ui.picker({ accept: ".pdf,application/pdf", multiple: true, fileIcon: "file" });
      root.appendChild(picker);

      const mode = ui.chips("โหมด", [
        { v: "raster", l: "บีบอัดแรง (แปลงเป็นภาพ)" },
        { v: "light", l: "เร็ว (คงข้อความ)" },
      ], "raster", () => sync(), "แนะนำโหมดบีบอัดแรงสำหรับเอกสารสแกน");
      const dpi = ui.chips("ความละเอียด", [
        { v: "72", l: "72 dpi (เล็กสุด)" }, { v: "100", l: "100 dpi" },
        { v: "144", l: "144 dpi (แนะนำ)" }, { v: "200", l: "200 dpi (คมชัด)" },
      ], "144");
      const q = ui.slider("คุณภาพภาพ", { min: 0.3, max: 0.92, step: 0.02, value: PT.settings.quality, format: (v) => Math.round(v * 100) + "%" });
      const gray = ui.toggle("แปลงเป็นขาวดำ", "ลดขนาดได้อีกมากสำหรับเอกสารข้อความ", false);
      root.appendChild(mode); root.appendChild(dpi); root.appendChild(q); root.appendChild(gray);

      function sync() {
        const raster = mode.value === "raster";
        dpi.classList.toggle("hidden", !raster);
        q.classList.toggle("hidden", !raster);
        gray.classList.toggle("hidden", !raster);
      }
      sync();

      root.appendChild(ui.runner({
        label: "ลดขนาดไฟล์", icon: "compress", toolId: "compress-pdf",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกไฟล์");
          const { PDFDocument } = await PT.libs.pdfLib();
          const results = [];
          let before = 0, after = 0;

          for (let f = 0; f < files.length; f++) {
            const file = files[f];
            before += file.size;
            const nameOut = PT.safeName(PT.baseName(file.name)) + "-ลดขนาด.pdf";

            if (mode.value === "light") {
              ctx.progress((f + 0.5) / files.length, "กำลังจัดโครงสร้าง " + file.name);
              const doc = await loadDoc(file);
              const blob = await pdfBlob(doc);
              after += blob.size;
              results.push({ blob, name: nameOut, note: PT.fmtBytes(file.size) + " → " + PT.fmtBytes(blob.size) });
              continue;
            }

            const scale = parseInt(dpi.value, 10) / 72;
            const srcDoc = await PT.openPdfJs(file);
            const out = await PDFDocument.create();
            for (let i = 1; i <= srcDoc.numPages; i++) {
              ctx.progress((f + i / srcDoc.numPages) / files.length, "หน้า " + i + "/" + srcDoc.numPages + " ของ " + file.name);
              const page = await srcDoc.getPage(i);
              const canvas = await PT.renderPageToCanvas(page, scale);
              if (gray.value) {
                const c = canvas.getContext("2d");
                const d = c.getImageData(0, 0, canvas.width, canvas.height);
                for (let p = 0; p < d.data.length; p += 4) {
                  const v = (d.data[p] * 0.299 + d.data[p + 1] * 0.587 + d.data[p + 2] * 0.114) | 0;
                  d.data[p] = d.data[p + 1] = d.data[p + 2] = v;
                }
                c.putImageData(d, 0, 0);
              }
              const jpg = await PT.canvasToBlob(canvas, "image/jpeg", q.value);
              const img = await out.embedJpg(await jpg.arrayBuffer());
              const vp = page.getViewport({ scale: 1 });
              const newPage = out.addPage([vp.width, vp.height]);
              newPage.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
              await PT.nextFrame();
            }
            const blob = await pdfBlob(out);
            after += blob.size;
            results.push({ blob, name: nameOut, note: PT.fmtBytes(file.size) + " → " + PT.fmtBytes(blob.size) });
          }

          const pct = before ? Math.round((1 - after / before) * 100) : 0;
          ctx.done(results, pct > 0 ? "เล็กลง " + pct + "% (" + PT.fmtBytes(before) + " → " + PT.fmtBytes(after) + ")"
            : "ไฟล์ต้นฉบับบีบมาดีอยู่แล้ว ผลลัพธ์ใหญ่ขึ้น " + Math.abs(pct) + "% — ลองลด dpi หรือคุณภาพลง");
        },
      }));
    },
  });

  /* =========================================================
     5. PDF -> รูปภาพ
     ========================================================= */
  PT.registerTool({
    id: "pdf-to-image", group: "pdf", icon: "image", color: "red", short: "PDF เป็นรูป",
    title: "แปลงเป็นรูป PDF → JPG",
    desc: "เปลี่ยนทุกหน้าเป็น JPG หรือ PNG พร้อมเลือกความละเอียด",
    long: "แปลงหน้า PDF เป็นไฟล์ภาพ ถ้ามีหลายหน้าจะรวมให้เป็นไฟล์ ZIP ไฟล์เดียว",
    build(root) {
      const picker = ui.picker({ accept: ".pdf,application/pdf", multiple: false, fileIcon: "file" });
      root.appendChild(picker);
      const fmt = ui.chips("รูปแบบไฟล์", [{ v: "image/jpeg", l: "JPG" }, { v: "image/png", l: "PNG" }], "image/jpeg",
        (v) => q.classList.toggle("hidden", v !== "image/jpeg"));
      const dpi = ui.chips("ความละเอียด", [
        { v: "96", l: "96 dpi" }, { v: "150", l: "150 dpi (แนะนำ)" }, { v: "220", l: "220 dpi" }, { v: "300", l: "300 dpi" },
      ], "150");
      const q = ui.slider("คุณภาพ JPG", { min: 0.4, max: 0.98, step: 0.02, value: 0.88, format: (v) => Math.round(v * 100) + "%" });
      const rangeTxt = ui.textInput("เลือกหน้า (เว้นว่าง = ทุกหน้า)", { placeholder: "เช่น 1-5, 8" });
      root.appendChild(fmt); root.appendChild(dpi); root.appendChild(q); root.appendChild(rangeTxt);

      root.appendChild(ui.runner({
        label: "แปลงเป็นรูปภาพ", icon: "image", toolId: "pdf-to-image",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกไฟล์");
          const doc = await PT.openPdfJs(files[0]);
          const ext = fmt.value === "image/png" ? "png" : "jpg";
          const base = PT.safeName(PT.baseName(files[0].name));
          const wanted = rangeTxt.value.trim() ? PT.parseRanges(rangeTxt.value, doc.numPages) : null;
          const pageNums = wanted ? wanted.map((i) => i + 1) : Array.from({ length: doc.numPages }, (_, i) => i + 1);
          if (!pageNums.length) throw new Error("ระบุหน้าไม่ถูกต้อง (ไฟล์มี " + doc.numPages + " หน้า)");

          const scale = parseInt(dpi.value, 10) / 72;
          const made = [];
          for (let i = 0; i < pageNums.length; i++) {
            ctx.progress(i / pageNums.length, "กำลังแปลงหน้า " + pageNums[i]);
            const page = await doc.getPage(pageNums[i]);
            const canvas = await PT.renderPageToCanvas(page, scale);
            made.push({ name: base + "-หน้า" + pageNums[i] + "." + ext, blob: await PT.canvasToBlob(canvas, fmt.value, q.value) });
            await PT.nextFrame();
          }

          if (made.length === 1) { ctx.done([{ blob: made[0].blob, name: made[0].name, icon: "image" }]); return; }
          ctx.progress(0.94, "กำลังบีบเป็น ZIP...");
          const JSZip = await PT.libs.jszip();
          const zip = new JSZip();
          made.forEach((m) => zip.file(m.name, m.blob));
          const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
          ctx.done([{ blob, name: base + "-รูปภาพ.zip", icon: "zip", note: made.length + " ภาพ" }]);
        },
      }));
    },
  });

  /* =========================================================
     6. ใส่เลขหน้า
     ========================================================= */
  PT.registerTool({
    id: "page-numbers", group: "pdf", icon: "hash", color: "indigo", short: "ใส่เลขหน้า",
    title: "ใส่เลขหน้า PDF",
    desc: "เติมเลขหน้าอัตโนมัติ เลือกตำแหน่งและรูปแบบได้",
    long: "ใส่เลขหน้าแบบไทยหรือสากล เลือกตำแหน่ง 6 จุด กำหนดเลขเริ่มต้น และข้ามหน้าปกได้",
    build(root) {
      const picker = ui.picker({ accept: ".pdf,application/pdf", multiple: false, fileIcon: "file" });
      root.appendChild(picker);
      const pos = ui.chips("ตำแหน่ง", [
        { v: "bc", l: "ล่างกลาง" }, { v: "br", l: "ล่างขวา" }, { v: "bl", l: "ล่างซ้าย" },
        { v: "tc", l: "บนกลาง" }, { v: "tr", l: "บนขวา" }, { v: "tl", l: "บนซ้าย" },
      ], "bc");
      const style = ui.chips("รูปแบบ", [
        { v: "n", l: "1" }, { v: "n/total", l: "1/10" }, { v: "dash", l: "- 1 -" },
        { v: "th", l: "หน้า 1" }, { v: "thfull", l: "หน้า 1 จาก 10" },
      ], "n");
      const start = ui.textInput("เริ่มนับที่เลข", { type: "number", value: "1", min: -999, max: 9999 });
      const skip = ui.toggle("ข้ามหน้าแรก", "ไม่ใส่เลขบนหน้าปก", false);
      const size = ui.slider("ขนาดตัวอักษร", { min: 7, max: 24, step: 1, value: 11, format: (v) => v + " pt" });
      const margin = ui.slider("ระยะขอบ", { min: 8, max: 60, step: 2, value: 24, format: (v) => v + " pt" });
      const color = ui.select("สีตัวอักษร", COLORS, "#111827");
      [pos, style, start, skip, size, margin, color].forEach((n) => root.appendChild(n));

      root.appendChild(ui.runner({
        label: "ใส่เลขหน้า", icon: "hash", toolId: "page-numbers",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกไฟล์");
          const { degrees } = await PT.libs.pdfLib();
          ctx.progress(0.15, "กำลังเปิดไฟล์...");
          const doc = await loadDoc(files[0]);
          ctx.progress(0.35, "กำลังฝังฟอนต์ภาษาไทย...");
          const font = await PT.embedThai(doc, false);
          const col = await rgbOf(color.value);
          const pages = doc.getPages();
          const startNum = parseInt(start.value, 10) || 1;
          const fs = size.value, mg = margin.value;
          const total = pages.length - (skip.value ? 1 : 0);

          pages.forEach((page, i) => {
            if (skip.value && i === 0) return;
            const num = startNum + i - (skip.value ? 1 : 0);
            const label = {
              n: String(num),
              "n/total": num + "/" + total,
              dash: "- " + num + " -",
              th: "หน้า " + num,
              thfull: "หน้า " + num + " จาก " + total,
            }[style.value];
            const d = displaySize(page);
            const w = font.widthOfTextAtSize(label, fs);
            const p = pos.value;
            let dx = p[1] === "l" ? mg : p[1] === "r" ? d.w - mg - w : (d.w - w) / 2;
            let dy = p[0] === "b" ? mg : d.h - mg - fs * 0.85;
            const at = place(page, dx, dy);
            page.drawText(label, { x: at.x, y: at.y, size: fs, font: font, color: col, rotate: degrees(at.rot) });
          });

          ctx.progress(0.9, "กำลังบันทึก...");
          const blob = await pdfBlob(doc);
          ctx.done([{ blob, name: PT.safeName(PT.baseName(files[0].name)) + "-ใส่เลขหน้า.pdf", note: pages.length + " หน้า" }]);
        },
      }));
    },
  });

  /* =========================================================
     7. ใส่ลายน้ำ
     ========================================================= */
  PT.registerTool({
    id: "watermark", group: "pdf", icon: "droplet", color: "magenta", short: "ใส่ลายน้ำ",
    title: "ใส่ลายน้ำ PDF",
    desc: "ใส่ข้อความหรือโลโก้ทับเอกสาร ปรับความจางและมุมเอียงได้",
    long: "ใส่ลายน้ำเป็นข้อความไทย/อังกฤษ หรือใช้รูปโลโก้ก็ได้ เลือกวางกลางหน้า เรียงเต็มหน้า หรือมุมล่างขวา",
    build(root) {
      const picker = ui.picker({ accept: ".pdf,application/pdf", multiple: false, fileIcon: "file" });
      root.appendChild(picker);

      const kind = ui.chips("ชนิดลายน้ำ", [{ v: "text", l: "ข้อความ" }, { v: "image", l: "รูปภาพ" }], "text", () => sync());
      const text = ui.textInput("ข้อความลายน้ำ", { value: "ตัวอย่าง", placeholder: "เช่น สำเนา, ห้ามคัดลอก" });
      const imgPicker = ui.picker({ accept: "image/png,image/jpeg", multiple: false, fileIcon: "image", title: "เลือกรูปลายน้ำ (แนะนำ PNG พื้นหลังโปร่ง)" });
      const layout = ui.chips("การจัดวาง", [
        { v: "center", l: "กลางหน้า" }, { v: "tile", l: "เรียงเต็มหน้า" }, { v: "corner", l: "มุมล่างขวา" },
      ], "center");
      const size = ui.slider("ขนาด", { min: 10, max: 120, step: 2, value: 48, format: (v) => v + " pt" });
      const opacity = ui.slider("ความจาง", { min: 0.05, max: 1, step: 0.05, value: 0.25, format: (v) => Math.round(v * 100) + "%" });
      const angle = ui.slider("มุมเอียง", { min: -90, max: 90, step: 5, value: 45, format: (v) => v + "°" });
      const color = ui.select("สีข้อความ", COLORS, "#6b7280");
      const rangeTxt = ui.textInput("ใส่เฉพาะหน้า (เว้นว่าง = ทุกหน้า)", { placeholder: "เช่น 1-3, 7" });
      [kind, text, imgPicker, layout, size, opacity, angle, color, rangeTxt].forEach((n) => root.appendChild(n));

      function sync() {
        const isText = kind.value === "text";
        text.classList.toggle("hidden", !isText);
        color.classList.toggle("hidden", !isText);
        imgPicker.classList.toggle("hidden", isText);
      }
      sync();

      root.appendChild(ui.runner({
        label: "ใส่ลายน้ำ", icon: "droplet", toolId: "watermark",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกไฟล์ PDF");
          const { degrees } = await PT.libs.pdfLib();
          const doc = await loadDoc(files[0]);
          const pages = doc.getPages();
          const idx = rangeTxt.value.trim() ? PT.parseRanges(rangeTxt.value, pages.length) : pages.map((_, i) => i);
          if (!idx.length) throw new Error("ระบุหน้าไม่ถูกต้อง");

          const textColor = await rgbOf(color.value);
          let font = null, image = null, imgW = 0, imgH = 0;
          if (kind.value === "text") {
            if (!text.value.trim()) throw new Error("ยังไม่ได้พิมพ์ข้อความลายน้ำ");
            ctx.progress(0.25, "กำลังฝังฟอนต์...");
            font = await PT.embedThai(doc, true);
          } else {
            const imgFiles = imgPicker.files();
            if (!imgFiles.length) throw new Error("ยังไม่ได้เลือกรูปลายน้ำ");
            const bytes = await imgFiles[0].arrayBuffer();
            image = /png$/i.test(imgFiles[0].type) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
            imgW = image.width; imgH = image.height;
          }

          const op = opacity.value, ang = angle.value;
          idx.forEach((pi, k) => {
            ctx.progress(0.3 + 0.6 * (k / idx.length), "กำลังใส่ลายน้ำหน้า " + (pi + 1));
            const page = pages[pi];
            const d = displaySize(page);
            const spots = [];
            if (layout.value === "center") spots.push([d.w / 2, d.h / 2]);
            else if (layout.value === "corner") spots.push([d.w * 0.78, d.h * 0.12]);
            else {
              const stepX = d.w / 3, stepY = d.h / 4;
              for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) spots.push([stepX * (c + 0.5), stepY * (r + 0.5)]);
            }
            spots.forEach(([cx, cy]) => {
              if (font) {
                const fs = layout.value === "tile" ? size.value * 0.6 : size.value;
                const w = font.widthOfTextAtSize(text.value, fs);
                const rad = (ang * Math.PI) / 180;
                // shift so the text is centred on the anchor point
                const dx = cx - (Math.cos(rad) * w) / 2 + (Math.sin(rad) * fs) / 2;
                const dy = cy - (Math.sin(rad) * w) / 2 - (Math.cos(rad) * fs) / 2;
                const at = place(page, dx, dy);
                page.drawText(text.value, { x: at.x, y: at.y, size: fs, font: font, color: textColor, opacity: op, rotate: degrees(ang + at.rot) });
              } else {
                const targetW = (layout.value === "tile" ? d.w * 0.22 : d.w * (size.value / 120)) || d.w * 0.4;
                const scale = targetW / imgW;
                const w = imgW * scale, h = imgH * scale;
                const rad = (ang * Math.PI) / 180;
                const dx = cx - (Math.cos(rad) * w) / 2 + (Math.sin(rad) * h) / 2;
                const dy = cy - (Math.sin(rad) * w) / 2 - (Math.cos(rad) * h) / 2;
                const at = place(page, dx, dy);
                page.drawImage(image, { x: at.x, y: at.y, width: w, height: h, opacity: op, rotate: degrees(ang + at.rot) });
              }
            });
          });

          ctx.progress(0.93, "กำลังบันทึก...");
          const blob = await pdfBlob(doc);
          ctx.done([{ blob, name: PT.safeName(PT.baseName(files[0].name)) + "-ลายน้ำ.pdf", note: idx.length + " หน้า" }]);
        },
      }));
    },
  });

  /* =========================================================
     8. หมุนหน้า
     ========================================================= */
  PT.registerTool({
    id: "rotate", group: "pdf", icon: "rotate", color: "cyan", short: "หมุนหน้า",
    title: "หมุนหน้า PDF",
    desc: "หมุนทุกหน้า หน้าคี่ หน้าคู่ หรือเฉพาะหน้าที่ระบุ",
    long: "แก้เอกสารที่สแกนมากลับหัวหรือวางแนวผิด ด้วยการหมุนทีละกลุ่มหน้า",
    build(root) {
      const picker = ui.picker({ accept: ".pdf,application/pdf", multiple: false, fileIcon: "file" });
      root.appendChild(picker);
      const dir = ui.chips("ทิศทาง", [
        { v: "90", l: "หมุนขวา 90°" }, { v: "180", l: "กลับหัว 180°" }, { v: "270", l: "หมุนซ้าย 90°" },
      ], "90");
      const target = ui.chips("ใช้กับ", [
        { v: "all", l: "ทุกหน้า" }, { v: "odd", l: "หน้าคี่" }, { v: "even", l: "หน้าคู่" }, { v: "pick", l: "ระบุหน้า" },
      ], "all", () => rangeTxt.classList.toggle("hidden", target.value !== "pick"));
      const rangeTxt = ui.textInput("หน้าที่ต้องการหมุน", { placeholder: "เช่น 2, 5-8" });
      rangeTxt.classList.add("hidden");
      [dir, target, rangeTxt].forEach((n) => root.appendChild(n));

      root.appendChild(ui.runner({
        label: "หมุนหน้า", icon: "rotate", toolId: "rotate",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกไฟล์");
          const { degrees } = await PT.libs.pdfLib();
          const doc = await loadDoc(files[0]);
          const pages = doc.getPages();
          const add = parseInt(dir.value, 10);
          let idx;
          if (target.value === "all") idx = pages.map((_, i) => i);
          else if (target.value === "odd") idx = pages.map((_, i) => i).filter((i) => i % 2 === 0);
          else if (target.value === "even") idx = pages.map((_, i) => i).filter((i) => i % 2 === 1);
          else idx = PT.parseRanges(rangeTxt.value, pages.length);
          if (!idx.length) throw new Error("ไม่มีหน้าที่ตรงกับเงื่อนไข");
          ctx.progress(0.6, "กำลังหมุน " + idx.length + " หน้า");
          idx.forEach((i) => {
            const cur = ((pages[i].getRotation().angle % 360) + 360) % 360;
            pages[i].setRotation(degrees((cur + add) % 360));
          });
          const blob = await pdfBlob(doc);
          ctx.done([{ blob, name: PT.safeName(PT.baseName(files[0].name)) + "-หมุน.pdf", note: idx.length + " หน้า" }]);
        },
      }));
    },
  });

  /* =========================================================
     9. ดึงข้อความ
     ========================================================= */
  PT.registerTool({
    id: "extract-text", group: "pdf", icon: "text", color: "slate", short: "ดึงข้อความ",
    title: "ดึงข้อความจาก PDF",
    desc: "คัดลอกข้อความออกมาเป็นไฟล์ .txt หรือก๊อปไปวางต่อ",
    long: "ดึงข้อความที่ฝังอยู่ในไฟล์ PDF ออกมา (ใช้ไม่ได้กับเอกสารสแกนที่เป็นภาพล้วน)",
    build(root) {
      const picker = ui.picker({ accept: ".pdf,application/pdf", multiple: false, fileIcon: "file" });
      root.appendChild(picker);
      const marks = ui.toggle("ใส่หัวข้อคั่นหน้า", 'เช่น "--- หน้า 2 ---"', true);
      root.appendChild(marks);
      const preview = el("textarea", { rows: 10, placeholder: "ข้อความที่ดึงได้จะแสดงตรงนี้", readonly: true, style: { marginTop: "14px" } });
      const copyBtn = el("button", {
        class: "btn ghost wide", type: "button",
        onclick: async () => {
          if (!preview.value) return;
          try { await navigator.clipboard.writeText(preview.value); PT.toast("คัดลอกแล้ว", "ok"); }
          catch (e) { preview.removeAttribute("readonly"); preview.select(); PT.toast("กด Ctrl+C เพื่อคัดลอก"); }
        },
      }, [PT.iconEl("copy"), el("span", { text: "คัดลอกข้อความ" })]);

      root.appendChild(ui.runner({
        label: "ดึงข้อความ", icon: "text", toolId: "extract-text",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกไฟล์");
          const doc = await PT.openPdfJs(files[0]);
          let all = "";
          for (let i = 1; i <= doc.numPages; i++) {
            ctx.progress(i / doc.numPages, "กำลังอ่านหน้า " + i + "/" + doc.numPages);
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            let line = "", out = "";
            tc.items.forEach((it) => {
              line += it.str;
              if (it.hasEOL) { out += line + "\n"; line = ""; }
            });
            if (line) out += line + "\n";
            all += (marks.value ? "--- หน้า " + i + " ---\n" : "") + out + "\n";
          }
          preview.value = all.trim();
          if (!preview.value) throw new Error("ไม่พบข้อความในไฟล์นี้ (น่าจะเป็นเอกสารสแกน ลองใช้เครื่องมืออื่น)");
          const blob = new Blob([all], { type: "text/plain;charset=utf-8" });
          ctx.done([{ blob, name: PT.safeName(PT.baseName(files[0].name)) + ".txt", icon: "text", note: all.length.toLocaleString() + " ตัวอักษร" }]);
        },
      }));
      root.appendChild(preview);
      root.appendChild(el("div", { class: "btn-row" }, copyBtn));
    },
  });

  /* =========================================================
     10. ลงลายเซ็น
     ========================================================= */
  PT.registerTool({
    id: "sign", group: "pdf", icon: "pen", color: "rose", short: "ลงลายเซ็น",
    title: "ลงลายเซ็น PDF",
    desc: "วาดลายเซ็นหรือใช้รูป แล้วลากวางตำแหน่งบนหน้าเอกสาร",
    long: "เซ็นเอกสารได้เลยบนมือถือ: วาดลายเซ็นด้วยนิ้ว เลือกหน้า แล้วลากวางตำแหน่งกับปรับขนาดตามต้องการ",
    build(root) {
      let pdfFile = null, pdfjsDoc = null, pageCount = 0, sigDataUrl = null;
      let boxFrac = { x: 0.55, y: 0.72, w: 0.32, h: 0.12 };

      const picker = ui.picker({
        accept: ".pdf,application/pdf", multiple: false, fileIcon: "file",
        onChange: async (files) => {
          if (!files.length) return;
          pdfFile = files[0];
          try {
            pdfjsDoc = await PT.openPdfJs(pdfFile);
            pageCount = pdfjsDoc.numPages;
            pageSel.innerHTML = "";
            for (let i = 1; i <= pageCount; i++) pageSel.appendChild(el("option", { value: String(i), text: "หน้า " + i }));
            await drawPreview();
          } catch (e) { PT.toast(e.message, "err"); }
        },
      });
      root.appendChild(picker);

      /* --- signature source --- */
      root.appendChild(ui.sectionTitle("ลายเซ็นของคุณ"));
      const pad = el("canvas", { class: "sigpad" });
      const padWrap = el("div", {}, pad);
      root.appendChild(padWrap);
      const sigFile = ui.picker({
        accept: "image/png,image/jpeg", multiple: false, fileIcon: "image",
        title: "หรือเลือกรูปลายเซ็น (PNG พื้นโปร่งจะสวยที่สุด)", hint: "แตะเพื่อเลือกรูป",
        onChange: (files) => {
          if (!files.length) return;
          const r = new FileReader();
          r.onload = () => { sigDataUrl = r.result; showSig(); };
          r.readAsDataURL(files[0]);
        },
      });
      root.appendChild(
        el("div", { class: "btn-row" }, [
          el("button", { class: "btn ghost", type: "button", onclick: clearPad }, [PT.iconEl("refresh"), el("span", { text: "ล้างลายเซ็น" })]),
          el("button", { class: "btn", type: "button", onclick: useDrawing }, [PT.iconEl("check"), el("span", { text: "ใช้ลายเซ็นนี้" })]),
        ])
      );
      root.appendChild(sigFile);

      function setupPad() {
        const dpr = window.devicePixelRatio || 1;
        const rect = pad.getBoundingClientRect();
        pad.width = Math.max(300, rect.width * dpr);
        pad.height = 190 * dpr;
        const c = pad.getContext("2d");
        c.scale(dpr, dpr);
        c.lineWidth = 2.6; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#111827";
        let drawing = false;
        const pos = (e) => {
          const r = pad.getBoundingClientRect();
          return [e.clientX - r.left, e.clientY - r.top];
        };
        pad.addEventListener("pointerdown", (e) => {
          drawing = true; pad.setPointerCapture(e.pointerId);
          const [x, y] = pos(e); c.beginPath(); c.moveTo(x, y);
        });
        pad.addEventListener("pointermove", (e) => {
          if (!drawing) return;
          const [x, y] = pos(e); c.lineTo(x, y); c.stroke();
        });
        ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => pad.addEventListener(ev, () => (drawing = false)));
      }
      function clearPad() {
        pad.getContext("2d").clearRect(0, 0, pad.width, pad.height);
        sigDataUrl = null;
        sigPreview.innerHTML = "";
        drawPreview();
      }
      function trimCanvas(canvas) {
        const c = canvas.getContext("2d");
        const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
        let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            if (d[(y * canvas.width + x) * 4 + 3] > 12) {
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return null;
        const pad2 = 6;
        minX = Math.max(0, minX - pad2); minY = Math.max(0, minY - pad2);
        maxX = Math.min(canvas.width - 1, maxX + pad2); maxY = Math.min(canvas.height - 1, maxY + pad2);
        const out = document.createElement("canvas");
        out.width = maxX - minX + 1; out.height = maxY - minY + 1;
        out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
        return out;
      }
      function useDrawing() {
        const trimmed = trimCanvas(pad);
        if (!trimmed) { PT.toast("ยังไม่ได้วาดลายเซ็น", "err"); return; }
        sigDataUrl = trimmed.toDataURL("image/png");
        boxFrac.h = boxFrac.w * (trimmed.height / trimmed.width) * 0.75;
        showSig();
      }
      const sigPreview = el("div", { style: { marginTop: "10px" } });
      root.appendChild(sigPreview);
      function showSig() {
        sigPreview.innerHTML = "";
        if (!sigDataUrl) return;
        sigPreview.appendChild(el("img", { src: sigDataUrl, alt: "ลายเซ็น", style: { maxHeight: "70px", background: "var(--surface-2)", borderRadius: "10px", padding: "6px" } }));
        PT.toast("บันทึกลายเซ็นแล้ว ลากวางตำแหน่งด้านล่างได้เลย", "ok");
        drawPreview();
      }

      /* --- placement stage --- */
      root.appendChild(ui.sectionTitle("วางตำแหน่งลายเซ็น"));
      const pageSel = el("select");
      pageSel.addEventListener("change", drawPreview);
      root.appendChild(el("div", { class: "opt" }, [el("label", { class: "lbl", text: "เลือกหน้า" }), pageSel]));

      const stage = el("div", { class: "stage" });
      const stageCanvas = el("canvas");
      const box = el("div", { class: "box" });
      const rz = el("div", { class: "rz" });
      box.appendChild(rz);
      stage.appendChild(stageCanvas);
      stage.appendChild(box);
      root.appendChild(stage);

      async function drawPreview() {
        if (!pdfjsDoc) return;
        const pageNo = parseInt(pageSel.value || "1", 10);
        const page = await pdfjsDoc.getPage(pageNo);
        const maxW = Math.min(root.clientWidth || 360, 520);
        const vp1 = page.getViewport({ scale: 1 });
        const canvas = await PT.renderPageToCanvas(page, maxW / vp1.width);
        stageCanvas.width = canvas.width; stageCanvas.height = canvas.height;
        stageCanvas.getContext("2d").drawImage(canvas, 0, 0);
        stage.style.width = canvas.width + "px";
        paintBox();
      }
      function paintBox() {
        box.style.left = boxFrac.x * 100 + "%";
        box.style.top = boxFrac.y * 100 + "%";
        box.style.width = boxFrac.w * 100 + "%";
        box.style.height = boxFrac.h * 100 + "%";
        box.querySelectorAll("img").forEach((n) => n.remove());
        if (sigDataUrl) box.insertBefore(el("img", { src: sigDataUrl, alt: "" }), rz);
      }
      function dragify(target, mode) {
        target.addEventListener("pointerdown", (e) => {
          e.preventDefault(); e.stopPropagation();
          const rect = stage.getBoundingClientRect();
          const start = { x: e.clientX, y: e.clientY, b: Object.assign({}, boxFrac) };
          target.setPointerCapture(e.pointerId);
          const move = (ev) => {
            const dx = (ev.clientX - start.x) / rect.width;
            const dy = (ev.clientY - start.y) / rect.height;
            if (mode === "move") {
              boxFrac.x = Math.min(1 - start.b.w, Math.max(0, start.b.x + dx));
              boxFrac.y = Math.min(1 - start.b.h, Math.max(0, start.b.y + dy));
            } else {
              boxFrac.w = Math.min(1 - boxFrac.x, Math.max(0.05, start.b.w + dx));
              boxFrac.h = Math.min(1 - boxFrac.y, Math.max(0.03, start.b.h + dy));
            }
            paintBox();
          };
          const up = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", up);
        });
      }
      dragify(box, "move");
      dragify(rz, "resize");
      paintBox();
      setTimeout(setupPad, 60);

      const allPages = ui.toggle("ใส่ทุกหน้า", "วางลายเซ็นตำแหน่งเดียวกันในทุกหน้า", false);
      root.appendChild(allPages);

      root.appendChild(ui.runner({
        label: "เซ็นและบันทึก", icon: "pen", toolId: "sign",
        onRun: async (ctx) => {
          if (!pdfFile) throw new Error("ยังไม่ได้เลือกไฟล์ PDF");
          if (!sigDataUrl) throw new Error("ยังไม่มีลายเซ็น (วาดแล้วกด \"ใช้ลายเซ็นนี้\" หรือเลือกรูป)");
          const { degrees } = await PT.libs.pdfLib();
          ctx.progress(0.3, "กำลังเปิดเอกสาร...");
          const doc = await loadDoc(pdfFile);
          const bytes = await (await fetch(sigDataUrl)).arrayBuffer();
          const img = /^data:image\/png/.test(sigDataUrl) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          const pages = doc.getPages();
          const targets = allPages.value ? pages.map((_, i) => i) : [parseInt(pageSel.value || "1", 10) - 1];
          targets.forEach((i) => {
            const page = pages[i];
            const d = displaySize(page);
            const w = boxFrac.w * d.w, h = boxFrac.h * d.h;
            const dx = boxFrac.x * d.w;
            const dy = d.h - (boxFrac.y * d.h) - h;
            const at = place(page, dx, dy);
            page.drawImage(img, { x: at.x, y: at.y, width: w, height: h, rotate: degrees(at.rot) });
          });
          ctx.progress(0.9, "กำลังบันทึก...");
          const blob = await pdfBlob(doc);
          ctx.done([{ blob, name: PT.safeName(PT.baseName(pdfFile.name)) + "-ลงลายเซ็น.pdf", note: targets.length + " หน้า" }]);
        },
      }));
    },
  });
})();
