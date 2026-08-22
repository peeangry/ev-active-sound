/* ============================================================
   PDF Toolbox - image tools
   scan-to-pdf / images-to-pdf / image compressor
   ============================================================ */
(function () {
  "use strict";
  const PT = window.PT;
  const el = PT.el;
  const ui = PT.ui;

  const A4 = { w: 595.28, h: 841.89 };
  const LETTER = { w: 612, h: 792 };

  /* Draws an image into a canvas, capped at maxDim on the long side. */
  function drawScaled(img, maxDim) {
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const s = Math.min(1, maxDim / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w0 * s));
    canvas.height = Math.max(1, Math.round(h0 * s));
    const c = canvas.getContext("2d");
    c.fillStyle = "#fff";
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function rotateCanvas(canvas, deg) {
    if (!deg) return canvas;
    const out = document.createElement("canvas");
    const swap = deg % 180 !== 0;
    out.width = swap ? canvas.height : canvas.width;
    out.height = swap ? canvas.width : canvas.height;
    const c = out.getContext("2d");
    c.translate(out.width / 2, out.height / 2);
    c.rotate((deg * Math.PI) / 180);
    c.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
  }

  /* ---------- document filters ---------- */
  function toGray(d) {
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  /* Stretches the 2nd..98th percentile of the luminance range to 0..255,
     which is what makes a phone photo of paper look like a real scan. */
  function autoLevels(d) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++;
    const total = d.length / 4;
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
    if (hi - lo < 24) return;
    const scale = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.max(0, Math.min(255, (d[i] - lo) * scale));
      d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] - lo) * scale));
      d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] - lo) * scale));
    }
  }

  /* Adaptive (local mean) threshold via an integral image - keeps thin Thai
     glyphs readable where a global threshold would drop them. */
  function adaptiveThreshold(data, w, h) {
    const gray = new Float64Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
      }
    }
    const rad = Math.max(8, Math.round(Math.min(w, h) / 24));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - rad), y1 = Math.min(h - 1, y + rad);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - rad), x1 = Math.min(w - 1, x + rad);
        const area = (y1 - y0 + 1) * (x1 - x0 + 1);
        const sum = integral[(y1 + 1) * (w + 1) + x1 + 1] - integral[y0 * (w + 1) + x1 + 1]
          - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        const v = gray[y * w + x] > (sum / area) * 0.93 ? 255 : 0;
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
    }
  }

  function applyFilter(canvas, mode) {
    if (mode === "color") return canvas;
    const c = canvas.getContext("2d");
    const img = c.getImageData(0, 0, canvas.width, canvas.height);
    if (mode === "enhance") autoLevels(img.data);
    else if (mode === "gray") { toGray(img.data); autoLevels(img.data); }
    else if (mode === "bw") adaptiveThreshold(img.data, canvas.width, canvas.height);
    c.putImageData(img, 0, 0);
    return canvas;
  }

  /* Builds a PDF out of a list of canvases. */
  async function canvasesToPdf(canvases, opts, onProgress) {
    const { PDFDocument } = await PT.libs.pdfLib();
    const doc = await PDFDocument.create();
    for (let i = 0; i < canvases.length; i++) {
      if (onProgress) onProgress(i / canvases.length);
      const canvas = canvases[i];
      const jpg = await PT.canvasToBlob(canvas, "image/jpeg", opts.quality);
      const img = await doc.embedJpg(await jpg.arrayBuffer());
      let pw, ph;
      if (opts.size === "fit") {
        // page exactly as big as the image (72 dpi mapping keeps text readable)
        const scale = 72 / (opts.dpi || 150);
        pw = canvas.width * scale; ph = canvas.height * scale;
      } else {
        const base = opts.size === "letter" ? LETTER : A4;
        const landscape = opts.orient === "landscape" || (opts.orient === "auto" && canvas.width > canvas.height);
        pw = landscape ? base.h : base.w;
        ph = landscape ? base.w : base.h;
      }
      const page = doc.addPage([pw, ph]);
      const m = opts.margin || 0;
      const availW = pw - m * 2, availH = ph - m * 2;
      const s = Math.min(availW / canvas.width, availH / canvas.height);
      const w = canvas.width * s, h = canvas.height * s;
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      await PT.nextFrame();
    }
    const bytes = await doc.save({ useObjectStreams: true });
    return new Blob([bytes], { type: "application/pdf" });
  }

  /* =========================================================
     สแกนเอกสาร
     ========================================================= */
  PT.registerTool({
    id: "scan", group: "image", icon: "scan", color: "pink", short: "สแกน",
    title: "สแกนเอกสาร",
    desc: "ถ่ายหรือเลือกรูปเอกสาร แล้วแปลงเป็น PDF คมชัดเหมือนสแกน",
    long: "ถ่ายรูปเอกสารด้วยกล้อง เลือกฟิลเตอร์ให้ตัวหนังสือคมชัด จัดลำดับหน้า แล้วบันทึกเป็น PDF ไฟล์เดียว",
    build(root) {
      let shots = []; // { canvas, rotate, name }
      const grid = el("div", { class: "thumbs" });
      const status = el("div", { class: "desc" });

      const filter = ui.chips("โหมดภาพ", [
        { v: "enhance", l: "เอกสารสี (แนะนำ)" },
        { v: "gray", l: "ขาวดำนุ่ม" },
        { v: "bw", l: "ขาวดำคมชัด" },
        { v: "color", l: "ภาพต้นฉบับ" },
      ], "enhance", () => repaint(), "ฟิลเตอร์จะปรับความสว่างและคอนทราสต์ให้อ่านง่ายขึ้น");

      const picker = ui.picker({
        accept: "image/*", multiple: true, camera: true, fileIcon: "image",
        title: "ถ่ายรูปเอกสาร หรือเลือกรูปจากเครื่อง",
        hint: "รองรับหลายหน้า ถ่ายทีละหน้าแล้วจัดลำดับได้",
        onChange: async (files) => {
          if (!files.length) return;
          status.textContent = "กำลังเตรียมภาพ...";
          for (const f of files) {
            try {
              const img = await PT.imageFromFile(f);
              // full-size copy for export, small copy for the live preview grid
              shots.push({ canvas: drawScaled(img, 2200), preview: drawScaled(img, 360), rotate: 0, name: f.name });
            } catch (e) { PT.toast("เปิดรูป " + f.name + " ไม่ได้", "err"); }
            await PT.nextFrame();
          }
          picker.setFiles([]);
          repaint();
        },
      });
      root.appendChild(picker);
      root.appendChild(filter);
      root.appendChild(status);
      root.appendChild(grid);
      root.appendChild(ui.note("ลากที่จุดมุมซ้ายบนของหน้าเพื่อสลับลำดับ • แตะไอคอนหมุนเพื่อแก้หน้าที่ตะแคง"));

      const sizeOpt = ui.chips("ขนาดหน้ากระดาษ", [
        { v: "a4", l: "A4" }, { v: "letter", l: "Letter" }, { v: "fit", l: "เท่าภาพต้นฉบับ" },
      ], "a4");
      const marginOpt = ui.slider("ขอบกระดาษ", { min: 0, max: 48, step: 4, value: 16, format: (v) => v + " pt" });
      const quality = ui.slider("คุณภาพ", { min: 0.5, max: 0.95, step: 0.05, value: PT.settings.quality, format: (v) => Math.round(v * 100) + "%" });
      [sizeOpt, marginOpt, quality].forEach((n) => root.appendChild(n));

      function repaint() {
        grid.innerHTML = "";
        shots.forEach((s, i) => {
          const work = applyFilter(rotateCanvas(cloneCanvas(s.preview), s.rotate), filter.value);
          const holder = el("div", { class: "thumb" }, [
            el("img", { src: work.toDataURL("image/jpeg", 0.6), alt: "" }),
            el("div", { class: "grip" }, PT.iconEl("grip")),
            el("div", { class: "n", text: "หน้า " + (i + 1) }),
            el("div", { class: "tops" }, [
              el("button", { type: "button", title: "หมุน", onclick: () => { s.rotate = (s.rotate + 90) % 360; repaint(); } }, PT.iconEl("rotate")),
              el("button", { type: "button", title: "ลบ", onclick: () => { shots.splice(i, 1); repaint(); } }, PT.iconEl("trash")),
            ]),
          ]);
          grid.appendChild(holder);
        });
        status.textContent = shots.length ? shots.length + " หน้า พร้อมบันทึก" : "";
      }

      function cloneCanvas(src) {
        const c = document.createElement("canvas");
        c.width = src.width; c.height = src.height;
        c.getContext("2d").drawImage(src, 0, 0);
        return c;
      }

      ui.enableReorder(grid, {
        itemSelector: ".thumb", handleSelector: ".grip",
        onReorder: (from, to) => { const m = shots.splice(from, 1)[0]; shots.splice(to, 0, m); repaint(); },
      });

      root.appendChild(ui.runner({
        label: "บันทึกเป็น PDF", icon: "file", toolId: "scan",
        onRun: async (ctx) => {
          if (!shots.length) throw new Error("ยังไม่มีหน้าเอกสาร ถ่ายรูปหรือเลือกรูปก่อน");
          const canvases = [];
          for (let i = 0; i < shots.length; i++) {
            ctx.progress(0.1 + 0.5 * (i / shots.length), "กำลังปรับภาพหน้า " + (i + 1));
            canvases.push(applyFilter(rotateCanvas(cloneCanvas(shots[i].canvas), shots[i].rotate), filter.value));
            await PT.nextFrame();
          }
          const blob = await canvasesToPdf(canvases, {
            quality: quality.value, size: sizeOpt.value, orient: "auto", margin: marginOpt.value, dpi: 150,
          }, (p) => ctx.progress(0.6 + 0.35 * p, "กำลังสร้าง PDF..."));
          const stamp = new Date().toISOString().slice(0, 10);
          const thumb = canvases[0].toDataURL("image/jpeg", 0.4);
          ctx.done([{ blob, name: "สแกน-" + stamp + ".pdf", note: canvases.length + " หน้า", thumb }]);
        },
      }));
    },
  });

  /* =========================================================
     รูปภาพ -> PDF
     ========================================================= */
  PT.registerTool({
    id: "image-to-pdf", group: "image", icon: "imgToPdf", color: "sky", short: "รูปเป็น PDF",
    title: "JPG → PDF",
    desc: "รวมรูปถ่ายหรือภาพหลายไฟล์ให้เป็น PDF เล่มเดียว",
    long: "รวมรูป JPG/PNG/WEBP หลายไฟล์เป็น PDF เลือกขนาดกระดาษและขอบได้",
    build(root) {
      const picker = ui.picker({ accept: "image/*", multiple: true, fileIcon: "image", hint: "เลือกรูปหลายไฟล์ แล้วจัดลำดับด้วยปุ่มลูกศร" });
      root.appendChild(picker);
      const sizeOpt = ui.chips("ขนาดหน้ากระดาษ", [
        { v: "fit", l: "เท่าภาพ" }, { v: "a4", l: "A4" }, { v: "letter", l: "Letter" },
      ], "fit");
      const orient = ui.chips("แนวกระดาษ", [
        { v: "auto", l: "อัตโนมัติ" }, { v: "portrait", l: "แนวตั้ง" }, { v: "landscape", l: "แนวนอน" },
      ], "auto");
      const marginOpt = ui.slider("ขอบกระดาษ", { min: 0, max: 48, step: 4, value: 0, format: (v) => v + " pt" });
      const quality = ui.slider("คุณภาพ", { min: 0.5, max: 0.98, step: 0.02, value: 0.88, format: (v) => Math.round(v * 100) + "%" });
      const maxDim = ui.chips("ย่อภาพก่อนใส่", [
        { v: "0", l: "ไม่ย่อ" }, { v: "2400", l: "2400 px" }, { v: "1800", l: "1800 px" }, { v: "1200", l: "1200 px" },
      ], "2400", null, "ย่อภาพช่วยให้ไฟล์ PDF เล็กลงมาก");
      [sizeOpt, orient, marginOpt, quality, maxDim].forEach((n) => root.appendChild(n));

      root.appendChild(ui.runner({
        label: "สร้างไฟล์ PDF", icon: "file", toolId: "image-to-pdf",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกรูป");
          const cap = parseInt(maxDim.value, 10) || 100000;
          const canvases = [];
          for (let i = 0; i < files.length; i++) {
            ctx.progress(0.1 + 0.45 * (i / files.length), "กำลังอ่านรูป " + (i + 1) + "/" + files.length);
            const img = await PT.imageFromFile(files[i]);
            canvases.push(drawScaled(img, cap));
            await PT.nextFrame();
          }
          const blob = await canvasesToPdf(canvases, {
            quality: quality.value, size: sizeOpt.value, orient: orient.value, margin: marginOpt.value, dpi: 150,
          }, (p) => ctx.progress(0.55 + 0.4 * p, "กำลังสร้าง PDF..."));
          ctx.done([{ blob, name: PT.safeName(PT.baseName(files[0].name)) + "-รวมรูป.pdf", note: canvases.length + " หน้า", thumb: canvases[0].toDataURL("image/jpeg", 0.4) }]);
        },
      }));
    },
  });

  /* =========================================================
     ลดขนาดไฟล์ภาพ
     ========================================================= */
  PT.registerTool({
    id: "image-compress", group: "image", icon: "images", color: "orange", short: "ลดขนาดภาพ",
    title: "ลดขนาดไฟล์ภาพ",
    desc: "บีบอัด JPG, PNG, WEBP พร้อมย่อขนาดภาพในคราวเดียว",
    long: "ลดขนาดไฟล์ภาพหลายไฟล์พร้อมกัน เลือกความกว้างสูงสุดและคุณภาพได้ ถ้าหลายไฟล์จะได้ผลลัพธ์เป็น ZIP",
    build(root) {
      const picker = ui.picker({ accept: "image/*", multiple: true, fileIcon: "image" });
      root.appendChild(picker);
      const maxDim = ui.chips("ขนาดด้านยาวสูงสุด", [
        { v: "0", l: "คงเดิม" }, { v: "2560", l: "2560 px" }, { v: "1920", l: "1920 px" },
        { v: "1280", l: "1280 px" }, { v: "800", l: "800 px" },
      ], "1920");
      const fmt = ui.chips("รูปแบบไฟล์", [
        { v: "image/jpeg", l: "JPG" }, { v: "image/webp", l: "WEBP (เล็กกว่า)" }, { v: "image/png", l: "PNG" },
      ], "image/jpeg");
      const quality = ui.slider("คุณภาพ", { min: 0.3, max: 0.95, step: 0.05, value: PT.settings.quality, format: (v) => Math.round(v * 100) + "%" });
      [maxDim, fmt, quality].forEach((n) => root.appendChild(n));

      root.appendChild(ui.runner({
        label: "ลดขนาดภาพ", icon: "compress", toolId: "image-compress",
        onRun: async (ctx) => {
          const files = picker.files();
          if (!files.length) throw new Error("ยังไม่ได้เลือกรูป");
          const cap = parseInt(maxDim.value, 10) || 100000;
          const ext = fmt.value === "image/png" ? "png" : fmt.value === "image/webp" ? "webp" : "jpg";
          const made = [];
          let before = 0, after = 0;
          for (let i = 0; i < files.length; i++) {
            ctx.progress(i / files.length, "กำลังบีบอัด " + files[i].name);
            const img = await PT.imageFromFile(files[i]);
            const canvas = drawScaled(img, cap);
            const blob = await PT.canvasToBlob(canvas, fmt.value, quality.value);
            before += files[i].size; after += blob.size;
            made.push({ name: PT.safeName(PT.baseName(files[i].name)) + "-เล็ก." + ext, blob: blob, canvas: canvas });
            await PT.nextFrame();
          }
          const pct = before ? Math.round((1 - after / before) * 100) : 0;
          const stat = "รวม " + PT.fmtBytes(before) + " → " + PT.fmtBytes(after) + (pct > 0 ? " (เล็กลง " + pct + "%)" : "");
          if (made.length === 1) {
            ctx.done([{ blob: made[0].blob, name: made[0].name, icon: "image", thumb: made[0].canvas.toDataURL("image/jpeg", 0.4) }], stat);
            return;
          }
          ctx.progress(0.95, "กำลังบีบเป็น ZIP...");
          const JSZip = await PT.libs.jszip();
          const zip = new JSZip();
          made.forEach((m) => zip.file(m.name, m.blob));
          const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
          ctx.done([{ blob, name: "รูปภาพ-ลดขนาด.zip", icon: "zip", note: made.length + " ไฟล์" }], stat);
        },
      }));
    },
  });
})();
