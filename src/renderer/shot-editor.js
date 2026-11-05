/**
 * shot-editor.js
 * Screenshot editor opened from the viewer: crop, rotate, flip, a brush and brightness /
 * contrast / saturation. The picture is held as two canvases of the same size: `base` (the
 * screenshot itself) and `ink` (brush strokes). Crop / rotate / flip change both; the sliders
 * are a CSS filter applied to `base` only, so the brush keeps its color. Export draws both.
 * The image comes from the main process as a data: URL — a file: image would taint the canvas.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const MAX_HISTORY = 30;
  const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000'];

  let api, t, toast, onSaved, ask;
  let shot = null;          // { path, name }
  let base = null, ink = null;
  let adjust = { brightness: 100, contrast: 100, saturate: 100 };
  let history = [];
  let tool = 'brush';       // 'brush' | 'crop'
  let color = COLORS[0];
  let size = 8;
  let view = { scale: 1, x: 0, y: 0 }; // where the picture sits on the screen canvas
  let drag = null;          // current pointer gesture
  let crop = null;          // { x, y, w, h } in picture pixels
  let dirty = false;

  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function clone(c) {
    const copy = canvasOf(c.width, c.height);
    copy.getContext('2d').drawImage(c, 0, 0);
    return copy;
  }

  function filterCss(a = adjust) {
    return `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturate}%)`;
  }

  // ---------- history ----------
  function snapshot() {
    history.push({ base: clone(base), ink: clone(ink), adjust: { ...adjust } });
    if (history.length > MAX_HISTORY) history.shift();
    dirty = true;
    updateButtons();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    base = prev.base;
    ink = prev.ink;
    adjust = prev.adjust;
    crop = null;
    syncSliders();
    updateButtons();
    render();
  }

  // ---------- drawing on screen ----------
  function fit() {
    const canvas = $('editor-canvas');
    const stage = canvas.parentElement.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(stage.width * ratio);
    canvas.height = Math.round(stage.height * ratio);
    canvas.style.width = `${stage.width}px`;
    canvas.style.height = `${stage.height}px`;
    const pad = 24 * ratio;
    const scale = Math.min((canvas.width - pad * 2) / base.width, (canvas.height - pad * 2) / base.height, 4);
    view = {
      scale,
      x: (canvas.width - base.width * scale) / 2,
      y: (canvas.height - base.height * scale) / 2,
      ratio
    };
  }

  function render() {
    if (!base) return;
    fit();
    const canvas = $('editor-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    const w = base.width * view.scale;
    const h = base.height * view.scale;
    ctx.filter = filterCss();
    ctx.drawImage(base, view.x, view.y, w, h);
    ctx.filter = 'none';
    ctx.drawImage(ink, view.x, view.y, w, h);

    if (crop && crop.w > 0 && crop.h > 0) {
      const cx = view.x + crop.x * view.scale;
      const cy = view.y + crop.y * view.scale;
      const cw = crop.w * view.scale;
      const ch = crop.h * view.scale;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath();
      ctx.rect(view.x, view.y, w, h);
      ctx.rect(cx, cy, cw, ch);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * view.ratio;
      ctx.strokeRect(cx, cy, cw, ch);
      // rule-of-thirds guides
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1 * view.ratio;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(cx + (cw * i) / 3, cy);
        ctx.lineTo(cx + (cw * i) / 3, cy + ch);
        ctx.moveTo(cx, cy + (ch * i) / 3);
        ctx.lineTo(cx + cw, cy + (ch * i) / 3);
      }
      ctx.stroke();
    }
    $('editor-size').textContent = crop && crop.w > 0
      ? `${Math.round(crop.w)} × ${Math.round(crop.h)}`
      : `${base.width} × ${base.height}`;
  }

  /** Screen point -> picture pixel. */
  function toPicture(e) {
    const rect = $('editor-canvas').getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * view.ratio - view.x) / view.scale,
      y: ((e.clientY - rect.top) * view.ratio - view.y) / view.scale
    };
  }

  const clampX = (v) => Math.max(0, Math.min(base.width, v));
  const clampY = (v) => Math.max(0, Math.min(base.height, v));

  // ---------- pointer ----------
  function onDown(e) {
    if (!base || e.button !== 0) return;
    const p = toPicture(e);
    $('editor-canvas').setPointerCapture(e.pointerId);
    if (tool === 'brush') {
      snapshot();
      const ctx = ink.getContext('2d');
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // brush size is in screen pixels, so it looks the same at any zoom
      ctx.lineWidth = (size * view.ratio) / view.scale;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      drag = { type: 'brush' };
    } else {
      const sx = clampX(p.x), sy = clampY(p.y);
      drag = { type: 'crop', sx, sy };
      crop = { x: sx, y: sy, w: 0, h: 0 };
    }
    render();
  }

  function onMove(e) {
    if (!drag) return;
    const p = toPicture(e);
    if (drag.type === 'brush') {
      const ctx = ink.getContext('2d');
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    } else {
      const x = clampX(p.x), y = clampY(p.y);
      crop = { x: Math.min(drag.sx, x), y: Math.min(drag.sy, y), w: Math.abs(x - drag.sx), h: Math.abs(y - drag.sy) };
      updateButtons();
    }
    render();
  }

  function onUp() {
    if (drag && drag.type === 'crop' && crop && (crop.w < 4 || crop.h < 4)) crop = null;
    drag = null;
    updateButtons();
    render();
  }

  // ---------- transforms ----------
  function transform(w, h, draw) {
    const apply = (src) => {
      const out = canvasOf(w, h);
      const ctx = out.getContext('2d');
      draw(ctx, src);
      return out;
    };
    snapshot();
    base = apply(base);
    ink = apply(ink);
    crop = null;
    render();
  }

  function rotate(dir) {
    const w = base.width, h = base.height;
    transform(h, w, (ctx, src) => {
      ctx.translate(h / 2, w / 2);
      ctx.rotate((dir * Math.PI) / 2);
      ctx.drawImage(src, -w / 2, -h / 2);
    });
  }

  function flip() {
    const w = base.width, h = base.height;
    transform(w, h, (ctx, src) => {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, 0, 0);
    });
  }

  function applyCrop() {
    if (!crop || crop.w < 4 || crop.h < 4) return;
    const c = { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h) };
    transform(c.w, c.h, (ctx, src) => ctx.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h));
    setTool('brush');
  }

  // ---------- export ----------
  function exportPng() {
    const out = canvasOf(base.width, base.height);
    const ctx = out.getContext('2d');
    ctx.filter = filterCss();
    ctx.drawImage(base, 0, 0);
    ctx.filter = 'none';
    ctx.drawImage(ink, 0, 0);
    return out.toDataURL('image/png');
  }

  async function save(mode) {
    if (!base) return;
    try {
      const file = await api.saveScreenshot(shot.path, exportPng(), mode);
      dirty = false;
      toast(mode === 'replace' ? t('Скриншот сохранён, оригинал — в корзине') : t('Сохранено копией: {name}', { name: file.split(/[\\/]/).pop() }));
      close(true);
      if (onSaved) onSaved(file);
    } catch (e) {
      toast(t('Не удалось сохранить: {error}', { error: (e && e.message || String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }), 'error');
    }
  }

  async function copy() {
    try {
      await api.copyImageData(exportPng());
      toast(t('Картинка скопирована'));
    } catch (e) {
      toast(t('Не удалось скопировать: {error}', { error: e.message }), 'error');
    }
  }

  // ---------- UI ----------
  function setTool(name) {
    tool = name;
    if (name !== 'crop') crop = null;
    document.querySelectorAll('#editor [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
    $('editor-brush-opts').classList.toggle('hidden', name !== 'brush');
    $('editor-crop-opts').classList.toggle('hidden', name !== 'crop');
    $('editor-canvas').style.cursor = 'crosshair';
    updateButtons();
    render();
  }

  function syncSliders() {
    for (const k of Object.keys(adjust)) {
      $(`editor-${k}`).value = adjust[k];
      $(`editor-${k}-val`).textContent = `${adjust[k] - 100 > 0 ? '+' : ''}${adjust[k] - 100}`;
    }
  }

  function updateButtons() {
    $('editor-undo').disabled = !history.length;
    $('editor-crop-apply').disabled = !(crop && crop.w >= 4 && crop.h >= 4);
  }

  function isOpen() {
    return !$('editor').classList.contains('hidden');
  }

  async function open(target) {
    shot = target;
    $('editor-name').textContent = target.name;
    $('editor').classList.remove('hidden');
    base = null;
    let dataUrl;
    try {
      dataUrl = await api.readScreenshot(target.path);
    } catch (e) {
      toast(t('Не удалось открыть картинку'), 'error');
      return close(true);
    }
    const img = new Image();
    img.onload = () => {
      base = canvasOf(img.naturalWidth, img.naturalHeight);
      base.getContext('2d').drawImage(img, 0, 0);
      ink = canvasOf(base.width, base.height);
      adjust = { brightness: 100, contrast: 100, saturate: 100 };
      history = [];
      crop = null;
      dirty = false;
      syncSliders();
      setTool('brush');
    };
    img.src = dataUrl;
  }

  async function close(force) {
    if (!force && dirty && !(await ask())) return;
    $('editor').classList.add('hidden');
    base = ink = null;
    history = [];
  }

  function setup(deps) {
    ({ api, t, toast, onSaved, ask } = deps);
    const canvas = $('editor-canvas');
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    document.querySelectorAll('#editor [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('editor-rotate-left').addEventListener('click', () => rotate(-1));
    $('editor-rotate-right').addEventListener('click', () => rotate(1));
    $('editor-flip').addEventListener('click', flip);
    $('editor-undo').addEventListener('click', undo);
    $('editor-crop-apply').addEventListener('click', applyCrop);
    $('editor-crop-cancel').addEventListener('click', () => { crop = null; updateButtons(); render(); });
    $('editor-copy').addEventListener('click', copy);
    $('editor-save-copy').addEventListener('click', () => save('copy'));
    $('editor-save-replace').addEventListener('click', () => save('replace'));
    $('editor-close').addEventListener('click', () => close(false));

    const colors = $('editor-colors');
    COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = `editor-color ${i === 0 ? 'active' : ''}`;
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        color = c;
        colors.querySelectorAll('.editor-color').forEach(x => x.classList.toggle('active', x === b));
      });
      colors.appendChild(b);
    });
    $('editor-brush-size').addEventListener('input', (e) => { size = +e.target.value; });

    for (const k of Object.keys(adjust)) {
      const input = $(`editor-${k}`);
      // one undo step per slider drag, not per pixel of movement
      input.addEventListener('pointerdown', () => snapshot());
      input.addEventListener('keydown', () => snapshot());
      input.addEventListener('input', () => {
        adjust[k] = +input.value;
        syncSliders();
        render();
      });
      input.addEventListener('dblclick', () => {
        snapshot();
        adjust[k] = 100;
        syncSliders();
        render();
      });
    }

    window.addEventListener('resize', () => { if (isOpen()) render(); });
    document.addEventListener('keydown', (e) => {
      if (!isOpen() || !$('modal-dialog').classList.contains('hidden')) return;
      e.stopImmediatePropagation(); // the viewer under the editor must not react
      if (e.key === 'Escape') close(false);
      else if (e.key === 'z' && e.ctrlKey) undo();
      else if (e.key === 's' && e.ctrlKey) save('copy');
      else if (e.key === 'c' && e.ctrlKey) copy();
      else if (e.key === 'Enter' && tool === 'crop') applyCrop();
      else if (e.key === 'b') setTool('brush');
      else if (e.key === 'r' && !e.ctrlKey) setTool('crop');
    }, true);
  }

  window.shotEditor = { setup, open, isOpen };
})();
