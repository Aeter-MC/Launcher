/* Our own popup for <select class="select">: the native one can't be styled in Electron.
   The <select> stays the source of truth (value, options, 'change'), only its popup is replaced. */
(() => {
  let open = null; // { select, menu, items, active, arrow }
  let closing = null; // the arrow turning back after a close: { select, el, timer }
  const CLOSE_MS = 140;

  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  /* The select draws its chevron as a background, which can't turn. While the menu is open
     the select hides it (.select-open) and a copy on top of it turns over instead. */
  function arrowFor(select) {
    if (closing && closing.select === select) {
      clearTimeout(closing.timer);
      const el = closing.el;
      closing = null;
      return el;
    }
    finishClosing();
    const el = document.createElement('div');
    el.className = 'select-arrow';
    el.innerHTML = CHEVRON;
    document.body.appendChild(el);
    return el;
  }

  function placeArrow(select, el) {
    const r = select.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(select).borderRightWidth) || 0;
    el.style.left = `${r.right - border - 9 - 14}px`;
    el.style.top = `${r.top + r.height / 2 - 7}px`;
  }

  function finishClosing() {
    if (!closing) return;
    clearTimeout(closing.timer);
    closing.el.remove();
    closing.select.classList.remove('select-open');
    closing = null;
  }

  const CHECK = '<svg class="select-menu-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  function close(refocus = false) {
    if (!open) return;
    const { select, menu, arrow } = open;
    open = null;
    // the menu fades out; a timer, not animationend, so it also goes when animations are off
    menu.classList.add('closing');
    setTimeout(() => menu.remove(), CLOSE_MS);
    arrow.classList.remove('flipped');
    closing = { select, el: arrow, timer: setTimeout(finishClosing, CLOSE_MS + 40) };
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onWindow);
    window.removeEventListener('blur', onWindow);
    if (refocus) select.focus({ preventScroll: true });
  }

  const onWindow = () => { close(); finishClosing(); };
  const onScroll = (e) => { if (open && !open.menu.contains(e.target)) { close(); finishClosing(); } };
  function onOutside(e) {
    if (!open || open.menu.contains(e.target) || e.target === open.select) return;
    close();
  }

  function choose(i) {
    const { select, items } = open;
    const opt = items[i].option;
    close(true);
    if (opt.disabled || select.value === opt.value && select.selectedIndex === opt.index) return;
    select.selectedIndex = opt.index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setActive(i, scroll = true) {
    if (!open) return;
    open.items.forEach((it, n) => it.el.classList.toggle('active', n === i));
    open.active = i;
    if (scroll && i >= 0) open.items[i].el.scrollIntoView({ block: 'nearest' });
  }

  function step(from, dir) {
    const { items } = open;
    let i = from;
    do { i += dir; } while (i >= 0 && i < items.length && items[i].option.disabled);
    return i >= 0 && i < items.length ? i : from;
  }

  function build(select) {
    const menu = document.createElement('div');
    menu.className = 'select-menu';
    menu.setAttribute('role', 'listbox');
    if (select.getAttribute('translate') === 'no') menu.setAttribute('translate', 'no');
    const items = [];
    let group = null;
    for (const opt of select.options) {
      if (opt.hidden) continue;
      const g = opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement : null;
      if (g && g !== group) {
        const h = document.createElement('div');
        h.className = 'select-menu-group';
        h.textContent = g.label;
        menu.appendChild(h);
      }
      group = g;
      const el = document.createElement('div');
      el.className = 'select-menu-item';
      el.setAttribute('role', 'option');
      if (opt.disabled) el.classList.add('disabled');
      if (opt.selected) { el.classList.add('selected'); el.setAttribute('aria-selected', 'true'); }
      el.innerHTML = CHECK;
      const label = document.createElement('span');
      label.textContent = opt.textContent;
      el.appendChild(label);
      const n = items.length;
      el.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the select
      el.addEventListener('click', () => { if (!opt.disabled) choose(n); });
      items.push({ el, option: opt });
      menu.appendChild(el);
    }
    return { menu, items };
  }

  function place(select, menu) {
    const r = select.getBoundingClientRect();
    menu.style.minWidth = `${r.width}px`;
    menu.style.maxWidth = `${Math.max(r.width, window.innerWidth - 16)}px`;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const h = menu.scrollHeight;
    const up = h > below && above > below;
    menu.style.maxHeight = `${Math.min(320, up ? above : below)}px`;
    const m = menu.getBoundingClientRect();
    let left = r.left;
    if (left + m.width > window.innerWidth - 8) left = Math.max(8, r.right - m.width);
    menu.style.left = `${left}px`;
    menu.style.top = up ? `${r.top - m.height - 4}px` : `${r.bottom + 4}px`;
    menu.classList.toggle('up', up);
  }

  function show(select) {
    close();
    if (select.disabled || !select.options.length) return;
    const { menu, items } = build(select);
    document.body.appendChild(menu);
    const arrow = arrowFor(select);
    placeArrow(select, arrow);
    select.classList.add('select-open');
    open = { select, menu, items, active: -1, arrow };
    place(select, menu);
    arrow.getBoundingClientRect(); // start the turn from where it is now
    arrow.classList.add('flipped');
    const sel = items.findIndex(it => it.option.selected);
    if (sel >= 0) {
      const el = items[sel].el;
      menu.scrollTop = el.offsetTop - (menu.clientHeight - el.offsetHeight) / 2;
    }
    open.active = sel;
    setTimeout(() => {
      if (!open || open.menu !== menu) return;
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onWindow);
      window.addEventListener('blur', onWindow);
    });
  }

  document.addEventListener('mousedown', (e) => {
    const select = e.target.closest?.('select.select');
    if (!select || e.button !== 0) return;
    e.preventDefault();
    if (open && open.select === select) { close(true); return; }
    select.focus({ preventScroll: true });
    show(select);
  }, true);

  let typed = '';
  let typedAt = 0;

  document.addEventListener('keydown', (e) => {
    const select = e.target;
    if (!(select instanceof HTMLSelectElement) || !select.classList.contains('select')) return;
    const isOpen = open && open.select === select;
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
        e.preventDefault();
        e.stopPropagation();
        show(select);
      }
      return;
    }
    const k = e.key;
    let handled = true;
    if (k === 'Escape') close(true);
    else if (k === 'Tab') { close(); handled = false; }
    else if (k === 'ArrowDown') setActive(step(open.active, 1));
    else if (k === 'ArrowUp') setActive(step(open.active, -1));
    else if (k === 'Home') setActive(step(-1, 1));
    else if (k === 'End') setActive(step(open.items.length, -1));
    else if (k === 'PageDown') { let i = open.active; for (let n = 0; n < 8; n++) i = step(i, 1); setActive(i); }
    else if (k === 'PageUp') { let i = open.active; for (let n = 0; n < 8; n++) i = step(i, -1); setActive(i); }
    else if (k === 'Enter' || k === ' ') { if (open.active >= 0) choose(open.active); else close(true); }
    else if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const now = Date.now();
      typed = now - typedAt > 700 ? k.toLowerCase() : typed + k.toLowerCase();
      typedAt = now;
      const n = open.items.length;
      for (let d = typed.length === 1 ? 1 : 0; d <= n; d++) {
        const i = (Math.max(open.active, 0) + d) % n;
        const it = open.items[i];
        if (!it.option.disabled && it.option.textContent.trim().toLowerCase().startsWith(typed)) { setActive(i); break; }
      }
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // the mouse takes over from the keyboard highlight
  document.addEventListener('mousemove', (e) => {
    if (open && open.active >= 0 && open.menu.contains(e.target)) setActive(-1, false);
  }, true);

  // value changed while open (gamepad ← →, code): just close
  document.addEventListener('change', (e) => { if (open && e.target === open.select) close(); }, true);
  document.addEventListener('focusout', (e) => { if (open && e.target === open.select) setTimeout(() => { if (open && document.activeElement !== open.select) close(); }); }, true);
})();
