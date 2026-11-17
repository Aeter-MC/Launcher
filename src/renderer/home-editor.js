let homeLayoutDraft = null;
let layoutSaving = false;
let layoutDrag = null;
let layoutResize = null;

function homeWidgetLabel(id) {
  return {
    hero: t('Карточка запуска'), recent: t('Недавние сборки'), news: t('Новости AeterMC'),
    playtime: t('Время за неделю'), monthPlaytime: t('Время за месяц'), tip: t('Подсказка')
  }[id];
}

function applyHomeLayout(value) {
  const layout = homeLayoutDraft || normalizeHomeLayout(value);
  const home = $('home-layout');
  const widgets = new Map([...home.querySelectorAll('[data-home-widget]')].map(el => [el.dataset.homeWidget, el]));
  const editing = !!homeLayoutDraft;
  const moving = !!layoutDrag?.active;
  home.classList.toggle('layout-editing', editing);
  home.classList.toggle('layout-moving', moving);
  for (const column of HOME_COLUMNS) {
    const target = $(`home-${column}-widgets`);
    const ids = layout[column];
    ids.forEach((id, index) => {
      const widget = widgets.get(id);
      if (target.children[index] !== widget) target.insertBefore(widget, target.children[index] || null);
      widget.classList.toggle('hidden', layout.hidden.includes(id));
      widget.querySelector('.home-widget-body').inert = editing;
      if (editing) {
        widget.tabIndex = 0;
        widget.setAttribute('role', 'button');
        widget.setAttribute('aria-haspopup', 'menu');
        widget.setAttribute('aria-label', t('Настройки блока «{name}»', { name: homeWidgetLabel(id) }));
      } else {
        for (const attr of ['tabindex', 'role', 'aria-haspopup', 'aria-label']) widget.removeAttribute(attr);
      }
    });
    const empty = ids.every(id => layout.hidden.includes(id));
    target.classList.toggle('layout-empty', empty);
    target.classList.toggle('hidden', empty && !moving);
    home.classList.toggle(`home-no-${column}`, empty && !moving);
    if (column !== 'main') home.classList.toggle(`layout-empty-${column}`, empty && moving);
  }
  home.classList.toggle('home-compact-hero', layout.heroCompact);
  $('week-chart').classList.toggle('week-chart-vertical', layout.weekVertical);
  applyHomeSideWidth(layout.sideWidth);
  renderRecent({ layout, onlyIfCapacityChanged: true });
}

function applyHomeSideWidth(width) {
  const home = $('home-layout');
  home.style.setProperty('--home-side-width', `${width}px`);
  for (const handle of home.querySelectorAll('.layout-resize')) handle.setAttribute('aria-valuenow', width);
}

function layoutWidget(id) {
  return $('home-layout').querySelector(`[data-home-widget="${id}"]`);
}

function renderHiddenWidgets() {
  const chips = homeLayoutDraft.hidden.map(id => {
    const chip = document.createElement('button');
    chip.className = 'btn btn-secondary btn-sm layout-restore';
    chip.dataset.layoutDrag = id;
    const name = homeWidgetLabel(id);
    chip.innerHTML = icon('plus', 'ic-sm');
    chip.append(name);
    chip.setAttribute('aria-label', t('Вернуть блок «{name}»', { name }));
    chip.addEventListener('click', () => {
      if (!homeLayoutDraft || layoutSaving) return;
      homeLayoutDraft.hidden = homeLayoutDraft.hidden.filter(key => key !== id);
      applyHomeLayout();
      renderHiddenWidgets();
      layoutWidget(id)?.focus({ preventScroll: true });
    });
    return chip;
  });
  $('layout-hidden-widgets').replaceChildren(...chips);
  $('layout-tray').classList.toggle('hidden', chips.length === 0);
}

function renderLayoutEditor() {
  applyHomeLayout();
  renderHiddenWidgets();
}

function visibleLayoutWidgets(column) {
  return homeLayoutDraft[column].filter(id => !homeLayoutDraft.hidden.includes(id));
}

function widgetColumn(id) {
  return HOME_COLUMNS.find(column => homeLayoutDraft[column].includes(id));
}

function moveLayoutWidget(id, column, before) {
  if (!homeLayoutDraft || layoutSaving) return;
  const draft = homeLayoutDraft;
  const from = widgetColumn(id);
  const visible = visibleLayoutWidgets(from);
  const position = visible.indexOf(id);
  if (from !== column || position < 0 || visible[position + 1] !== before) {
    draft[from] = draft[from].filter(key => key !== id);
    const at = before === undefined ? draft[column].length : draft[column].indexOf(before);
    draft[column].splice(at, 0, id);
    draft.hidden = draft.hidden.filter(key => key !== id);
    applyHomeLayout();
    renderHiddenWidgets();
  }
  layoutWidget(id)?.focus({ preventScroll: true });
}

function hideLayoutWidget(id) {
  if (!homeLayoutDraft || layoutSaving) return;
  const column = widgetColumn(id);
  const visible = visibleLayoutWidgets(column);
  const position = visible.indexOf(id);
  if (position < 0) return;
  homeLayoutDraft.hidden.push(id);
  applyHomeLayout();
  renderHiddenWidgets();
  const next = layoutWidget(visible[position + 1] || visible[position - 1]);
  (next || $('layout-save')).focus({ preventScroll: !!next });
}

function openLayoutWidgetMenu(widget, point) {
  if (!homeLayoutDraft || layoutSaving || layoutDrag?.active) return;
  const id = widget.dataset.homeWidget;
  const column = widgetColumn(id);
  const visible = visibleLayoutWidgets(column);
  const position = visible.indexOf(id);
  const items = [];
  if (id === 'hero') {
    items.push({
      label: t('Компактная карточка запуска'),
      checked: homeLayoutDraft.heroCompact,
      run: () => {
        homeLayoutDraft.heroCompact = !homeLayoutDraft.heroCompact;
        applyHomeLayout();
        widget.focus({ preventScroll: true });
      }
    }, 'separator');
  }
  if (id === 'recent') items.push({ label: t('Размер сетки…'), icon: 'grid', run: openRecentLayoutDialog }, 'separator');
  if (id === 'playtime') {
    items.push({
      label: t('Вертикальный режим'),
      checked: homeLayoutDraft.weekVertical,
      run: () => {
        homeLayoutDraft.weekVertical = !homeLayoutDraft.weekVertical;
        applyHomeLayout();
        widget.focus({ preventScroll: true });
      }
    }, 'separator');
  }
  if (position > 0) items.push({ label: t('Выше'), icon: 'chevron', run: () => moveLayoutWidget(id, column, visible[position - 1]) });
  if (position < visible.length - 1) items.push({ label: t('Ниже'), icon: 'chevron', run: () => moveLayoutWidget(id, column, visible[position + 2]) });
  const labels = { left: t('В левую колонку'), main: t('В основную колонку'), right: t('В правую колонку') };
  for (const target of HOME_COLUMNS) {
    if (target !== column) items.push({ label: labels[target], icon: 'transfer', run: () => moveLayoutWidget(id, target) });
  }
  items.push('separator', { label: t('Скрыть блок'), icon: 'x', danger: true, run: () => hideLayoutWidget(id) });
  openMenu(widget, items, point);
}

function openRecentLayoutDialog() {
  $('layout-recent-rows').value = homeLayoutDraft.recentRows;
  $('layout-recent-columns').value = homeLayoutDraft.recentColumns;
  openModal('modal-layout-recent');
  $('layout-recent-rows').focus();
}

function closeRecentLayoutDialog(focus = true) {
  $('modal-layout-recent').classList.add('hidden');
  if (focus) layoutWidget('recent')?.focus({ preventScroll: true });
}

function setupRecentLayout() {
  for (const [id, max] of [['layout-recent-rows', HOME_RECENT_ROWS_MAX], ['layout-recent-columns', HOME_RECENT_COLUMNS_MAX]]) {
    const select = $(id);
    select.add(new Option(t('Авто'), '0'));
    for (let n = 1; n <= max; n++) select.add(new Option(String(n), String(n)));
  }
  $('layout-recent-cancel').addEventListener('click', () => closeRecentLayoutDialog());
  $('modal-layout-recent').querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    if (!homeLayoutDraft || layoutSaving) return;
    homeLayoutDraft.recentRows = Number($('layout-recent-rows').value);
    homeLayoutDraft.recentColumns = Number($('layout-recent-columns').value);
    applyHomeLayout();
    closeRecentLayoutDialog();
  });
}

function setupLayoutDrag() {
  const page = $('page-home');
  page.addEventListener('pointerdown', e => {
    if (!homeLayoutDraft || layoutSaving || layoutDrag || layoutResize || e.button !== 0 || !e.isPrimary) return;
    const source = e.target.closest('[data-home-widget], .layout-restore');
    if (!source) return;
    closeMenu();
    layoutDrag = {
      page, source, id: source.dataset.homeWidget || source.dataset.layoutDrag, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, dx: 0, dy: 0, active: false
    };
  });
  window.addEventListener('pointermove', e => {
    const drag = layoutDrag;
    if (drag?.pointerId !== e.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.active || Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
    const box = drag.source.getBoundingClientRect();
    drag.left = box.left;
    drag.top = box.top;
    drag.source.style.width = `${box.width}px`;
    drag.source.classList.add('layout-dragged');
    drag.active = true;
    page.setPointerCapture(e.pointerId);
    applyHomeLayout();
    renderLayoutDrag();
    e.preventDefault();
  });
  window.addEventListener('pointerup', e => {
    const drag = layoutDrag;
    if (drag?.pointerId !== e.pointerId) return;
    const column = drag.active && layoutDropColumn(e.clientX, e.clientY);
    const before = column && layoutDropBefore(column, e.clientY)?.dataset.homeWidget;
    clearLayoutDrag();
    if (column) moveLayoutWidget(drag.id, column.dataset.layoutColumn, before);
  });
  window.addEventListener('pointercancel', e => {
    if (layoutDrag?.pointerId === e.pointerId) clearLayoutDrag();
  });
  page.addEventListener('lostpointercapture', e => {
    if (e.target === page && layoutDrag?.pointerId === e.pointerId) clearLayoutDrag();
  });
  window.addEventListener('blur', clearLayoutDrag);
}

function renderLayoutDrag() {
  const drag = layoutDrag;
  const { page, source, x, y } = drag;
  const viewport = page.getBoundingClientRect();
  if (x >= viewport.left && x <= viewport.right && y >= viewport.top && y <= viewport.bottom) {
    const edge = Math.min(64, viewport.height / 4);
    const offset = Math.min(0, y - viewport.top - edge) + Math.max(0, y - viewport.bottom + edge);
    if (offset) page.scrollTop += Math.sign(offset) * Math.ceil(Math.abs(offset) / 4);
  }

  const box = source.getBoundingClientRect();
  drag.dx += drag.left + x - drag.startX - box.left;
  drag.dy += drag.top + y - drag.startY - box.top;
  source.style.translate = `${drag.dx}px ${drag.dy}px`;
  const column = layoutDropColumn(x, y);
  const before = column && layoutDropBefore(column, y);
  showLayoutDropCue(before || column, before ? 'layout-drop-before' : 'layout-drop-end');
  drag.frame = requestAnimationFrame(renderLayoutDrag);
}

function layoutDropColumn(x, y) {
  return document.elementFromPoint(x, y)?.closest('[data-layout-column]');
}

function layoutDropBefore(column, y) {
  return [...column.children].find(widget => {
    if (!widget.dataset.homeWidget || widget.dataset.homeWidget === layoutDrag.id || widget.classList.contains('hidden')) return false;
    const box = widget.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
}

function showLayoutDropCue(element, className) {
  if (layoutDrag.cue === element && layoutDrag.cueClass === className) return;
  layoutDrag.cue?.classList.remove('layout-drop-before', 'layout-drop-end');
  element?.classList.add(className);
  layoutDrag.cue = element;
  layoutDrag.cueClass = className;
}

function clearLayoutDrag() {
  if (!layoutDrag) return false;
  const { page, source, pointerId, active, frame } = layoutDrag;
  if (active) showLayoutDropCue(null);
  layoutDrag = null;
  if (active) {
    cancelAnimationFrame(frame);
    source.classList.remove('layout-dragged');
    source.style.removeProperty('width');
    source.style.removeProperty('translate');
    if (page.hasPointerCapture(pointerId)) page.releasePointerCapture(pointerId);
    applyHomeLayout();
  }
  return true;
}

function clearLayoutResize() {
  if (!layoutResize) return;
  const { handle, pointerId } = layoutResize;
  layoutResize = null;
  handle.classList.remove('resizing');
  if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
}

function setupLayoutResize(home) {
  for (const side of ['left', 'right']) {
    const column = $(`home-${side}-widgets`);
    const handle = document.createElement('button');
    const direction = side === 'left' ? 1 : -1;
    handle.type = 'button';
    handle.className = 'layout-resize';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', t('Ширина боковых колонок'));
    handle.setAttribute('aria-valuemin', HOME_SIDE_WIDTH_MIN);
    handle.setAttribute('aria-valuemax', HOME_SIDE_WIDTH_MAX);
    handle.setAttribute('aria-controls', column.id);
    column.append(handle);

    const setWidth = (width) => {
      const twoSides = !home.matches('.home-no-left, .home-no-right');
      const maxWidth = home.clientWidth * (twoSides ? .28 : .4);
      const limit = Math.ceil(maxWidth / HOME_SIDE_WIDTH_STEP) * HOME_SIDE_WIDTH_STEP;
      homeLayoutDraft.sideWidth = normalizeHomeSideWidth(Math.min(width, limit));
      applyHomeSideWidth(homeLayoutDraft.sideWidth);
    };

    handle.addEventListener('pointerdown', e => {
      if (!homeLayoutDraft || layoutSaving || layoutDrag || layoutResize || e.button !== 0 || !e.isPrimary) return;
      closeMenu();
      const width = column.getBoundingClientRect().width;
      layoutResize = { handle, pointerId: e.pointerId, x: e.clientX, width, initialWidth: homeLayoutDraft.sideWidth };
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('resizing');
    });
    handle.addEventListener('pointermove', e => {
      if (layoutResize?.pointerId !== e.pointerId || layoutResize.handle !== handle) return;
      const delta = (e.clientX - layoutResize.x) * direction;
      const width = layoutResize.width + delta;
      if (!delta && homeLayoutDraft.sideWidth === layoutResize.initialWidth) return;
      setWidth(width);
    });
    handle.addEventListener('lostpointercapture', e => {
      if (layoutResize?.pointerId === e.pointerId && layoutResize.handle === handle) clearLayoutResize();
    });
    handle.addEventListener('pointercancel', e => {
      if (layoutResize?.pointerId !== e.pointerId || layoutResize.handle !== handle) return;
      homeLayoutDraft.sideWidth = layoutResize.initialWidth;
      applyHomeSideWidth(homeLayoutDraft.sideWidth);
      clearLayoutResize();
    });
    handle.addEventListener('keydown', e => {
      if (!homeLayoutDraft || layoutSaving) return;
      let width = column.getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') width -= HOME_SIDE_WIDTH_STEP * direction;
      else if (e.key === 'ArrowRight') width += HOME_SIDE_WIDTH_STEP * direction;
      else if (e.key === 'Home') width = HOME_SIDE_WIDTH_MIN;
      else if (e.key === 'End') width = HOME_SIDE_WIDTH_MAX;
      else return;
      e.preventDefault();
      setWidth(width);
    });
  }
}

function closeHomeLayoutEditor(focus = false) {
  if (!homeLayoutDraft || layoutSaving) return false;
  closeMenu();
  clearLayoutDrag();
  clearLayoutResize();
  closeRecentLayoutDialog(false);
  homeLayoutDraft = null;
  $('home-layout-editor').classList.add('hidden');
  $('home-greeting').classList.remove('hidden');
  applyHomeLayout(state.settings.homeLayout);
  if (focus) $('home-greeting').focus();
  return true;
}

function setupHomeLayoutEditor() {
  const editor = $('home-layout-editor');
  const preview = $('home-layout');
  for (const widget of preview.querySelectorAll('[data-home-widget]')) {
    widget.addEventListener('contextmenu', e => {
      if (!homeLayoutDraft || layoutSaving || layoutDrag?.active) return;
      e.preventDefault();
      const point = e.button === 2 ? { x: e.clientX, y: e.clientY } : undefined;
      openLayoutWidgetMenu(widget, point);
    });
    widget.addEventListener('keydown', e => {
      if (!homeLayoutDraft || e.target !== widget || !['Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      if (!e.repeat) openLayoutWidgetMenu(widget);
    });
    widget.addEventListener('click', e => {
      if (e.target === widget && e.detail === 0) openLayoutWidgetMenu(widget);
    });
  }
  const dropHints = { left: t('Левая колонка'), main: t('Основная колонка'), right: t('Правая колонка') };
  for (const column of preview.querySelectorAll('[data-layout-column]')) {
    column.dataset.dropHint = dropHints[column.dataset.layoutColumn];
  }
  setupLayoutDrag();
  setupLayoutResize(preview);
  setupRecentLayout();

  $('btn-edit-home-layout').addEventListener('click', () => {
    showPage('home');
    homeLayoutDraft = normalizeHomeLayout(state.settings.homeLayout);
    $('home-greeting').classList.add('hidden');
    editor.classList.remove('hidden');
    renderLayoutEditor();
    $('layout-save').focus();
  });
  $('layout-reset').addEventListener('click', () => {
    clearLayoutDrag();
    clearLayoutResize();
    homeLayoutDraft = normalizeHomeLayout(null);
    renderLayoutEditor();
  });
  $('layout-cancel').addEventListener('click', () => closeHomeLayoutEditor(true));
  $('layout-save').addEventListener('click', async () => {
    clearLayoutDrag();
    clearLayoutResize();
    closeMenu();
    const controls = [...editor.querySelectorAll('button:enabled'), ...preview.querySelectorAll('.layout-resize')];
    layoutSaving = true;
    controls.forEach(el => { el.disabled = true; });
    const saved = await saveSettings({ homeLayout: normalizeHomeLayout(homeLayoutDraft) });
    controls.forEach(el => { el.disabled = false; });
    layoutSaving = false;
    const onHome = $('page-home').classList.contains('active');
    if (saved || !onHome) closeHomeLayoutEditor(saved && onHome);
  });
}
