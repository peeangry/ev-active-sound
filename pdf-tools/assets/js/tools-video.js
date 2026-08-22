/* ============================================================
   PDF Toolbox - video tools
   Compression uses WebCodecs (H.264 + AAC into an MP4 built by
   mp4-muxer) when the browser supports it, and falls back to
   MediaRecorder (WebM/MP4 depending on the browser) otherwise.
   Everything still happens locally - no upload.
   ============================================================ */
(function () {
  "use strict";
  const PT = window.PT;
  const el = PT.el;
  const ui = PT.ui;

  const QUALITY_BPP = { high: 0.115, medium: 0.07, eco: 0.045, tiny: 0.028 };

  function evenly(n) { return Math.max(2, Math.round(n / 2) * 2); }

  function targetSize(srcW, srcH, preset) {
    if (preset === "same" || !preset) return { w: evenly(srcW), h: evenly(srcH) };
    const cap = parseInt(preset, 10);
    const longSide = Math.max(srcW, srcH), shortSide = Math.min(srcW, srcH);
    if (shortSide <= cap) return { w: evenly(srcW), h: evenly(srcH) };
    const scale = cap / shortSide;
    return { w: evenly(srcW * scale), h: evenly(srcH * scale) };
  }

  function bitrateFor(w, h, fps, quality) {
    const bpp = QUALITY_BPP[quality] || QUALITY_BPP.medium;
    return Math.max(180000, Math.round(w * h * fps * bpp));
  }

  function loadVideo(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.src = URL.createObjectURL(file);
      video.onloadedmetadata = () => resolve(video);
      video.onerror = () => reject(new Error("เปิดไฟล์วิดีโอนี้ไม่ได้ (เบราว์เซอร์ไม่รองรับรูปแบบนี้)"));
    });
  }

  function seek(video, t) {
    return new Promise((resolve) => {
      const done = () => { video.removeEventListener("seeked", done); resolve(); };
      video.addEventListener("seeked", done);
      video.currentTime = Math.max(0, t);
    });
  }

  async function pickAvcCodec(w, h, bitrate, fps) {
    if (!window.VideoEncoder) return null;
    const candidates = ["avc1.42002A", "avc1.4D402A", "avc1.640028", "avc1.42E01E"];
    for (const codec of candidates) {
      try {
        const res = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps });
        if (res && res.supported) return codec;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  /* ---------- audio: decode the source track once, re-encode as AAC ---------- */
  async function decodeAudio(file) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    try {
      const buf = await file.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      return decoded;
    } catch (e) {
      return null;
    } finally {
      try { ctx.close(); } catch (e) {}
    }
  }

  async function encodeAudioInto(muxer, decoded, start, end, channels, onProgress) {
    const sampleRate = decoded.sampleRate;
    const from = Math.floor(start * sampleRate);
    const to = Math.min(decoded.length, Math.ceil(end * sampleRate));
    const planes = [];
    for (let ch = 0; ch < channels; ch++) planes.push(decoded.getChannelData(Math.min(ch, decoded.numberOfChannels - 1)));

    let err = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { err = e; },
    });
    enc.configure({ codec: "mp4a.40.2", sampleRate: sampleRate, numberOfChannels: channels, bitrate: 128000 });

    const BLOCK = 1024;
    for (let pos = from; pos < to; pos += BLOCK) {
      const n = Math.min(BLOCK, to - pos);
      const data = new Float32Array(n * channels);
      for (let ch = 0; ch < channels; ch++) data.set(planes[ch].subarray(pos, pos + n), ch * n);
      const ad = new AudioData({
        format: "f32-planar", sampleRate: sampleRate, numberOfFrames: n,
        numberOfChannels: channels, timestamp: Math.round(((pos - from) / sampleRate) * 1e6), data: data,
      });
      enc.encode(ad);
      ad.close();
      if (enc.encodeQueueSize > 40) await PT.sleep(4);
      if (onProgress && (pos - from) % (BLOCK * 200) === 0) onProgress((pos - from) / Math.max(1, to - from));
    }
    await enc.flush();
    enc.close();
    if (err) throw err;
  }

  /* ---------- main encoder: WebCodecs ---------- */
  async function encodeWebCodecs(file, video, opts, onProgress) {
    const Mp4Muxer = await PT.libs.mp4muxer();
    const { w, h } = opts.size;
    const codec = await pickAvcCodec(w, h, opts.bitrate, opts.fps);
    if (!codec) return null;

    let decodedAudio = null, audioChannels = 0;
    if (opts.keepAudio) {
      onProgress(0.02, "กำลังอ่านเสียง...");
      decodedAudio = await decodeAudio(file);
      if (decodedAudio && window.AudioEncoder) {
        audioChannels = Math.min(2, decodedAudio.numberOfChannels);
        try {
          const ok = await AudioEncoder.isConfigSupported({
            codec: "mp4a.40.2", sampleRate: decodedAudio.sampleRate, numberOfChannels: audioChannels, bitrate: 128000,
          });
          if (!ok || !ok.supported) decodedAudio = null;
        } catch (e) { decodedAudio = null; }
      } else decodedAudio = null;
    }

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width: w, height: h },
      audio: decodedAudio ? { codec: "aac", numberOfChannels: audioChannels, sampleRate: decodedAudio.sampleRate } : undefined,
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
    });

    let encError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encError = e; },
    });
    encoder.configure({ codec: codec, width: w, height: h, bitrate: opts.bitrate, framerate: opts.fps, latencyMode: "quality" });

    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const cctx = canvas.getContext("2d", { alpha: false });

    const start = opts.start, end = opts.end;
    const minDelta = opts.fpsCap ? 1 / opts.fpsCap : 0;
    video.muted = true;
    await seek(video, start);
    video.playbackRate = opts.fast ? 2 : 1;

    let frames = 0, lastT = -1;
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try { video.pause(); } catch (e) {}
        resolve();
      };

      const onFrame = async (now, meta) => {
        if (finished) return;
        const t = meta && typeof meta.mediaTime === "number" ? meta.mediaTime : video.currentTime;
        if (t >= end - 0.002) return finish();
        if (t + 1e-4 < start || (minDelta && lastT >= 0 && t - lastT < minDelta * 0.95)) {
          video.requestVideoFrameCallback(onFrame);
          return;
        }
        try {
          cctx.drawImage(video, 0, 0, w, h);
          const frame = new VideoFrame(canvas, {
            timestamp: Math.max(0, Math.round((t - start) * 1e6)),
            duration: Math.round(1e6 / opts.fps),
          });
          encoder.encode(frame, { keyFrame: frames % Math.max(1, Math.round(opts.fps * 2)) === 0 });
          frame.close();
        } catch (e) {
          finished = true;
          reject(e);
          return;
        }
        frames++;
        lastT = t;
        onProgress(0.05 + 0.8 * ((t - start) / Math.max(0.001, end - start)), "กำลังบีบอัดวิดีโอ " + PT.fmtTime(t - start) + " / " + PT.fmtTime(end - start));
        if (encoder.encodeQueueSize > 12) {
          try { video.pause(); } catch (e) {}
          while (encoder.encodeQueueSize > 4 && !finished) await PT.sleep(12);
          if (!finished) { try { await video.play(); } catch (e) {} }
        }
        if (!finished) video.requestVideoFrameCallback(onFrame);
      };

      video.addEventListener("ended", finish);
      video.requestVideoFrameCallback(onFrame);
      video.play().catch(reject);
    });

    if (encError) throw encError;
    onProgress(0.88, "กำลังปิดไฟล์วิดีโอ...");
    await encoder.flush();
    encoder.close();
    if (encError) throw encError;
    if (!frames) throw new Error("อ่านเฟรมวิดีโอไม่ได้เลย ลองใช้ไฟล์อื่นหรือเบราว์เซอร์อื่น");

    if (decodedAudio) {
      onProgress(0.9, "กำลังบีบอัดเสียง...");
      try {
        await encodeAudioInto(muxer, decodedAudio, start, end, audioChannels, (p) => onProgress(0.9 + 0.06 * p, "กำลังบีบอัดเสียง..."));
      } catch (e) {
        console.warn("audio encode failed", e);
      }
    }

    onProgress(0.97, "กำลังรวมไฟล์ MP4...");
    muxer.finalize();
    return {
      blob: new Blob([muxer.target.buffer], { type: "video/mp4" }),
      ext: "mp4",
      frames: frames,
      audio: !!decodedAudio,
      engine: "WebCodecs H.264",
    };
  }

  /* ---------- fallback encoder: MediaRecorder ---------- */
  function pickRecorderMime() {
    const list = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return null;
  }

  async function encodeMediaRecorder(file, video, opts, onProgress) {
    const mime = pickRecorderMime();
    if (!mime) throw new Error("เบราว์เซอร์นี้ไม่รองรับการบีบอัดวิดีโอ ลองใช้ Chrome หรือ Edge รุ่นใหม่");
    const { w, h } = opts.size;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const cctx = canvas.getContext("2d", { alpha: false });
    const stream = canvas.captureStream(opts.fps);

    let audioCtx = null;
    if (opts.keepAudio) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        const srcNode = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        srcNode.connect(dest);           // not connected to speakers: silent while encoding
        dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
        video.muted = false;
      } catch (e) { /* keep going without sound */ }
    }

    const hasAudioTrack = stream.getAudioTracks().length > 0;
    const chunks = [];
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: opts.bitrate,
      audioBitsPerSecond: 128000,
    });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    await seek(video, opts.start);
    video.playbackRate = 1;
    const stopped = new Promise((res) => (rec.onstop = res));
    rec.start(1000);
    await video.play();

    const useRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
    let timer = null;
    const drawOnce = () => cctx.drawImage(video, 0, 0, w, h);
    if (useRVFC) {
      const tick = () => {
        if (video.paused || video.ended) return;
        drawOnce();
        video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
    } else {
      timer = setInterval(() => { if (!video.paused && !video.ended) drawOnce(); }, 1000 / opts.fps);
    }

    await new Promise((resolve) => {
      const check = () => {
        const t = video.currentTime;
        onProgress(0.05 + 0.85 * ((t - opts.start) / Math.max(0.001, opts.end - opts.start)),
          "กำลังบีบอัด (โหมดเรียลไทม์) " + PT.fmtTime(t - opts.start) + " / " + PT.fmtTime(opts.end - opts.start));
        if (t >= opts.end - 0.05 || video.ended) {
          video.removeEventListener("timeupdate", check);
          resolve();
        }
      };
      video.addEventListener("timeupdate", check);
      video.addEventListener("ended", () => { video.removeEventListener("timeupdate", check); resolve(); });
    });

    video.pause();
    if (timer) clearInterval(timer);
    onProgress(0.94, "กำลังปิดไฟล์...");
    rec.stop();
    await stopped;
    if (audioCtx) { try { await audioCtx.close(); } catch (e) {} }
    const type = mime.split(";")[0];
    return {
      blob: new Blob(chunks, { type: type }),
      ext: type.indexOf("mp4") >= 0 ? "mp4" : "webm",
      frames: 0,
      audio: hasAudioTrack,
      engine: "MediaRecorder",
    };
  }

  /* =========================================================
     ลดขนาดวิดีโอ
     ========================================================= */
  PT.registerTool({
    id: "video-compress", group: "video", icon: "video", color: "green", short: "ลดขนาดวิดีโอ",
    title: "ลดขนาดวิดีโอ",
    desc: "ย่อความละเอียดและบีบอัดวิดีโอให้ส่งไลน์/อัปโหลดได้ง่าย",
    long: "บีบอัดวิดีโอในเครื่องคุณเอง เลือกความละเอียด คุณภาพ เฟรมเรต ตัดช่วงที่ต้องการ และเลือกเก็บหรือตัดเสียงได้",
    build(root) {
      let video = null, srcFile = null, duration = 0, srcW = 0, srcH = 0;

      const preview = el("video", { class: "hidden", controls: true, playsinline: true, muted: true, style: { width: "100%", borderRadius: "16px", marginTop: "14px", background: "#000" } });
      const info = el("div", { class: "desc" });

      const picker = ui.picker({
        accept: "video/*", multiple: false, fileIcon: "video",
        title: "เลือกไฟล์วิดีโอ", hint: "รองรับ MP4, MOV, WebM ฯลฯ (ตามที่เบราว์เซอร์เปิดได้)",
        onChange: async (files) => {
          if (!files.length) return;
          try {
            srcFile = files[0];
            if (video) URL.revokeObjectURL(video.src);
            video = await loadVideo(srcFile);
            duration = video.duration && isFinite(video.duration) ? video.duration : 0;
            srcW = video.videoWidth; srcH = video.videoHeight;
            preview.src = video.src;
            preview.classList.remove("hidden");
            info.textContent = srcW + "×" + srcH + " • " + PT.fmtTime(duration) + " นาที • " + PT.fmtBytes(srcFile.size);
            // raise the slider ceilings before assigning values, otherwise a clip
            // longer than the default max would be clamped to it
            const cap = Math.max(1, Math.ceil(duration));
            trimStart.querySelector("input").max = cap;
            trimEnd.querySelector("input").max = cap;
            trimStart.value = 0;
            trimEnd.value = cap;
            trimStart.classList.remove("hidden");
            trimEnd.classList.remove("hidden");
            updateEstimate();
          } catch (e) { PT.toast(e.message, "err"); }
        },
      });
      root.appendChild(picker);
      root.appendChild(preview);
      root.appendChild(info);

      const res = ui.chips("ความละเอียด", [
        { v: "same", l: "คงเดิม" }, { v: "1080", l: "1080p" }, { v: "720", l: "720p (แนะนำ)" },
        { v: "480", l: "480p" }, { v: "360", l: "360p" },
      ], "720", () => updateEstimate());
      const quality = ui.chips("คุณภาพ", [
        { v: "high", l: "สูง" }, { v: "medium", l: "กลาง (แนะนำ)" }, { v: "eco", l: "ประหยัด" }, { v: "tiny", l: "เล็กที่สุด" },
      ], "medium", () => updateEstimate());
      const fps = ui.chips("เฟรมเรต", [
        { v: "0", l: "คงเดิม" }, { v: "30", l: "30 fps" }, { v: "24", l: "24 fps" }, { v: "15", l: "15 fps" },
      ], "30", () => updateEstimate());
      const keepAudio = ui.toggle("เก็บเสียง", "ปิดเพื่อตัดเสียงออกและลดขนาดอีก", true, () => updateEstimate());
      const fast = ui.toggle("ประมวลผลเร็ว", "เล่นไฟล์เร็ว 2 เท่าระหว่างบีบอัด (อาจข้ามบางเฟรม)", true);
      const trimStart = ui.slider("ตัดตั้งแต่วินาทีที่", { min: 0, max: 100, step: 1, value: 0, format: (v) => PT.fmtTime(v), onChange: () => updateEstimate() });
      const trimEnd = ui.slider("ถึงวินาทีที่", { min: 0, max: 100, step: 1, value: 100, format: (v) => PT.fmtTime(v), onChange: () => updateEstimate() });
      [res, quality, fps, trimStart, trimEnd, keepAudio, fast].forEach((n) => root.appendChild(n));
      // the trim range only makes sense once we know how long the clip is
      trimStart.classList.add("hidden");
      trimEnd.classList.add("hidden");

      const estimate = el("div", { class: "note" }, [PT.iconEl("sparkles"), el("div", { text: "เลือกไฟล์เพื่อดูขนาดโดยประมาณ" })]);
      root.appendChild(estimate);

      function currentPlan() {
        const size = targetSize(srcW || 1280, srcH || 720, res.value);
        const outFps = parseInt(fps.value, 10) || 30;
        const start = Math.min(trimStart.value, trimEnd.value);
        const end = Math.max(trimStart.value + 0.5, trimEnd.value);
        return {
          size: size, fps: outFps, fpsCap: parseInt(fps.value, 10) || 0,
          bitrate: bitrateFor(size.w, size.h, outFps, quality.value),
          start: start, end: Math.min(end, duration || end),
          keepAudio: keepAudio.value, fast: fast.value,
        };
      }

      function updateEstimate() {
        if (!srcFile) return;
        const plan = currentPlan();
        const secs = Math.max(0.5, plan.end - plan.start);
        const bytes = ((plan.bitrate + (plan.keepAudio ? 128000 : 0)) / 8) * secs;
        const pct = srcFile.size ? Math.round((1 - bytes / srcFile.size) * 100) : 0;
        estimate.lastChild.textContent =
          "ผลลัพธ์โดยประมาณ " + plan.size.w + "×" + plan.size.h + " • " + PT.fmtTime(secs) + " นาที • ราว " + PT.fmtBytes(bytes) +
          (pct > 0 ? " (เล็กลงราว " + pct + "%)" : " (อาจไม่เล็กลง ลองลดความละเอียดหรือคุณภาพ)");
      }

      root.appendChild(ui.runner({
        label: "ลดขนาดวิดีโอ", icon: "video", toolId: "video-compress",
        onRun: async (ctx) => {
          if (!srcFile || !video) throw new Error("ยังไม่ได้เลือกไฟล์วิดีโอ");
          const plan = currentPlan();
          if (plan.end - plan.start < 0.4) throw new Error("ช่วงเวลาที่เลือกสั้นเกินไป");
          preview.pause();

          // a clean element for encoding, so the on-screen preview keeps working
          const work = await loadVideo(srcFile);
          let out = null;
          const report = (p, m) => ctx.progress(Math.min(0.99, p), m);
          try {
            if (window.VideoEncoder && "requestVideoFrameCallback" in HTMLVideoElement.prototype) {
              out = await encodeWebCodecs(srcFile, work, plan, report);
              // a suspiciously tiny file means the encoder produced nothing usable
              if (out && (!out.blob || out.blob.size < 1024)) out = null;
            }
          } catch (e) {
            console.warn("WebCodecs path failed, falling back", e);
            out = null;
          }
          if (!out) {
            PT.toast("ใช้โหมดสำรอง (เรียลไทม์) สำหรับเบราว์เซอร์นี้");
            const work2 = await loadVideo(srcFile);
            out = await encodeMediaRecorder(srcFile, work2, plan, report);
            URL.revokeObjectURL(work2.src);
          }
          URL.revokeObjectURL(work.src);

          const pct = Math.round((1 - out.blob.size / srcFile.size) * 100);
          const name = PT.safeName(PT.baseName(srcFile.name)) + "-ลดขนาด." + out.ext;
          ctx.done(
            [{ blob: out.blob, name: name, icon: "video", note: plan.size.w + "×" + plan.size.h + (out.audio ? " • มีเสียง" : " • ไม่มีเสียง") }],
            PT.fmtBytes(srcFile.size) + " → " + PT.fmtBytes(out.blob.size) +
              (pct > 0 ? " (เล็กลง " + pct + "%)" : " (ใหญ่ขึ้น " + Math.abs(pct) + "% — ลองลดคุณภาพลง)") +
              " • เอนจิน " + out.engine
          );
        },
      }));

      root.appendChild(ui.note("วิดีโอยาวใช้เวลาประมวลผลนาน ระหว่างนี้อย่าปิดหน้าจอหรือสลับแอป เพราะเบราว์เซอร์จะหยุดทำงานเบื้องหลัง"));
    },
  });

  /* =========================================================
     แคปภาพจากวิดีโอ
     ========================================================= */
  PT.registerTool({
    id: "video-frames", group: "video", icon: "camera", color: "teal", short: "แคปภาพวิดีโอ",
    title: "แคปภาพจากวิดีโอ",
    desc: "ดึงภาพนิ่งจากวิดีโอตามช่วงเวลาที่กำหนด",
    long: "ดึงภาพนิ่งจากวิดีโอ เลือกได้ทั้งแบบทุก ๆ กี่วินาที หรือระบุวินาทีที่ต้องการ",
    build(root) {
      let video = null, srcFile = null, duration = 0;
      const info = el("div", { class: "desc" });
      const picker = ui.picker({
        accept: "video/*", multiple: false, fileIcon: "video",
        onChange: async (files) => {
          if (!files.length) return;
          try {
            srcFile = files[0];
            video = await loadVideo(srcFile);
            duration = video.duration || 0;
            info.textContent = video.videoWidth + "×" + video.videoHeight + " • ยาว " + PT.fmtTime(duration) + " นาที";
          } catch (e) { PT.toast(e.message, "err"); }
        },
      });
      root.appendChild(picker);
      root.appendChild(info);

      const mode = ui.chips("รูปแบบ", [
        { v: "every", l: "ทุก ๆ กี่วินาที" }, { v: "list", l: "ระบุวินาที" },
      ], "every", () => { every.classList.toggle("hidden", mode.value !== "every"); list.classList.toggle("hidden", mode.value !== "list"); });
      const every = ui.slider("จับภาพทุก ๆ", { min: 1, max: 60, step: 1, value: 5, format: (v) => v + " วินาที" });
      const list = ui.textInput("วินาทีที่ต้องการ", { placeholder: "เช่น 0, 12, 35.5", value: "0" });
      list.classList.add("hidden");
      const fmt = ui.chips("ไฟล์ภาพ", [{ v: "image/jpeg", l: "JPG" }, { v: "image/png", l: "PNG" }], "image/jpeg");
      const width = ui.chips("ความกว้างภาพ", [
        { v: "0", l: "เท่าต้นฉบับ" }, { v: "1280", l: "1280 px" }, { v: "720", l: "720 px" },
      ], "0");
      [mode, every, list, fmt, width].forEach((n) => root.appendChild(n));

      root.appendChild(ui.runner({
        label: "แคปภาพ", icon: "camera", toolId: "video-frames",
        onRun: async (ctx) => {
          if (!srcFile || !video) throw new Error("ยังไม่ได้เลือกไฟล์วิดีโอ");
          const times = [];
          if (mode.value === "every") {
            for (let t = 0; t < duration; t += every.value) times.push(t);
          } else {
            list.value.split(/[,\s]+/).forEach((s) => {
              const v = parseFloat(s);
              if (isFinite(v) && v >= 0 && v <= duration) times.push(v);
            });
          }
          if (!times.length) throw new Error("ไม่มีเวลาที่จะจับภาพ");
          if (times.length > 200) throw new Error("จับภาพได้สูงสุด 200 ภาพต่อครั้ง ลองเพิ่มระยะเวลา");

          const work = await loadVideo(srcFile);
          const capW = parseInt(width.value, 10) || work.videoWidth;
          const scale = capW / work.videoWidth;
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(work.videoWidth * scale);
          canvas.height = Math.round(work.videoHeight * scale);
          const c = canvas.getContext("2d", { alpha: false });
          const ext = fmt.value === "image/png" ? "png" : "jpg";
          const base = PT.safeName(PT.baseName(srcFile.name));
          const made = [];
          for (let i = 0; i < times.length; i++) {
            ctx.progress(i / times.length, "กำลังจับภาพวินาทีที่ " + Math.round(times[i]));
            await seek(work, times[i]);
            c.drawImage(work, 0, 0, canvas.width, canvas.height);
            made.push({ name: base + "-" + String(Math.round(times[i])).padStart(4, "0") + "s." + ext, blob: await PT.canvasToBlob(canvas, fmt.value, 0.9) });
          }
          URL.revokeObjectURL(work.src);

          if (made.length === 1) { ctx.done([{ blob: made[0].blob, name: made[0].name, icon: "image" }]); return; }
          ctx.progress(0.95, "กำลังบีบเป็น ZIP...");
          const JSZip = await PT.libs.jszip();
          const zip = new JSZip();
          made.forEach((m) => zip.file(m.name, m.blob));
          const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
          ctx.done([{ blob, name: base + "-ภาพนิ่ง.zip", icon: "zip", note: made.length + " ภาพ" }]);
        },
      }));
    },
  });
})();
