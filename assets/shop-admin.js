/* 简白图库 · 店家后台增强：分类管理 / 全能 VIP / 一键改价
   ------------------------------------------------------------------
   读：商品与分类来自 ./photos/manifest.json、./photos/categories.json、
       VIP 来自 ./photos/shop-extras.json，都是静态文件，手机 / 电脑都能看。
   写：只走店家电脑上的本机上传台 http://127.0.0.1:3210，写完由上传台统一
       重建索引 → 升版本 → 同步快照 → 发布，客户刷新就能看到。
   安全：整个面板在 #orders-body 内，只有店家登录后才显示；客户永远只读，
       页面里没有任何账号、密码、店家口令，也不接任何真实收款 / 扣款。 */
(() => {
  'use strict';

  /* 客户前台不带 view=orders，完全不加载后台数据，也不探测本机 */
  if (!/[?&]view=orders(?:&|$)/.test(location.search)) return;

  const $ = (id) => document.getElementById(id);
  const CONSOLE = 'http://127.0.0.1:3210';
  const DEFAULT_VIP = { plan: '全能 VIP', pricePerQuarter: 300, expiresAt: '2027-01-06', renewals: [] };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const state = {
    frames: [], cats: [], customCats: {}, vip: { ...DEFAULT_VIP, renewals: [] },
    selected: new Set(), openCats: new Set(), canWrite: false, preview: [], busy: false,
    view: 'home', totalImages: 0, totalPhotos: 0, bytes: 0,
    trash: [], trashSelected: new Set(),
    albumSelected: new Set(), albumPage: 0, albumQuery: '', albumVisible: [],
    activeCat: '', catPage: 0,
    drafts: {}, details: {}, albumAnchor: '',
    amMode: 'create', amId: '', amFiles: []
  };
  const ALBUM_PAGE_SIZE = 60;
  const CAT_PAGE_SIZE = 60;
  let toastTimer = null;

  function isVipActive() {
    const d = new Date(String(state.vip.expiresAt || '') + 'T23:59:59');
    return !isNaN(d.getTime()) && d.getTime() > Date.now();
  }

  function baseStatus() {
    return state.canWrite
      ? `已连接店家电脑 · 共 ${state.frames.length} 个商品`
      : '只读模式：查看可以，创建 / 改价 / 续费请在店家电脑上进行';
  }

  function toast(msg, kind) {
    const e = $('sa-status');
    if (!e) return;
    e.textContent = msg;
    e.className = 'sa-status' + (kind ? ' is-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { e.textContent = baseStatus(); e.className = 'sa-status'; }, 7000);
  }

  async function post(path, body) {
    const r = await fetch(CONSOLE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    let j;
    try { j = await r.json(); } catch { throw new Error('本机上传台没响应'); }
    if (!j.ok) throw new Error(j.message || '操作失败');
    return j;
  }

  async function load() {
    const m = await fetch('./photos/manifest.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
    state.frames = (m.frames || []).map((f) => ({
      id: f.id, title: f.title || '', category: f.category || '',
      price: (f.detail && f.detail.price) || '', code: (f.detail && f.detail.code) || '',
      cover: f.cover || ((f.photos && f.photos[0] && f.photos[0].src) || ''),
      count: f.count || (f.photos ? f.photos.length : 0)
    }));
    state.totalImages = m.totalImages || 0;
    state.totalPhotos = m.total || 0;
    state.bytes = (m.frames || []).reduce((n, f) =>
      n + (f.photos || []).reduce((a, p) => a + (Number(p.size) || 0), 0), 0);
    state.cats = (m.categoryFilters || []).map((c) => ({ id: c.id, label: c.label, count: c.count || 0 }));

    try {
      const cc = await fetch('./photos/categories.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
      state.customCats = (cc && typeof cc === 'object' && !Array.isArray(cc)) ? cc : {};
    } catch { state.customCats = {}; }

    try {
      const ex = await fetch('./photos/shop-extras.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
      state.vip = (ex && ex.vip && typeof ex.vip === 'object') ? ex.vip : { ...DEFAULT_VIP, renewals: [] };
    } catch { state.vip = { ...DEFAULT_VIP, renewals: [] }; }

    try {
      const det = await fetch('./photos/details.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
      state.details = (det && typeof det === 'object' && !Array.isArray(det)) ? det : {};
    } catch { state.details = {}; }

    try {
      const pong = await fetch(CONSOLE + '/api/shop-admin/ping', { cache: 'no-store' }).then((r) => r.json());
      state.canWrite = Boolean(pong.ok);
      if (pong.vip) state.vip = pong.vip; // 本机刚续费过，以本机为准
    } catch { state.canWrite = false; }

    // 草稿相册：优先读本机（刚建完立刻可见），手机端读不到本机时退回线上快照
    try {
      const r = await fetch(CONSOLE + '/api/shop-admin/albums', { cache: 'no-store' }).then((x) => x.json());
      state.drafts = (r && r.ok && r.albums && typeof r.albums === 'object' && !Array.isArray(r.albums)) ? r.albums : {};
    } catch {
      try {
        const d = await fetch('./photos/albums.json?t=' + Date.now(), { cache: 'no-store' }).then((x) => x.json());
        state.drafts = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
      } catch { state.drafts = {}; }
    }
  }

  /* ---------- 回收站：列出 / 恢复 / 永久删除 / 清空 ---------- */
  async function loadTrash() {
    if (!state.canWrite) { state.trash = []; state.trashSelected.clear(); renderTrash(); return; }
    try {
      const r = await fetch(CONSOLE + '/api/shop-admin/trash', { cache: 'no-store' }).then((x) => x.json());
      state.trash = Array.isArray(r.items) ? r.items : [];
    } catch { state.trash = []; }
    state.trashSelected.clear();
    renderTrash();
  }

  function syncTrashControls() {
    const n = state.trash.length;
    const badge = $('sa-trash-count');
    if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
    $('sa-trash-status').textContent = !state.canWrite
      ? '回收站要在店家电脑上打开后台才能查看（手机端只读）'
      : (n ? `共 ${n} 个文件 · 已选 ${state.trashSelected.size} 个` : '');
    const can = state.canWrite && isVipActive() && state.trashSelected.size > 0;
    $('sa-trash-restore').disabled = !can;
    $('sa-trash-purge').disabled = !can;
    $('sa-trash-empty').disabled = !state.canWrite || !isVipActive() || n === 0;
  }

  function renderTrash() {
    const list = $('sa-trash-list');
    const empty = $('sa-trash-empty-state');
    const n = state.trash.length;
    list.hidden = n === 0;
    empty.hidden = n > 0;
    empty.querySelector('p').textContent = state.canWrite
      ? '回收站里没有内容'
      : '这台设备读不到本机回收站，请在店家电脑上打开后台';
    list.innerHTML = state.trash.map((it) =>
      `<label class="sa-trash-item">` +
      `<input type="checkbox" data-trash="${esc(it.id)}"${state.trashSelected.has(it.id) ? ' checked' : ''}>` +
      `<img src="${esc(it.thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` +
      `<span class="sa-trash-meta"><b title="${esc(it.name)}">${esc(it.name)}</b>` +
      `<small>${Math.round((Number(it.size) || 0) / 1024)} KB · ${esc(String(it.at).slice(0, 10))} · 恢复到 ${esc(it.category)}</small></span></label>`
    ).join('');
    syncTrashControls();
  }

  async function doTrash(action) {
    if (!state.canWrite) { toast('回收站操作要在店家电脑上打开后台', 'warn'); return; }
    if (!isVipActive()) { toast('VIP 权益已到期，请先点「续费一个季度」', 'warn'); return; }
    const ids = [...state.trashSelected];
    if (action !== 'empty' && !ids.length) { toast('请先勾选要处理的文件', 'warn'); return; }
    const verb = action === 'restore' ? `恢复选中的 ${ids.length} 张图到相册`
      : action === 'purge' ? `永久删除选中的 ${ids.length} 个文件（不可恢复）`
        : '清空整个回收站（不可恢复）';
    if (!confirm(`确定${verb}吗？`)) return;
    try {
      const r = await post('/api/shop-admin/trash', { action, ids });
      state.trashSelected.clear();
      toast('✔ ' + r.message);
      await loadTrash();
      if (action === 'restore') setTimeout(refresh, 9000);
    } catch (e) { toast('✖ ' + e.message, 'warn'); }
  }

  /* ---------- 左侧导航：首页 / 相册 / 分类 / 工具箱 / 回收站 ---------- */
  function switchView(v) {
    state.view = v;
    document.querySelectorAll('[data-sa-panel]').forEach((s) => {
      const views = String(s.dataset.saPanel || '').split(/\s+/);
      s.hidden = !views.includes(v);
    });
    document.querySelectorAll('.sa-nav-item[data-sa-view]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.saView === v);
    });
    const tools = $('sa-nav-tools');
    if (tools) tools.hidden = v !== 'tools';
    if (v === 'home') renderHome();
    if (v === 'albums') renderAlbums();
    if (v === 'trash') loadTrash();
  }

  function renderHome() {
    $('sa-stat-albums').textContent = String(state.frames.length);
    $('sa-stat-photos').textContent = String(state.totalImages || state.totalPhotos);
    $('sa-space-used').textContent = (state.bytes / 1073741824).toFixed(2) + ' G';
  }

  /* ---------- 后台「相册」：平时格子干净无勾框，点图选中 + Ctrl/⌘ 多选 +
     Shift 连选 + 顶部全选本页；双击 / 右键可编辑资料、加图、删除。
     空相册（草稿）只存在 albums.json，客户前台不读，所以不会打扰客户。 ---------- */
  function albumList() {
    const q = state.albumQuery.trim().toLowerCase();
    const drafts = Object.entries(state.drafts || {}).map(([id, d]) => ({
      id, title: (d && d.title) || '未命名相册', code: (d && d.code) || '',
      price: (d && d.price) || '', cover: '', count: 0,
      category: (d && d.category) || '', draft: true,
      createdAt: String((d && d.createdAt) || '')
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const all = drafts.concat(state.frames.map((f) => ({ ...f, draft: false })));
    return q
      ? all.filter((f) => (String(f.title) + ' ' + String(f.code)).toLowerCase().includes(q))
      : all;
  }

  function albumData(id) {
    if (state.drafts[id]) return { ...state.drafts[id], draft: true };
    const f = state.frames.find((x) => x.id === id) || {};
    return { ...f, ...(state.details[id] || {}), draft: false };
  }

  function renderAlbums() {
    const all = albumList();
    const pages = Math.max(1, Math.ceil(all.length / ALBUM_PAGE_SIZE));
    state.albumPage = Math.min(Math.max(0, state.albumPage), pages - 1);
    const pageItems = all.slice(state.albumPage * ALBUM_PAGE_SIZE, (state.albumPage + 1) * ALBUM_PAGE_SIZE);
    state.albumVisible = pageItems.map((f) => f.id);

    const drafts = Object.keys(state.drafts || {}).length;
    $('sa-album-summary').textContent =
      `${state.frames.length} 个商品框 · ${state.totalImages || state.totalPhotos} 张图片` +
      (drafts ? ` · ${drafts} 个空相册` : '');

    $('sa-album-grid').innerHTML = pageItems.map((f) => {
      const on = state.albumSelected.has(f.id);
      const cover = f.draft
        ? '<span class="sa-album-blank">＋<small>空相册</small></span>'
        : `<img src="${esc(f.cover)}" alt="${esc(f.title)}" loading="lazy" draggable="false">`;
      return `<div class="sa-album-tile${on ? ' is-selected' : ''}${f.draft ? ' is-draft' : ''}"` +
        ` data-sa-album="${esc(f.id)}" tabindex="0" role="button" aria-pressed="${on}"` +
        ` title="${esc(f.title)}（点一下选中，双击编辑资料）">` +
        `<span class="sa-album-cover">${cover}<span class="sa-album-tick">✓</span>` +
        (f.draft ? '' : `<span class="sa-album-count">${Number(f.count) || 1} 张</span>`) +
        `</span>` +
        `<span class="sa-album-name">${esc(String(f.title).slice(0, 16)) || '未命名'}</span>` +
        (f.price ? `<span class="sa-album-price">¥${esc(f.price)}</span>` : '') +
        `</div>`;
    }).join('') || '<p class="sa-empty">没有匹配的商品</p>';

    $('sa-album-page').textContent = `第 ${state.albumPage + 1} / ${pages} 页 · 本页 ${pageItems.length} 个 · 共 ${all.length} 个`;
    $('sa-album-prev').disabled = state.albumPage <= 0;
    $('sa-album-next').disabled = state.albumPage >= pages - 1;
    $('sa-album-selected').textContent = `已选 ${state.albumSelected.size} 个`;
    const can = state.canWrite && isVipActive();
    $('sa-album-delete').disabled = !can || !state.albumSelected.size;
    $('sa-album-edit').disabled = !can || state.albumSelected.size !== 1;

    const checkAll = $('sa-album-check-all');
    const checkedAll = state.albumVisible.length > 0 && state.albumVisible.every((id) => state.albumSelected.has(id));
    checkAll.checked = checkedAll;
    checkAll.indeterminate = !checkedAll && state.albumVisible.some((id) => state.albumSelected.has(id));
  }

  /* 单击单选 / Ctrl/⌘ 切换 / Shift 从锚点连选；连选范围限定在当前可见页 */
  function pickAlbum(id, e) {
    const vis = state.albumVisible || [];
    if (e.shiftKey && vis.includes(state.albumAnchor)) {
      const a = vis.indexOf(state.albumAnchor), b = vis.indexOf(id);
      if (!e.ctrlKey && !e.metaKey) state.albumSelected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) state.albumSelected.add(vis[i]);
    } else if (e.ctrlKey || e.metaKey) {
      if (state.albumSelected.has(id)) state.albumSelected.delete(id);
      else state.albumSelected.add(id);
      state.albumAnchor = id;
    } else {
      const only = state.albumSelected.size === 1 && state.albumSelected.has(id);
      state.albumSelected.clear();
      if (!only) state.albumSelected.add(id);
      state.albumAnchor = id;
    }
    renderAlbums();
  }

  /* ---------- 新建 / 编辑资料弹窗 ---------- */
  function fillCategorySelect(current) {
    const sel = $('sa-am-category');
    const list = state.cats.length ? state.cats : [{ id: 'other', label: '其他' }];
    sel.innerHTML = list.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
    sel.value = current || 'other';
    if (!sel.value) sel.value = 'other';
  }

  function renderAmPreview() {
    $('sa-am-preview').innerHTML = state.amFiles
      .map((d) => `<img src="${esc(d.data)}" alt="">`).join('');
    $('sa-am-files-info').textContent = state.amFiles.length
      ? `已选 ${state.amFiles.length} 张图` : '未选择图片';
  }

  function openAlbumModal(mode, id) {
    const d = id ? albumData(id) : {};
    state.amMode = mode;
    state.amId = mode === 'create' ? '' : id;
    state.amFiles = [];
    const titles = { create: '新建相册', edit: '编辑相册资料', addPhotos: '往相册加图' };
    $('sa-am-title').textContent = titles[mode] || '相册资料';
    $('sa-am-lede').textContent = mode === 'create'
      ? '可以先只填资料建个空相册（客户看不到），以后随时加图；也可以现在就选好几张图一次上架。'
      : mode === 'addPhotos'
        ? '选好几张图一次加进这个相册；空相册加了图就会正式上架。'
        : '改完自动同步线上；这里也能直接往相册里加图。';
    const v = (key) => String(d[key] == null ? '' : d[key]);
    $('sa-am-name').value = v('title');
    $('sa-am-code').value = v('code');
    $('sa-am-price').value = v('price');
    $('sa-am-size').value = v('size');
    $('sa-am-condition').value = v('condition');
    $('sa-am-description').value = v('description');
    $('sa-am-note').value = v('note');
    $('sa-am-newcat').value = '';
    fillCategorySelect(v('category') || 'other');
    $('sa-am-files').value = '';
    renderAmPreview();
    $('sa-am-status').textContent = '';
    $('sa-am-form').dataset.mode = mode;
    $('sa-album-modal').hidden = false;
    try { $('sa-am-name').focus(); } catch { /* noop */ }
  }

  function closeAlbumModal() {
    $('sa-album-modal').hidden = true;
    state.amFiles = [];
  }

  function readAlbumFields() {
    const v = (id) => String(($(id) && $(id).value) || '').trim();
    return {
      title: v('sa-am-name'), code: v('sa-am-code'), price: v('sa-am-price'),
      size: v('sa-am-size'), condition: v('sa-am-condition'),
      category: v('sa-am-category'), newCategory: v('sa-am-newcat'),
      description: String($('sa-am-description').value || '').trim(),
      note: v('sa-am-note')
    };
  }

  function fileToData(file) {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve({ name: file.name || 'photo.jpg', data: String(fr.result || '') });
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(file);
      } catch { resolve(null); }
    });
  }

  async function onAmFilesChange(e) {
    const files = Array.prototype.slice.call(e.target.files || []).slice(0, 20);
    const out = [];
    for (const f of files) {
      const item = await fileToData(f);
      if (item) out.push(item);
    }
    state.amFiles = out;
    renderAmPreview();
  }

  async function submitAlbumModal(e) {
    e.preventDefault();
    if (!writable()) return;
    const save = $('sa-am-save');
    if (save.disabled) return;
    const mode = state.amMode, id = state.amId, imgs = state.amFiles.slice();
    if (mode === 'addPhotos' && !imgs.length) {
      $('sa-am-status').textContent = '请先选几张图片';
      return;
    }
    const fields = readAlbumFields();
    save.disabled = true;
    $('sa-am-status').textContent = '正在保存…';
    try {
      if (mode === 'create') {
        const r = await post('/api/shop-admin/albums', { action: 'create', fields, images: imgs });
        toast('✔ ' + r.message);
      } else {
        if (mode !== 'addPhotos') await post('/api/shop-admin/albums', { action: 'update', id, fields });
        if (imgs.length) await post('/api/shop-admin/albums', { action: 'addPhotos', id, images: imgs });
        toast('✔ ' + (imgs.length ? '资料已保存，图片也加好了' : '资料已保存') + '（正在同步线上）');
      }
      closeAlbumModal();
      state.albumSelected.clear();
      await refresh();
      setTimeout(refresh, 9000);
    } catch (err) {
      $('sa-am-status').textContent = '✖ ' + err.message;
      toast('✖ ' + err.message, 'warn');
    }
    save.disabled = false;
  }

  /* ---------- 右键菜单 ---------- */
  function hideAlbumMenu() { const m = $('sa-album-menu'); if (m) m.hidden = true; }

  function showAlbumMenu(id, x, y) {
    const m = $('sa-album-menu');
    if (!m) return;
    m.innerHTML = [
      ['edit', '✎ 编辑资料'], ['add', '📷 加图片'], ['delete', '🗑 删除这个相册']
    ].map(([act, label]) =>
      `<button type="button" data-am-act="${act}" data-id="${esc(id)}">${label}</button>`
    ).join('');
    m.hidden = false;
    const w = m.offsetWidth || 180, h = m.offsetHeight || 132;
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 8)) + 'px';
  }

  async function deleteAlbumSelection() {
    if (!writable()) return;
    const ids = [...state.albumSelected];
    if (!ids.length) { toast('请先点选要删除的相册', 'warn'); return; }
    const drafts = ids.filter((id) => state.drafts[id]);
    const real = ids.filter((id) => !state.drafts[id]);
    const parts = [];
    if (drafts.length) parts.push(`${drafts.length} 个空相册`);
    if (real.length) parts.push(`${real.length} 个商品框（图片移到本机回收站，可找回）`);
    if (!confirm(`确定删除${parts.join('、')}吗？`)) return;
    try {
      const msgs = [];
      for (const id of drafts) {
        const r = await post('/api/shop-admin/albums', { action: 'delete', id });
        msgs.push(r.message);
      }
      if (real.length) {
        const r = await post('/api/shop-admin/delete-frames', { frames: real });
        msgs.push(r.message);
      }
      state.albumSelected.clear();
      toast('✔ ' + msgs.join('；'));
      await refresh();
      setTimeout(refresh, 9000);
    } catch (e) { toast('✖ ' + e.message, 'warn'); }
  }

  function renderNavCats() {
    const q = ($('sa-nav-cat-search').value || '').trim().toLowerCase();
    const list = state.cats.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
    $('sa-nav-cat-list').innerHTML = list.map((c) => {
      const n = state.frames.filter((f) => f.category === c.id).length;
      return `<button class="sa-nav-cat" type="button" data-sa-cat="${esc(c.id)}">` +
        `${esc(c.label)}<span>(${n})</span></button>`;
    }).join('') || '<p class="sa-empty">没有匹配的分类</p>';
  }

  /* 点分类名称 → 显示「当前名称下的所有图片」：缩略图网格 + 张数角标 +
     勾选（可归类）+ 全选本页 + 分页。以前只有文字列表且截断到前 60 个。 */
  function catFrames(id) { return state.frames.filter((f) => f.category === id); }

  function catPageIds() {
    if (!state.activeCat) return [];
    const frames = catFrames(state.activeCat);
    const pages = Math.max(1, Math.ceil(frames.length / CAT_PAGE_SIZE));
    state.catPage = Math.min(Math.max(0, state.catPage), pages - 1);
    return frames.slice(state.catPage * CAT_PAGE_SIZE, (state.catPage + 1) * CAT_PAGE_SIZE).map((f) => f.id);
  }

  function writeNote() {
    const n = $('sa-album-note');
    if (!n) return;
    n.textContent = state.canWrite && isVipActive()
      ? '点图选中 · Ctrl/⌘ 多选 · Shift 连选 · 双击编辑 · 右键更多 · 「全选」选本页'
      : '⚠ 新建 / 编辑 / 删除需要店家电脑上的上传台在线（当前只读），恢复后自动可用';
  }

  function syncCatControls() {
    const del = $('sa-cat-delete');
    if (del) del.disabled = !state.selected.size || !state.canWrite || !isVipActive();
    writeNote();
    const all = $('sa-cat-check-all');
    if (all) {
      const ids = catPageIds();
      all.checked = ids.length > 0 && ids.every((id) => state.selected.has(id));
      all.indeterminate = !all.checked && ids.some((id) => state.selected.has(id));
    }
    const n = $('sa-selected-count');
    if (n) n.textContent = `已勾选 ${state.selected.size} 个商品`;
  }

  function renderCats() {
    const q = ($('sa-cat-search').value || '').trim().toLowerCase();
    const list = state.cats.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
    const box = $('sa-cat-list');
    box.innerHTML = list.map((c) => {
      const custom = Boolean(state.customCats[c.id]);
      const open = state.openCats.has(c.id);
      const frames = catFrames(c.id);
      let inner = '';
      if (open) {
        const pages = Math.max(1, Math.ceil(frames.length / CAT_PAGE_SIZE));
        state.catPage = Math.min(Math.max(0, state.catPage), pages - 1);
        const page = frames.slice(state.catPage * CAT_PAGE_SIZE, (state.catPage + 1) * CAT_PAGE_SIZE);
        const tiles = page.map((f) => {
          const on = state.selected.has(f.id);
          return `<label class="sa-cat-tile${on ? ' is-selected' : ''}" title="${esc(f.title)}">` +
            `<input type="checkbox" data-frame="${esc(f.id)}"${on ? ' checked' : ''}>` +
            `<img src="${esc(f.cover)}" alt="${esc(f.title)}" loading="lazy">` +
            `<span class="sa-cat-badge">${Number(f.count) || 1} 张</span>` +
            `<span class="sa-cat-tile-name">${esc(String(f.title || f.id).slice(0, 14))}</span>` +
            (f.price ? `<span class="sa-cat-tile-price">¥${esc(f.price)}</span>` : '') +
            `</label>`;
        }).join('');
        const pager = `<div class="sa-cat-pager">` +
          `<button class="sa-mini" type="button" data-cat-page="prev"${state.catPage <= 0 ? ' disabled' : ''}>← 上一页</button>` +
          `<span>第 ${state.catPage + 1} / ${pages} 页 · 共 ${frames.length} 个商品</span>` +
          `<button class="sa-mini" type="button" data-cat-page="next"${state.catPage >= pages - 1 ? ' disabled' : ''}>下一页 →</button>` +
          `</div>`;
        inner = `<div class="sa-frames">` +
          `<div class="sa-cat-bar">` +
          `<strong>📂 ${esc(c.label)}</strong><span>共 ${frames.length} 个商品 · ${frames.reduce((n, f) => n + (Number(f.count) || 1), 0)} 张图</span>` +
          `<label class="sa-check-all"><input id="sa-cat-check-all" type="checkbox"> 全选本页</label>` +
          `<button id="sa-cat-delete" class="sa-btn sa-btn-danger" type="button" disabled>🗑 删除选中</button>` +
          `</div>` +
          (tiles ? `<div class="sa-cat-grid">${tiles}</div>` : '<p class="sa-empty">这个分类还没有商品</p>') +
          pager + `</div>`;
      }
      return `<div class="sa-cat${open ? ' is-open' : ''}${state.activeCat === c.id ? ' is-current' : ''}">` +
        `<div class="sa-cat-row">` +
        `<button class="sa-cat-name" type="button" data-open="${esc(c.id)}">${open ? '▾' : '▸'} ${esc(c.label)}<span>(${frames.length})</span></button>` +
        (custom
          ? `<button class="sa-mini" type="button" data-rename="${esc(c.id)}">改名</button>` +
            `<button class="sa-mini sa-mini-danger" type="button" data-del="${esc(c.id)}">删除</button>`
          : '<span class="sa-builtin">内置</span>') +
        `</div>` + inner + `</div>`;
    }).join('') || '<p class="sa-empty">没有匹配的分类</p>';
    // 有展开的分类时去掉高度限制，图片墙才能完整铺开
    box.classList.toggle('has-open', Boolean(state.openCats.size));
    syncCatControls();

    const opts = state.cats.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
    $('sa-assign-cat').innerHTML = opts;
    $('sa-scope-cat').innerHTML = opts;
    $('sa-selected-count').textContent = `已勾选 ${state.selected.size} 个商品`;
  }

  function renderVip() {
    $('sa-vip-until').textContent = state.vip.expiresAt || '—';
    const active = isVipActive();
    $('sa-vip-state').textContent = active
      ? '✅ 权益生效中 · 后台全部功能可用'
      : '⚠ 权益已到期，点「续费一个季度」解锁管理功能';
    $('sa-vip-state').className = 'sa-vip-state ' + (active ? 'is-ok' : 'is-off');
    const rs = Array.isArray(state.vip.renewals) ? state.vip.renewals : [];
    $('sa-vip-records').innerHTML = rs.length
      ? rs.slice().reverse().map((r) =>
        `<div class="sa-record"><span>${esc(r.at)} 续费</span><span>¥${esc(r.amount)}</span><span>权益至 ${esc(r.until)}</span></div>`
      ).join('')
      : '<p class="sa-empty">还没有续费记录</p>';
  }

  function gateAll() {
    const can = state.canWrite && isVipActive();
    ['sa-cat-new', 'sa-nav-cat-create', 'sa-assign', 'sa-preview'].forEach((id) => { const e = $(id); if (e) e.disabled = !can; });
    $('sa-apply').disabled = !can || !state.preview.length;
    $('sa-vip-renew').disabled = !state.canWrite;
    if ($('sa-album-delete')) $('sa-album-delete').disabled = !can || !state.albumSelected.size;
    if ($('sa-album-edit')) $('sa-album-edit').disabled = !can || state.albumSelected.size !== 1;
    if ($('sa-album-create')) $('sa-album-create').disabled = !can;
    if ($('sa-cat-delete')) $('sa-cat-delete').disabled = !can || !state.selected.size;
    writeNote();
    if ($('sa-trash-list')) syncTrashControls();
  }

  function writable() {
    if (!state.canWrite) { toast('没连上店家电脑：创建 / 改价 / 续费要在店家电脑上打开后台', 'warn'); return false; }
    if (!isVipActive()) { toast('VIP 权益已到期，请先点「续费一个季度」', 'warn'); return false; }
    return true;
  }

  function numberIn(s) {
    const n = Number(String(s || '').replace(/[^\d.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }

  function computePreview() {
    const scope = $('sa-scope').value;
    let list = state.frames;
    if (scope === 'category') list = list.filter((f) => f.category === $('sa-scope-cat').value);
    else if (scope === 'selected') list = list.filter((f) => state.selected.has(f.id));
    else if (scope === 'keyword') {
      const k = ($('sa-scope-kw').value || '').trim().toLowerCase();
      if (!k) return { error: '请填要匹配的编号或名称关键词' };
      list = list.filter((f) => (f.title + ' ' + f.code).toLowerCase().includes(k));
    }
    const raw = ($('sa-amount').value || '').trim();
    const v = Number(raw);
    if (raw === '' || !isFinite(v)) return { error: '请填正确的数值，例如 320 或 10' };
    const mode = $('sa-mode').value;
    if (!list.length) return { error: '这个范围内没有商品，换个范围试试' };
    const suffixOf = (p) => (/元/.test(String(p || '')) ? '元' : '');
    const changes = list.map((f) => {
      const old = numberIn(f.price);
      let n;
      if (mode === 'set') n = v;
      else if (mode === 'add') n = old + v;
      else if (mode === 'sub') n = old - v;
      else n = old * (1 + v / 100); // 填 10 表示上调 10%，填 -10 表示下调 10%
      n = Math.max(0, Math.round(n * 100) / 100);
      const to = String(n) + suffixOf(f.price);
      return { id: f.id, title: f.title, from: f.price || '—', to, price: to };
    });
    return { changes };
  }

  function renderPreview() {
    const r = computePreview();
    if (r.error) { toast(r.error, 'warn'); state.preview = []; $('sa-preview-box').hidden = true; gateAll(); return; }
    state.preview = r.changes;
    $('sa-preview-box').hidden = false;
    $('sa-preview-box').innerHTML =
      `<p>将改 <strong>${r.changes.length}</strong> 个商品的价格：</p>` +
      r.changes.slice(0, 8).map((c) =>
        `<div class="sa-pv-row"><span>${esc(String(c.title).slice(0, 30))}</span><b>${esc(c.from)} → ${esc(c.to)}</b></div>`
      ).join('') +
      (r.changes.length > 8 ? `<p class="sa-more">…还有 ${r.changes.length - 8} 个</p>` : '');
    $('sa-price-status').textContent = '确认无误后再点「确认改价并发布」';
    gateAll();
  }

  async function refresh() {
    try {
      await load(); renderCats(); renderNavCats(); renderVip();
      renderHome(); renderAlbums(); gateAll();
    } catch (e) { toast('刷新失败：' + e.message, 'warn'); }
  }

  async function afterWrite(msg, clearPreview) {
    toast('✔ ' + msg + '（自动同步线上，约 1～3 分钟）');
    if (clearPreview) { state.preview = []; $('sa-preview-box').hidden = true; $('sa-price-status').textContent = ''; }
    setTimeout(refresh, 9000);
  }

  function bind() {
    $('sa-toggle').addEventListener('click', () => {
      const body = $('sa-body'), open = body.hidden;
      body.hidden = !open;
      $('sa-toggle').textContent = open ? '收起 ▴' : '展开 ▾';
      $('sa-toggle').setAttribute('aria-expanded', String(open));
    });
    $('sa-cat-fold').addEventListener('click', () => {
      const inner = $('sa-cat-inner'), open = inner.hidden;
      inner.hidden = !open;
      $('sa-cat-fold').textContent = open ? '收起列表' : '展开列表';
    });
    $('sa-cat-search').addEventListener('input', renderCats);

    $('sa-cat-new').addEventListener('click', () => {
      if (!writable()) return;
      $('sa-cat-form').hidden = false;
      $('sa-cat-name').value = '';
      $('sa-cat-name').focus();
    });
    $('sa-cat-cancel').addEventListener('click', () => { $('sa-cat-form').hidden = true; });
    $('sa-cat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!writable()) return;
      const label = ($('sa-cat-name').value || '').trim();
      if (!label) { toast('请先填分类名', 'warn'); return; }
      state.busy = true;
      try {
        const r = await post('/api/shop-admin/categories', { action: 'create', label });
        $('sa-cat-form').hidden = true;
        await afterWrite(r.message, true);
      } catch (err) { toast('✖ ' + err.message, 'warn'); }
      state.busy = false;
    });

    $('sa-cat-list').addEventListener('click', async (e) => {
      const opener = e.target.closest('[data-open]');
      if (opener) {
        const id = opener.dataset.open;
        const closing = state.openCats.has(id) && state.activeCat === id;
        // 一次只展开一个分类：点开的那个就是「当前分类」，图片墙跟着切换
        state.openCats.clear();
        if (!closing) { state.openCats.add(id); state.activeCat = id; }
        else state.activeCat = '';
        state.catPage = 0;
        renderCats();
        return;
      }
      const pager = e.target.closest('[data-cat-page]');
      if (pager) {
        state.catPage += pager.dataset.catPage === 'next' ? 1 : -1;
        renderCats();
        return;
      }
      const ren = e.target.closest('[data-rename]');
      if (ren) {
        if (!writable()) return;
        const id = ren.dataset.rename;
        const label = prompt('把分类改成什么名字？', state.customCats[id] || '');
        if (!label || !label.trim() || label.trim() === state.customCats[id]) return;
        try {
          const r = await post('/api/shop-admin/categories', { action: 'rename', id, label: label.trim() });
          await afterWrite(r.message, true);
        } catch (err) { toast('✖ ' + err.message, 'warn'); }
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        if (!writable()) return;
        const id = del.dataset.del;
        if (!confirm(`确定删除「${state.customCats[id]}」分类吗？里面的商品会自动移到「其他」，图片不会丢。`)) return;
        try {
          const r = await post('/api/shop-admin/categories', { action: 'delete', id });
          await afterWrite(r.message, true);
        } catch (err) { toast('✖ ' + err.message, 'warn'); }
      }
    });
    $('sa-cat-list').addEventListener('change', (e) => {
      const all = e.target.closest('#sa-cat-check-all');
      if (all) {
        catPageIds().forEach((id) => { if (all.checked) state.selected.add(id); else state.selected.delete(id); });
        renderCats();
        return;
      }
      const box = e.target.closest('input[data-frame]');
      if (!box) return;
      const id = box.dataset.frame;
      if (box.checked) state.selected.add(id); else state.selected.delete(id);
      syncCatControls();
    });
    $('sa-cat-list').addEventListener('click', async (e) => {
      const del = e.target.closest('#sa-cat-delete');
      if (!del || del.disabled) return;
      if (!writable()) return;
      const ids = [...state.selected];
      if (!ids.length) { toast('请先勾选要删除的商品', 'warn'); return; }
      if (!confirm(`确定删除选中的 ${ids.length} 个商品框吗？\n图片会移到本机回收站，随时可以找回。`)) return;
      try {
        const r = await post('/api/shop-admin/delete-frames', { frames: ids });
        state.selected.clear();
        toast('✔ ' + r.message);
        await refresh();
        renderCats();
      } catch (err) { toast('✖ ' + err.message, 'warn'); }
    });

    $('sa-clear-sel').addEventListener('click', () => {
      state.selected.clear(); renderCats();
    });
    $('sa-assign').addEventListener('click', async () => {
      if (!writable()) return;
      if (!state.selected.size) { toast('先在分类里展开并勾选商品', 'warn'); return; }
      const id = $('sa-assign-cat').value;
      if (!confirm(`把勾选的 ${state.selected.size} 个商品移到「${(state.cats.filter((c) => c.id === id)[0] || {}).label || id}」分类吗？`)) return;
      try {
        const r = await post('/api/shop-admin/categories', { action: 'assign', id, ids: [...state.selected] });
        await afterWrite(r.message, true);
      } catch (err) { toast('✖ ' + err.message, 'warn'); }
    });

    $('sa-scope').addEventListener('change', () => {
      const v = $('sa-scope').value;
      $('sa-scope-cat-wrap').hidden = v !== 'category';
      $('sa-scope-kw-wrap').hidden = v !== 'keyword';
      state.preview = []; $('sa-preview-box').hidden = true; gateAll();
    });
    ['sa-mode', 'sa-amount', 'sa-scope-kw', 'sa-scope-cat'].forEach((id) => {
      $(id).addEventListener('input', () => { state.preview = []; $('sa-preview-box').hidden = true; gateAll(); });
    });
    $('sa-preview').addEventListener('click', () => { if (writable()) renderPreview(); });
    $('sa-apply').addEventListener('click', async () => {
      if (!writable()) return;
      if (!state.preview.length) { toast('请先点「预览改动」', 'warn'); return; }
      if (!confirm(`确定把 ${state.preview.length} 个商品改价吗？改完会自动同步到线上相册。`)) return;
      $('sa-apply').disabled = true;
      try {
        const r = await post('/api/shop-admin/bulk-price', {
          changes: state.preview.map((c) => ({ id: c.id, price: c.price }))
        });
        $('sa-price-status').textContent = r.message;
        await afterWrite(r.message, true);
      } catch (err) { toast('✖ ' + err.message, 'warn'); }
      gateAll();
    });

    $('sa-vip-renew').addEventListener('click', async () => {
      if (!state.canWrite) { toast('续费要在店家电脑上打开后台才能记', 'warn'); return; }
      if (!confirm('记一次「全能 VIP」续费：¥300 / 季度，权益延长 90 天。\n这只是店内权益记录，不会扣款、不代收款。继续吗？')) return;
      try {
        const r = await post('/api/shop-admin/vip', { action: 'renew' });
        state.vip.expiresAt = r.expiresAt;
        renderVip();
        await afterWrite(r.message, false);
      } catch (err) { toast('✖ ' + err.message, 'warn'); }
    });
    $('sa-vip-log').addEventListener('click', () => {
      const box = $('sa-vip-records');
      box.hidden = !box.hidden;
      $('sa-vip-log').textContent = box.hidden ? '消费详情' : '收起详情';
    });

    /* ---------- 左侧导航交互 ---------- */
    const openLink = (url) => { try { window.open(url, '_blank', 'noopener'); } catch { /* 浏览器拦截就忽略 */ } };
    /* 左侧「分类」平时保持折叠，不让一长串分类常驻占满导航。
       只有点右边的「管理」才展开；切换导航 / 选中某个分类后自动收回。 */
    const setNavCatsOpen = (open) => {
      const box = $('sa-nav-cat-box');
      if (!box) return;
      box.hidden = !open;
      $('sa-nav-cat-manage').textContent = open ? '管理 ▴' : '管理 ▾';
      const toggle = $('sa-nav-cat-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', String(open));
    };

    document.querySelectorAll('.sa-nav-item[data-sa-view]').forEach((b) => {
      b.addEventListener('click', () => {
        switchView(b.dataset.saView);
        setNavCatsOpen(false);
      });
    });
    $('sa-nav-cat-manage').addEventListener('click', (e) => {
      e.stopPropagation();
      setNavCatsOpen($('sa-nav-cat-box').hidden);
    });
    $('sa-nav-cat-search').addEventListener('input', () => {
      $('sa-cat-search').value = $('sa-nav-cat-search').value;
      renderNavCats();
      renderCats();
    });
    $('sa-nav-cat-create').addEventListener('click', () => {
      if (!writable()) return;
      switchView('cats');
      setNavCatsOpen(true);
      $('sa-cat-form').hidden = false;
      $('sa-cat-name').value = '';
      try { $('sa-cat-name').focus(); } catch { /* noop */ }
    });
    $('sa-nav-cat-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sa-cat]');
      if (!b) return;
      switchView('cats');
      state.openCats.clear();
      state.openCats.add(b.dataset.saCat);
      state.activeCat = b.dataset.saCat;
      state.catPage = 0;
      if ($('sa-cat-search')) $('sa-cat-search').value = '';
      renderCats();
      setNavCatsOpen(false);
      try { $('sa-cat-list').scrollIntoView({ block: 'nearest' }); } catch { /* noop */ }
    });
    document.querySelectorAll('[data-sa-go]').forEach((b) => {
      b.addEventListener('click', () => {
        const go = b.dataset.saGo;
        const map = {
          folder: 'orders-folder-import', pay: 'orders-pay', access: 'orders-access',
          export: 'orders-export', refresh: 'orders-refresh'
        };
        if (go === 'price') { switchView('tools'); return; }
        const target = $(map[go]);
        if (target) target.click();
        else toast('这个入口要在店家电脑上打开后台才用得了', 'warn');
      });
    });
    $('sa-go-upload').addEventListener('click', () => openLink(CONSOLE));
    $('sa-go-share').addEventListener('click', () => {
      const u = new URL('./', location.href);
      u.search = '?sharecode=' + (new URLSearchParams(location.search).get('sharecode') || '');
      openLink(u.toString());
    });
    $('sa-album-open').addEventListener('click', () => openLink('./'));
    $('sa-album-upload').addEventListener('click', () => openLink(CONSOLE));

    /* ---------- 相册：无小勾框，点图选中 + 快捷键多选 + 全选 + 右键菜单 ---------- */
    const grid = $('sa-album-grid');
    grid.addEventListener('click', (e) => {
      const tile = e.target.closest('[data-sa-album]');
      if (!tile) return;
      hideAlbumMenu();
      pickAlbum(tile.dataset.saAlbum, e);
    });
    grid.addEventListener('dblclick', (e) => {
      const tile = e.target.closest('[data-sa-album]');
      if (!tile) return;
      hideAlbumMenu();
      if (!writable()) return;
      openAlbumModal('edit', tile.dataset.saAlbum);
    });
    grid.addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('[data-sa-album]');
      if (!tile) return;
      e.preventDefault();
      const id = tile.dataset.saAlbum;
      if (!state.albumSelected.has(id)) {
        state.albumSelected.clear();
        state.albumSelected.add(id);
        state.albumAnchor = id;
        renderAlbums();
      }
      showAlbumMenu(id, e.clientX, e.clientY);
    });
    grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tile = e.target.closest('[data-sa-album]');
      if (!tile) return;
      e.preventDefault();
      pickAlbum(tile.dataset.saAlbum, e);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#sa-album-menu')) hideAlbumMenu();
    });
    window.addEventListener('blur', hideAlbumMenu);
    window.addEventListener('scroll', hideAlbumMenu, true);

    $('sa-album-menu').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-am-act]');
      if (!b) return;
      const id = b.dataset.id, act = b.dataset.amAct;
      hideAlbumMenu();
      if (!writable()) return;
      if (act === 'edit') openAlbumModal('edit', id);
      else if (act === 'add') {
        state.albumSelected.clear(); state.albumSelected.add(id);
        renderAlbums();
        openAlbumModal('addPhotos', id);
      } else if (act === 'delete') {
        state.albumSelected.clear(); state.albumSelected.add(id);
        await deleteAlbumSelection();
      }
    });

    $('sa-album-create').addEventListener('click', () => { if (writable()) openAlbumModal('create', ''); });
    $('sa-album-edit').addEventListener('click', () => {
      if (!writable()) return;
      const one = [...state.albumSelected][0];
      if (one) openAlbumModal('edit', one);
    });
    $('sa-album-check-all').addEventListener('change', (e) => {
      (state.albumVisible || []).forEach((id) => {
        if (e.target.checked) state.albumSelected.add(id);
        else state.albumSelected.delete(id);
      });
      renderAlbums();
    });
    $('sa-album-delete').addEventListener('click', deleteAlbumSelection);
    $('sa-album-prev').addEventListener('click', () => { state.albumPage -= 1; renderAlbums(); });
    $('sa-album-next').addEventListener('click', () => { state.albumPage += 1; renderAlbums(); });
    $('sa-album-search').addEventListener('input', (e) => {
      state.albumQuery = String(e.target.value || '');
      state.albumPage = 0;
      renderAlbums();
    });

    /* ---------- 新建 / 编辑资料弹窗 ---------- */
    $('sa-am-close').addEventListener('click', closeAlbumModal);
    $('sa-am-cancel').addEventListener('click', closeAlbumModal);
    $('sa-album-modal').addEventListener('click', (e) => {
      if (e.target.id === 'sa-album-modal') closeAlbumModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('sa-album-modal').hidden) closeAlbumModal();
    });
    $('sa-am-form').addEventListener('submit', submitAlbumModal);
    $('sa-am-files').addEventListener('change', onAmFilesChange);

    /* ---------- 回收站交互：勾选 / 恢复 / 永久删除 / 清空 ---------- */
    $('sa-trash-restore').addEventListener('click', () => doTrash('restore'));
    $('sa-trash-purge').addEventListener('click', () => doTrash('purge'));
    $('sa-trash-empty').addEventListener('click', () => doTrash('empty'));
    $('sa-trash-list').addEventListener('change', (e) => {
      const box = e.target.closest('input[data-trash]');
      if (!box) return;
      if (box.checked) state.trashSelected.add(box.dataset.trash);
      else state.trashSelected.delete(box.dataset.trash);
      syncTrashControls();
    });
  }

  /* 上传台临时没起来时，后台不用刷新页面也能自己连回来（分类 / VIP / 改价 / 回收站） */
  let reconnectTimer = null;
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      try {
        await load();
        renderVip();
        gateAll();
        if (state.view === 'trash') await loadTrash();
        if ($('sa-status')) $('sa-status').textContent = baseStatus();
      } catch { /* 下一轮继续试 */ }
      if (!state.canWrite) scheduleReconnect();
    }, 6000);
  }

  async function boot() {
    if (!$('shop-admin')) return;
    try { await load(); }
    catch (e) {
      $('sa-status').textContent = '商品数据读取失败：' + e.message;
      scheduleReconnect();
      return;
    }
    renderCats();
    renderNavCats();
    renderVip();
    bind();
    switchView('home');
    gateAll();
    $('sa-status').textContent = baseStatus();
    if (!state.canWrite) scheduleReconnect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
