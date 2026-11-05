/**
 * gamepad.js
 * Launcher control with a gamepad (Xbox / PlayStation / Steam Deck, the browser's "standard" layout).
 *
 *   D-pad / left stick   move the highlight to the nearest control in that direction
 *   A                    press it (a switch toggles, a list steps to its next option)
 *   B                    back: closes a menu, dialog or viewer, otherwise goes up a page
 *   X                    the "⋯" menu of the highlighted build
 *   LB / RB              previous / next tab of the sidebar
 *   right stick          scroll
 *   ← → on a list change it; a slider changes only after A on it (A or B again: done).
 *   ← with nothing more to the left on the page goes to the sidebar, → from the sidebar comes back.
 *
 * Only the focused window gets gamepad input, so the game in front doesn't drive the launcher.
 * Gamepad mode (the highlight and the hint bar) turns on with the first press and off when the mouse moves.
 */
(function (root) {
  const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const STICK_DEAD = 0.5;      // a stick past this counts as a direction press
  const SCROLL_DEAD = 0.2;
  const SCROLL_SPEED = 1400;   // px per second at full tilt
  const REPEAT_DELAY = 380;    // ms before a held direction repeats
  const REPEAT_EVERY = 110;

  const FOCUSABLE = [
    'button', 'a[href]', 'input', 'select', 'textarea', '[tabindex]:not([tabindex="-1"])',
    '.bcard', '.trow-click', '.account-row', '.sync-check'
  ].join(',');
  const OVERLAYS = '.menu, .modal:not(.hidden), .viewer:not(.hidden), .setup:not(.hidden)';

  const t = (text) => (root.i18n ? root.i18n.t(text) : text);

  function createGamepadNav({ onBack, onTab } = {}) {
    let enabled = true;
    let active = false;         // gamepad mode: highlight shown
    let target = null;          // highlighted element (what's drawn; a switch's label, not its hidden input)
    let rafId = 0;
    let lastTime = 0;
    let prevButtons = null;   // null: take the next poll as the resting state
    let held = null;            // { dir, next } for direction repeat
    const lastInScope = new WeakMap(); // overlay/document -> its last highlighted element
    const hints = document.getElementById('gamepad-hints');

    // ---------- scope and candidates ----------
    function visible(el) {
      if (!el || !el.isConnected) return false;
      if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
      // a card's play button (or a row's buttons) only show on hover: a stop there would look like nowhere.
      // Only the element and its parent are checked, a page fading in is see-through for a moment.
      for (let a = el, i = 0; a && i < 2; a = a.parentElement, i++) {
        if (getComputedStyle(a).opacity === '0') return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    /** The topmost open overlay (menu, dialog, viewer, first-run setup) or the whole page. */
    function scope() {
      let best = null;
      let bestZ = -Infinity;
      document.querySelectorAll(OVERLAYS).forEach(el => {
        if (!visible(el)) return;
        const z = parseInt(getComputedStyle(el).zIndex, 10) || 0;
        if (z >= bestZ) { best = el; bestZ = z; } // equal z: the later one in the document is on top
      });
      return best || document.body;
    }

    /** What the highlight lands on: a hidden checkbox is drawn on its switch, or on its row. */
    function visualOf(el) {
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return el.closest('.switch') || el.closest('label') || el.parentElement;
      }
      return el;
    }

    function candidates(sc) {
      const out = new Set();
      sc.querySelectorAll(FOCUSABLE).forEach(el => {
        if (el.disabled || el.closest('[inert], .hidden, [aria-hidden="true"]')) return;
        if (el.type === 'hidden') return;
        // the window's minimize / maximize / close are for the mouse
        if (el.closest('.titlebar-controls') && !el.classList.contains('titlebar-update')) return;
        const v = visualOf(el);
        if (!visible(v)) return;
        // a button inside a clickable card is its own stop; the card is another
        out.add(v);
      });
      // when the page is the scope, overlays that are open under it (none) and the hint bar don't count
      return [...out].filter(el => !hints || !hints.contains(el));
    }

    /** Where a page starts: Play on the home page, otherwise its first control. */
    function pageStart(list) {
      const page = document.querySelector('.page.active');
      if (!page) return null;
      const play = document.getElementById('btn-launch');
      if (page.contains(play) && list.includes(play)) return play;
      return list.find(el => page.contains(el)) || null;
    }

    function initialTarget(sc, list) {
      const remembered = lastInScope.get(sc);
      if (remembered && list.includes(remembered)) return remembered;
      if (sc === document.body) {
        const start = pageStart(list);
        if (start) return start;
        const tab = document.querySelector('.nav-item.active');
        if (list.includes(tab)) return tab;
      } else {
        const primary = sc.querySelector('.modal-foot .btn-primary:not(:disabled), .modal-foot .btn-danger:not(:disabled)');
        if (list.includes(primary)) return primary;
      }
      return list[0] || null;
    }

    // ---------- highlight ----------
    // The ring is its own layer above everything (dialogs, menus, toasts), moved over the highlighted
    // control each frame. An outline on the control itself gets clipped by its containers and covered
    // by its neighbours.
    const RING_GAP = 3;
    const SLIDER_KNOB = 14; // .range::-webkit-slider-thumb in style.css
    let editing = null; // a slider taken with A: ← → change it
    const ring = document.createElement('div');
    ring.className = 'gp-ring hidden';
    ring.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ring);
    let ringKey = '';
    let ringJump = true; // the first placement appears in place instead of sliding in

    /** The part of the control the ring goes round: a theme's preview, a switch's pill. */
    function ringBox(el) {
      if (el.matches('.theme-swatch')) return el.querySelector('.tsw') || el;
      if (el.matches('.switch')) return el.querySelector('span') || el;
      return el;
    }

    function hideRing() {
      ring.classList.add('hidden');
      ringKey = '';
      ringJump = true;
    }

    function placeRing() {
      if (!active || !target || !target.isConnected) { hideRing(); return; }
      const box = ringBox(target);
      const r = box.getBoundingClientRect();
      // a slider is a thin track with a bigger knob: the ring is tall and wide enough for the knob
      const isRange = box.matches('input[type=range]');
      const padY = RING_GAP + (isRange ? Math.max(0, (SLIDER_KNOB - r.height) / 2) + 3 : 0);
      const padX = RING_GAP + (isRange ? 6 : 0);
      let top = r.top - padY;
      let left = r.left - padX;
      let bottom = r.bottom + padY;
      let right = r.right + padX;
      // a slider taken with A: the ring goes round the knob alone and moves with it
      const knobOnly = isRange && editing === target;
      if (knobOnly) {
        const min = Number(box.min || 0);
        const max = Number(box.max || 100);
        const share = max > min ? (Number(box.value) - min) / (max - min) : 0;
        const cx = r.left + SLIDER_KNOB / 2 + share * (r.width - SLIDER_KNOB);
        const cy = r.top + r.height / 2;
        const half = SLIDER_KNOB / 2 + RING_GAP + 1;
        top = cy - half; bottom = cy + half; left = cx - half; right = cx + half;
      }
      // scrolled partly out of its list: the ring stops at the list's edge
      for (let a = box.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (!/(auto|scroll)/.test(cs.overflowY + cs.overflowX)) continue;
        const c = a.getBoundingClientRect();
        top = Math.max(top, c.top); left = Math.max(left, c.left);
        bottom = Math.min(bottom, c.bottom); right = Math.min(right, c.right);
      }
      if (bottom - top < 6 || right - left < 6) { hideRing(); return; }
      const radius = isRange ? 99 : (parseFloat(getComputedStyle(box).borderTopLeftRadius) || 4);
      const isEditing = editing === target;
      const key = [top, left, bottom, right, radius].map(Math.round).join(',') + (isEditing ? 'e' : '');
      if (key === ringKey && !ring.classList.contains('hidden')) return;
      ringKey = key;
      ring.classList.toggle('gp-ring-jump', ringJump);
      ring.classList.toggle('gp-ring-edit', isEditing);
      ringJump = false;
      ring.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      ring.style.width = `${Math.round(right - left)}px`;
      ring.style.height = `${Math.round(bottom - top)}px`;
      ring.style.borderRadius = `${Math.round(Math.min(radius + RING_GAP, (bottom - top) / 2))}px`;
      ring.classList.remove('hidden');
    }

    function setTarget(el, { scroll = true } = {}) {
      if (target && target !== el) target.classList.remove('gp-focus');
      if (editing && editing !== el) setEditing(null);
      target = el;
      if (!el) { hideRing(); return; }
      el.classList.add('gp-focus');
      const sc = scope();
      lastInScope.set(sc, el);
      if (sc === document.body && !inSidebar(el)) lastMain = el;
      // The highlight is drawn by the class alone. Real focus would leave the browser's focus ring
      // behind after the mouse takes over, so only a text field that A opened holds it, until we move on.
      leaveField(el);
      updateHints();
      if (scroll) // instant: a smooth scroll would still be moving things when the next press measures them
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      placeRing();
    }

    function leaveField(next) {
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== next && !(next && next.contains(ae))) ae.blur();
    }

    /** X is shown only where it does something: on a build with a "⋯" menu. */
    function menuButton() {
      if (!target) return null;
      const owner = target.closest('.bcard, .trow, .rcard') || target;
      return owner.querySelector('[data-act="menu"]');
    }

    /** Takes a slider (← → change it) or lets it go. */
    function setEditing(el) {
      if (editing) editing.classList.remove('gp-editing');
      editing = el;
      if (el) el.classList.add('gp-editing'); // the knob takes the ring's color (style.css)
      updateHints();
      placeRing();
    }

    function updateHints() {
      if (!hints) return;
      const a = hints.querySelector('[data-hint="a"] span');
      if (a) a.textContent = editing ? t('Готово') : t('Выбрать');
      const adj = hints.querySelector('[data-hint="adjust"]');
      if (adj) adj.classList.toggle('hidden', !editing);
      const x = hints.querySelector('[data-hint="x"]');
      if (x) x.classList.toggle('hidden', !menuButton());
    }

    function setActive(on) {
      if (active === on) return;
      active = on;
      document.body.classList.toggle('gp-mode', on);
      if (hints) hints.classList.toggle('hidden', !on);
      if (!on && target) {
        target.classList.remove('gp-focus');
        target = null;
      }
      if (!on && editing) setEditing(null);
      if (!on) hideRing();
      // focus a gamepad press left on a button (a dialog's own autofocus, a clicked tab) would keep a ring
      if (!on) {
        const ae = document.activeElement;
        if (ae && ae !== document.body && !ae.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select')) ae.blur();
      }
    }

    /** Keeps the highlight on something that exists and is in the topmost overlay. */
    function ensureTarget() {
      const sc = scope();
      if (target && sc.contains(target) && visible(target)) return true;
      const list = candidates(sc);
      setTarget(initialTarget(sc, list));
      return !!target;
    }

    // ---------- moving ----------
    const sidebar = () => document.querySelector('.sidebar');
    const inSidebar = (el) => { const sb = sidebar(); return !!(sb && sb.contains(el)); };
    let lastMain = null; // the last highlighted control on the page, for → back from the sidebar

    /** The best of `list` in that direction from the highlight, or null. rowOnly: only ones level with it. */
    function pick(list, dir, rowOnly = false) {
      const from = target.getBoundingClientRect();
      const fx = from.left + from.width / 2;
      const fy = from.top + from.height / 2;
      const horizontal = dir === 'left' || dir === 'right';
      const found = [];
      for (const el of list) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        let primary, overlap, cross;
        if (horizontal) {
          if (dir === 'right' ? cx <= fx + 1 : cx >= fx - 1) continue;
          primary = dir === 'right' ? Math.max(0, r.left - from.right) : Math.max(0, from.left - r.right);
          overlap = Math.min(r.bottom, from.bottom) - Math.max(r.top, from.top);
          cross = Math.abs(cy - fy);
        } else {
          if (dir === 'down' ? cy <= fy + 1 : cy >= fy - 1) continue;
          primary = dir === 'down' ? Math.max(0, r.top - from.bottom) : Math.max(0, from.top - r.bottom);
          overlap = Math.min(r.right, from.right) - Math.max(r.left, from.left);
          cross = Math.abs(cx - fx);
        }
        // only things roughly in that direction
        const along = horizontal ? Math.abs(cx - fx) : Math.abs(cy - fy);
        if (overlap <= 0 && cross > (horizontal ? along * 2 + 40 : along * 4 + 300)) continue;
        found.push({ el, primary, cross, overlap: overlap > 0 });
      }
      // ← →: something in the same row first. ↑ ↓: the nearest line of controls (the slider just
      // below, not the wide row further down), and in it the one most in line with where we are.
      let pool = found;
      if (horizontal) {
        const inRow = found.filter(f => f.overlap);
        if (inRow.length) pool = inRow;
        else if (rowOnly) return null;
      }
      if (!pool.length) return null;
      const nearest = Math.min(...pool.map(f => f.primary));
      pool = pool.filter(f => f.primary <= nearest + 24);
      pool.sort((a, b) => (b.overlap - a.overlap) || (a.cross - b.cross));
      return pool[0].el;
    }

    function move(dir) {
      const sc = scope();
      if (!target || !sc.contains(target) || !visible(target)) {
        ensureTarget();
        return;
      }
      const all = candidates(sc).filter(el => el !== target && !el.contains(target));
      if (sc !== document.body) {
        const best = pick(all, dir, dir === 'left' || dir === 'right');
        if (best) setTarget(best);
        return;
      }
      // The page and the sidebar are separate: up/down stay in one of them, left at the page's edge
      // goes to the sidebar's current tab and right from the sidebar returns where you were.
      const side = inSidebar(target);
      const same = all.filter(el => inSidebar(el) === side);
      if (!side && dir === 'left') {
        const best = pick(same, dir, true);
        if (best) { setTarget(best); return; }
        const tab = document.querySelector('.nav-item.active');
        const sideList = all.filter(inSidebar);
        const to = sideList.includes(tab) ? tab : sideList[0];
        if (to) setTarget(to);
        return;
      }
      if (side && dir === 'right') {
        const page = document.querySelector('.page.active');
        const back = lastMain && page && page.contains(lastMain) && all.includes(lastMain) ? lastMain : pageStart(all);
        if (back) setTarget(back);
        return;
      }
      const best = pick(same, dir, dir === 'left' || dir === 'right'); // ← → stay in the row
      if (best) setTarget(best);
    }

    /** ← → on a list or slider changes it. Returns true when it did. */
    function adjust(dir) {
      if (!target || (dir !== 'left' && dir !== 'right')) return false;
      const el = target;
      const step = dir === 'right' ? 1 : -1;
      if (el.tagName === 'SELECT') {
        const opts = [...el.options];
        let i = el.selectedIndex;
        do { i += step; } while (i >= 0 && i < opts.length && opts[i].disabled);
        if (i < 0 || i >= opts.length) return true;
        el.selectedIndex = i;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (el.tagName === 'INPUT' && el.type === 'range') {
        if (editing !== el) return false; // not taken: ← → move on
        const min = Number(el.min || 0);
        const max = Number(el.max || 100);
        const s = Number(el.step) > 0 ? Number(el.step) : 1;
        const delta = Math.max(s, Math.round((max - min) / 40 / s) * s);
        el.value = String(Math.min(max, Math.max(min, Number(el.value) + step * delta)));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }

    function direction(dir) {
      if (editing && (dir === 'up' || dir === 'down')) setEditing(null);
      if (!adjust(dir)) move(dir);
    }

    // ---------- buttons ----------
    function press() {
      if (!ensureTarget()) return;
      const el = target;
      if (el.tagName === 'SELECT') { adjust('right'); return; }
      if (el.tagName === 'INPUT' && el.type === 'range') { setEditing(editing === el ? null : el); return; }
      if (el.matches('input:not([type=checkbox]):not([type=radio]), textarea')) {
        el.focus();
        if (el.select) el.select();
        return;
      }
      const input = el.matches('label, .switch') ? el.querySelector('input[type=checkbox], input[type=radio]') : null;
      if (input) input.click();
      else el.click();
    }

    function key(name) {
      const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true }));
    }

    function back() {
      if (editing) { setEditing(null); return; }
      const ae = document.activeElement;
      if (ae && ae.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea') && document.activeElement === target) {
        // leave the text field but stay on it
        ae.blur();
      }
      if (scope() !== document.body) {
        key('Escape');
        return;
      }
      if (onBack) onBack();
    }

    function menu() {
      const btn = menuButton();
      if (btn) btn.click();
    }

    function tab(step) {
      if (scope() !== document.body) return;
      if (onTab) onTab(step);
      // the new page starts at its first control
      if (target) target.classList.remove('gp-focus');
      target = null;
      lastInScope.delete(document.body);
      ensureTarget();
    }

    // ---------- polling ----------
    // An axis counts only after it has been seen near the center once: some devices that Windows
    // lists as gamepads (wheels, tablets, worn sticks) rest at -1 or drift, and would otherwise
    // steer the launcher and keep turning gamepad mode back on.
    const armed = new Map(); // `${pad.index}:${axis}` -> true
    function axis(pad, i) {
      const v = pad.axes[i] || 0;
      const k = `${pad.index}:${i}`;
      if (!armed.get(k)) {
        if (Math.abs(v) < 0.15) armed.set(k, true);
        return 0;
      }
      return v;
    }

    function stickDir(pad) {
      const x = axis(pad, 0);
      const y = axis(pad, 1);
      if (Math.max(Math.abs(x), Math.abs(y)) < STICK_DEAD) return null;
      return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
    }

    function scrollBy(dy, dx) {
      let el = target || document.querySelector('.page.active');
      const sc = scope();
      while (el && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        const canY = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight;
        const canX = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth;
        if ((dy && canY) || (dx && canX)) {
          el.scrollBy(dx, dy);
          return;
        }
        if (el === sc) break;
        el = el.parentElement;
      }
    }

    function frame(time) {
      rafId = requestAnimationFrame(frame);
      const dt = lastTime ? Math.min(0.05, (time - lastTime) / 1000) : 0;
      lastTime = time;
      if (!enabled || !document.hasFocus()) {
        prevButtons = null;
        held = null;
        return;
      }
      const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      if (!pads.length) return;
      // only devices with the standard layout (real gamepads); others have random button numbers
      const std = pads.filter(p => p.mapping === 'standard');
      if (std.length) pads.splice(0, pads.length, ...std);

      // all connected pads act as one
      const buttons = [];
      let dir = null;
      let sx = 0;
      let sy = 0;
      for (const pad of pads) {
        pad.buttons.forEach((b, i) => { buttons[i] = buttons[i] || b.pressed; });
        dir = dir || stickDir(pad);
        const ax = axis(pad, 2);
        const ay = axis(pad, 3);
        if (Math.abs(ax) > Math.abs(sx)) sx = ax;
        if (Math.abs(ay) > Math.abs(sy)) sy = ay;
      }
      // buttons already held when polling starts or the window regains focus are not presses
      if (!prevButtons) {
        prevButtons = buttons;
        held = dir ? { dir, next: Infinity } : null;
        return;
      }
      if (buttons[BTN.UP]) dir = 'up';
      else if (buttons[BTN.DOWN]) dir = 'down';
      else if (buttons[BTN.LEFT]) dir = 'left';
      else if (buttons[BTN.RIGHT]) dir = 'right';

      const down = (i) => buttons[i] && !prevButtons[i];
      const anyDown = buttons.some((b, i) => b && !prevButtons[i]);
      const scrolling = Math.abs(sy) > SCROLL_DEAD || Math.abs(sx) > SCROLL_DEAD;

      const newDir = dir && (!held || held.dir !== dir);
      if (!active && (anyDown || newDir || scrolling)) {
        // the first touch only shows where the highlight is
        setActive(true);
        ensureTarget();
        prevButtons = buttons;
        if (dir) held = { dir, next: time + REPEAT_DELAY };
        return;
      }

      // the mouse is in charge: don't touch focus or the highlight
      if (!active) {
        prevButtons = buttons;
        return;
      }

      // a dialog opened or closed, the highlighted thing went away: move to the new top layer
      if (!target || !scope().contains(target) || !visible(target)) {
        if (target) target.classList.remove('gp-focus');
        target = null;
        ensureTarget();
      }

      if (dir) {
        if (!held || held.dir !== dir) {
          held = { dir, next: time + REPEAT_DELAY };
          direction(dir);
        } else if (time >= held.next) {
          held.next = time + REPEAT_EVERY;
          direction(dir);
        }
      } else {
        held = null;
      }

      if (down(BTN.A)) press();
      if (down(BTN.B)) back();
      if (down(BTN.X)) menu();
      if (down(BTN.LB)) tab(-1);
      if (down(BTN.RB)) tab(1);

      if (scrolling && dt) {
        const f = (v) => (Math.abs(v) > SCROLL_DEAD ? Math.sign(v) * (Math.abs(v) - SCROLL_DEAD) / (1 - SCROLL_DEAD) : 0);
        scrollBy(f(sy) * SCROLL_SPEED * dt, f(sx) * SCROLL_SPEED * dt);
      }

      // follows scrolling, animations and layout changes under the highlight
      placeRing();
      prevButtons = buttons;
    }

    function start() {
      if (!rafId) rafId = requestAnimationFrame(frame);
    }

    function stop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      lastTime = 0;
      prevButtons = null;
      held = null;
    }

    // polling runs only while a pad is plugged in
    window.addEventListener('gamepadconnected', () => { if (enabled) start(); });
    window.addEventListener('gamepaddisconnected', () => {
      const left = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      if (!left.length) { stop(); setActive(false); }
    });
    // the mouse takes over again
    let lastMouse = null;
    document.addEventListener('mousemove', (e) => {
      if (!active) return;
      if (lastMouse && Math.abs(e.screenX - lastMouse[0]) + Math.abs(e.screenY - lastMouse[1]) > 4) setActive(false);
      lastMouse = [e.screenX, e.screenY];
    }, true);
    document.addEventListener('mousedown', () => setActive(false), true);
    // when the highlight is shown, a click anywhere keeps it in step with the keyboard
    document.addEventListener('focusin', (e) => {
      if (!active) return;
      const v = visualOf(e.target);
      if (v !== target && v.matches && candidates(scope()).includes(v)) setTarget(v, { scroll: false });
    });

    return {
      setEnabled(on) {
        enabled = on !== false;
        if (!enabled) { stop(); setActive(false); return; }
        const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
        if (pads.length) start();
      },
      get active() { return active; }
    };
  }

  root.createGamepadNav = createGamepadNav;
})(this);
