/* 简白图库 —— 纯前端、无依赖。
   数据来源：photos/manifest.json（由 scripts/build-manifest.mjs 生成）
   支持任意数量素材、图片 / 视频、搜索、分类筛选与「每页 120 个框」翻页。
   「商品框」：一个格子＝一个商品，可装多张图；点开框先看到框内全部缩略图，点单张再看大图。
   本机上传台就绪时直接在本页完成上传、编辑资料与发布。 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  /* 2026-11-13：店家要求每页固定 120 个产品框。
     不再按屏幕宽度换算列数，手机 3 列＝40 行、桌面 8 列＝15 行，翻页位置在所有设备上一致。 */
  const PAGE_SIZE = 120;
  const LAYOUTS = ['dense', 'grid', 'masonry', 'large'];
  const VIDEO_EXT = new Set(['MP4', 'WEBM', 'M4V', 'OGV']);
  const CONSOLE = 'http://127.0.0.1:3210';

  const el = {
    toolbar: $('toolbar'),
    search: $('search'),
    layouts: $('layouts'),
    filters: $('filters'),
    formatFilters: $('format-filters'),
    catWrap: $('cat-wrap'),
    catToggle: $('cat-toggle'),
    catToggleLabel: $('cat-toggle-label'),
    catPanel: $('cat-panel'),
    catPanelList: $('cat-panel-list'),
    gallery: $('gallery'),
    pager: $('pager'),
    pagePrev: $('page-prev'),
    pageNext: $('page-next'),
    pageInfo: $('page-info'),
    empty: $('empty'),
    emptyReason: $('empty-reason'),
    total: $('total'),
    mediaSummary: $('media-summary'),
    builtAt: $('built-at'),
    formatsNote: $('formats-note'),
    lightbox: $('lightbox'),
    lbImg: $('lb-img'),
    lbVideo: $('lb-video'),
    lbTitle: $('lb-title'),
    lbMeta: $('lb-meta'),
    lbCount: $('lb-count'),
    lbPrev: $('lb-prev'),
    lbNext: $('lb-next'),
    lbClose: $('lb-close'),
    lbAdd: $('lb-add'),
    lbDelete: $('lb-delete'),
    confirmPanel: $('confirm-panel'),
    confirmTitle: $('confirm-title'),
    confirmText: $('confirm-text'),
    confirmOk: $('confirm-ok'),
    confirmCancel: $('confirm-cancel'),
    confirmStatus: $('confirm-status'),
    uploadPanel: $('upload-panel'),
    openUpload: $('open-upload'),
    openOrders: $('open-orders'),
    uploadPanelClose: $('upload-panel-close'),
    consoleState: $('console-state'),
    galleryFile: $('gallery-file'),
    uploadToast: $('upload-toast'),
    lbEdit: $('lb-edit'),
    lbDetail: $('lb-detail'),
    editPanel: $('edit-panel'),
    editForm: $('edit-form'),
    editClose: $('edit-close'),
    editCancel: $('ed-cancel'),
    editSave: $('ed-save'),
    editAddPic: $('ed-addpic'),
    editStatus: $('ed-status'),
    edCode: $('ed-code'),
    edTitle: $('ed-title'),
    edPrice: $('ed-price'),
    edSize: $('ed-size'),
    edCondition: $('ed-condition'),
    edCategory: $('ed-category'),
    edNewCat: $('ed-newcat'),
    edDescription: $('ed-description'),
    edNote: $('ed-note'),
    frameDetail: $('frame-detail'),
    fdBack: $('fd-back'),
    fdClose: $('fd-close'),
    fdCounter: $('fd-counter'),
    fdCover: $('fd-cover'),
    fdTitle: $('fd-title'),
    fdSub: $('fd-sub'),
    fdFields: $('fd-fields'),
    fdPrice: $('fd-price'),
    fdDesc: $('fd-desc'),
    fdGrid: $('fd-grid'),
    fdAdd: $('fd-add'),
    fdEdit: $('fd-edit'),
    fdDeleteFrame: $('fd-delete-frame'),
    fdDensity: $('fd-density'),
    fdAddCart: $('fd-add-cart'),
    lbAddCart: $('lb-add-cart')
  };

  const state = {
    photos: [],          // 全部素材（统计 / 格式筛选用）
    frames: [],          // 全部商品框
    all: [],             // 筛选后的框
    view: [],            // 当前页的框
    filter: 'all',
    format: 'all',
    query: '',
    layout: 'dense',
    page: 1,
    frameIndex: 0,       // 灯箱当前打开的框
    frameCursor: 0,      // 框内第几张图
    detailFrame: null,   // 详情页当前展示的商品框
    detailIndex: 0,      // 该框在当前页的位置
    detailCursor: 0,     // 详情页当前选中的缩略图
    detailLarge: false,  // 详情页缩略图放大模式
    lightboxFromDetail: false, // 大图是否从详情页打开（只在框内翻页）
    returnToDetail: null,// 上传 / 保存资料后要回到的框 id
    lastFocus: null,
    canUpload: false,
    uploading: false,
    pendingFrame: 'new',
    pendingCategory: 'auto',
    categoryFilters: [],
    editingFrame: null,
    saving: false,
    pendingDelete: null, // { kind, path, payload, label, returnToDetail }
    deleting: false
  };

  // 线上地址是静态快照：本机删完图后远端索引仍是旧的，改用内存里的新状态立刻刷新。
  const REMOTE_SNAPSHOT = window.location.protocol === 'https:'
    && !/^(127\.0\.0\.1|localhost)$/.test(window.location.hostname);

  const esc = (str) =>
    String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 版式切换已下线：固定用 8 列密集网格（手机 3 列），忽略历史 localStorage 里存过的其它版式。
  state.layout = 'dense';

  function guessExt(file) {
    const m = /\.([a-z0-9]+)$/i.exec(file || '');
    return m ? m[1].toUpperCase().replace('JPEG', 'JPG') : 'FILE';
  }

  function formatSize(n) {
    if (!n || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
  }

  /* 每页固定 120 个产品框，手机 / 平板 / 电脑都一样 */
  function pageSize() {
    return PAGE_SIZE;
  }

  function scrollTop() {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* 测试环境不支持滚动 */ }
  }

  init();

  const cartLabel = (n) => (n ? `＋ 加入选购清单（已加 ${n} 件）` : '＋ 加入选购清单');

  // 购物车数量变化时只改按钮文字，不重绘缩略图（避免跳掉滚动位置 / 焦点）
  function refreshCartButtons() {
    const cart = window.GalleryCart;
    if (!cart) return;
    const frame = state.detailFrame || state.view[state.frameIndex];
    const n = frame ? cart.qtyOf(frame.id) : 0;
    if (el.fdAddCart) el.fdAddCart.textContent = cartLabel(n);
    if (el.lbAddCart) el.lbAddCart.textContent = cartLabel(n);
  }

  /* coverOverride：客户看着哪一张图点的加购，选购清单里就显示哪一张，
     不再固定用整个框的第一张拼图，清单和刚才看到的保持一致。 */
  async function addFrameToCart(frame, coverOverride) {
    if (!frame || !window.GalleryCart) return;
    const item = coverOverride ? { ...frame, cover: coverOverride } : frame;
    const r = await window.GalleryCart.add(item, 1);
    toast(r.ok
      ? '✔ 已加入选购清单 · 点右上 🛒 看合计'
      : `✖ ${esc(r.message || '加入失败，请稍后重试')}`, r.ok ? 'ok' : 'warn');
  }

  async function init() {
    // 浏览器表单自动填充会把店家后台登录时用过的账号（例如「米兰」）塞进搜索框，
    // 结果所有商品都被过滤掉，页面只剩「没有匹配的素材」。这里彻底挡住它：
    // 换掉 name + autocomplete=new-password 让浏览器不再按字段匹配，页面加载
    // 前后再清几次；只有用户真的敲过键盘/点过输入框才不清，避免误删主动搜索。
    let userTyped = false;
    /* 只有真的敲了键盘才算店家主动搜索。以前点一下搜索框就打上标记，
       之后浏览器再自动填充账号名就再也不敢清，结果「米兰」一直留在框里。 */
    el.search.addEventListener('keydown', () => { userTyped = true; }, true);
    el.search.addEventListener('input', (e) => {
      if (e.isTrusted && e.inputType && /^insert/.test(e.inputType)) userTyped = true;
    }, true);
    const clearAutofill = () => {
      if (userTyped || !el.search.value) return;
      el.search.value = '';
      state.query = '';
      try { render(); } catch { /* 索引还没加载完，稍后 loadManifest 会自己渲染 */ }
    };
    clearAutofill();
    [0, 100, 300, 600, 1000, 1600, 2400, 3500, 5000].forEach((ms) => setTimeout(clearAutofill, ms));
    window.addEventListener('load', clearAutofill);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) clearAutofill(); });

    bindEvents();
    applyLayout(state.layout);
    probeConsole();          // 后台探测本机上传台，不阻塞相册渲染
    if (window.GalleryCart && window.GalleryCart.onChange) {
      window.GalleryCart.onChange(refreshCartButtons);
    }
    await loadManifest();
  }

  async function loadManifest() {
    let manifest;
    try {
      const res = await fetch(`./photos/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      showEmpty(`读取相册索引失败：${err.message}。通常是还没执行 npm run build，或者直接双击打开了 index.html（需要通过 http:// 访问）。`);
      return false;
    }
    applyManifest(manifest);
    return true;
  }

  function normalizePhoto(p, fallback) {
    const file = p.file || p.src || '';
    const ext = String(p.ext || guessExt(file)).toUpperCase();
    return {
      ...p,
      file,
      ext,
      type: p.type || (VIDEO_EXT.has(ext) ? 'video' : 'image'),
      category: p.category || (fallback && fallback.category) || 'other',
      categoryLabel: p.categoryLabel || (fallback && fallback.categoryLabel) || '其他'
    };
  }

  function makeFrame(f) {
    const photos = (f.photos || []).map((p) => normalizePhoto(p, f));
    const head = photos[0];
    return {
      id: f.id || f.cover || (head && head.src) || '',
      title: f.title || (head && head.title) || '未命名商品',
      cover: f.cover || (head && head.src) || '',
      count: photos.length,
      category: f.category || (head && head.category) || 'other',
      categoryLabel: f.categoryLabel || (head && head.categoryLabel) || '其他',
      detail: f.detail || {},
      photos,
      exts: [...new Set(photos.map((p) => p.ext))],
      types: [...new Set(photos.map((p) => p.type))],
      searchText: [f.title, f.categoryLabel, f.detail && f.detail.code,
        f.detail && f.detail.description, f.detail && f.detail.note]
        .concat(photos.map((p) => `${p.title} ${p.file} ${p.ext} ${p.categoryLabel}`))
        .join(' ').toLowerCase()
    };
  }

  function applyManifest(manifest) {
    const categories = Array.isArray(manifest.categories) ? manifest.categories : [];
    state.categoryFilters = Array.isArray(manifest.categoryFilters) ? manifest.categoryFilters : [];
    state.categories = categories;
    state.photos = [];
    categories.forEach((cat) => {
      (cat.photos || []).forEach((p) => {
        state.photos.push(normalizePhoto(p, { category: cat.id, categoryLabel: cat.label || cat.id }));
      });
    });

    const raw = Array.isArray(manifest.frames) ? manifest.frames : [];
    state.frames = raw.map(makeFrame).filter((f) => f.count > 0);
    // 兼容旧索引：没有 frames 字段时，每张图各自成框，视觉与以前完全一致
    if (!state.frames.length && state.photos.length) {
      state.frames = state.photos.map((p) => makeFrame({
        id: p.src, title: p.title, cover: p.src,
        category: p.category, categoryLabel: p.categoryLabel, photos: [p]
      }));
    }

    if (!state.frames.length) {
      showEmpty('索引里一个素材都没有。点相册最后的「＋ 添加图片」格子，或把图片放进 photos 对应分类目录。');
      return;
    }

    const images = state.photos.filter((p) => p.type === 'image').length;
    const videos = state.photos.length - images;
    paintTotals();
    el.builtAt.textContent = manifest.generatedAt
      ? new Date(manifest.generatedAt).toLocaleString('zh-CN', { hour12: false })
      : '—';
    // 页脚不再写「支持格式 JPG / PNG …」，界面保持清爽、不出现 jpg 字样。
    el.formatsNote.textContent = '';

    el.toolbar.hidden = false;
    el.filters.hidden = true;   // 横向胶囊条已下线，分类改由「全部分类」折叠面板承载
    el.catWrap.hidden = false;
    el.empty.hidden = true;
    renderCategoryFilters();
    renderFormatFilters();
    // 索引加载是异步的，浏览器可能在这段时间内才把「米兰」自动填进搜索框，
    // 渲染前再清一次，保证首页不会被一个莫名其妙的关键词过滤成空白。
    if (!el.search.dataset.userTyped && el.search.value) {
      el.search.value = '';
      state.query = '';
    }
    render();
  }

  /* 删除后不重新拉线上旧索引时，用内存里的新状态把统计和筛选数量一起刷新 */
  function paintTotals() {
    const images = state.photos.filter((p) => p.type === 'image').length;
    const videos = state.photos.length - images;
    el.total.textContent = String(state.photos.length);
    el.mediaSummary.textContent = videos ? `${images} 张图片 · ${videos} 个视频` : `${images} 张图片`;
    const counts = new Map();
    state.frames.forEach((f) => counts.set(f.category, (counts.get(f.category) || 0) + f.photos.length));
    state.categoryFilters = state.categoryFilters.map((c) => ({ ...c, count: counts.get(c.id) || 0 }));
    renderCategoryFilters();
    renderFormatFilters();
  }

  function showEmpty(reason) {
    el.gallery.hidden = true;
    el.gallery.innerHTML = '';
    el.filters.hidden = true;
    el.formatFilters.hidden = true;
    el.catWrap.hidden = true;
    el.toolbar.hidden = true;
    el.pager.hidden = true;
    el.empty.hidden = false;
    el.emptyReason.textContent = reason;
    el.total.textContent = '0';
  }

  function chipHtml(item, key) {
    return `<button class="chip" type="button" data-${key}="${esc(item.id)}" aria-pressed="${item.active}">` +
      `${esc(item.label)}<span class="num">${item.count}</span></button>`;
  }

  function renderCategoryFilters() {
    const categories = state.categories || [];
    // 优先用「逻辑分类」统计（含自定义分类、含被编辑改过分类的商品）
    const list = state.categoryFilters.length
      ? state.categoryFilters
        .filter((c) => c.count > 0)
        .map((c) => ({ id: c.id, label: c.label || c.id, count: c.count, active: false }))
      : categories
        .filter((c) => (c.photos || []).length)
        .map((c) => ({ id: c.id, label: c.label || c.id, count: c.photos.length, active: false }));
    const items = [{ id: 'all', label: '全部', count: state.photos.length, active: true }].concat(list);
    el.filters.innerHTML = items.map((item) => chipHtml(item, 'cat')).join('');
    // 折叠面板：两列纯文字，不显示数量，避免几百个分类把界面挤乱
    el.catPanelList.innerHTML = items.map((item) =>
      `<button class="cat-item" type="button" data-cat="${esc(item.id)}" title="${esc(item.label)}" aria-pressed="false">${esc(item.label)}</button>`
    ).join('');
    syncCatSelection();
  }

  /* 当前选中分类同步到折叠按钮文字 + 面板里的高亮 */
  function syncCatSelection() {
    const cur = state.categoryFilters.filter((c) => c.id === state.filter)[0];
    el.catToggleLabel.textContent = state.filter === 'all' ? '全部分类' : ((cur && cur.label) || state.filter);
    el.catPanelList.querySelectorAll('.cat-item').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.cat === state.filter));
    });
  }

  function setCatPanel(open) {
    el.catPanel.hidden = !open;
    el.catToggle.setAttribute('aria-expanded', String(open));
    el.catToggle.classList.toggle('is-open', open);
  }

  function pickCategory(id) {
    state.filter = id || 'all';
    state.page = 1;
    setCatPanel(false);
    render();
    scrollTop();
  }

  function renderFormatFilters() {
    const counts = new Map();
    state.photos.forEach((p) => counts.set(p.ext, (counts.get(p.ext) || 0) + 1));
    const images = state.photos.filter((p) => p.type === 'image').length;
    const videos = state.photos.length - images;
    const items = [{ id: 'all', label: '全部格式', count: state.photos.length, active: true }];
    if (images && videos) {
      items.push({ id: 'image', label: '图片', count: images, active: false });
      items.push({ id: 'video', label: '视频', count: videos, active: false });
    }
    [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([ext, n]) => {
      items.push({ id: ext, label: ext, count: n, active: false });
    });
    // 顶部「全部格式 / JPG / PNG」这一排会让首页显得很乱，店家明确要求界面清爽，
    // 且不再展示任何 jpg 字样。筛选能力保留在搜索框里，这里始终隐藏。
    el.formatFilters.innerHTML = '';
    el.formatFilters.hidden = true;
  }

  function matchFormat(p) {
    if (state.format === 'all') return true;
    if (state.format === 'image' || state.format === 'video') return p.type === state.format;
    return p.ext === state.format;
  }

  function frameMatches(f, q) {
    if (state.filter !== 'all' && f.category !== state.filter) return false;
    if (state.format !== 'all' && !f.photos.some(matchFormat)) return false;
    if (q && !f.searchText.includes(q)) return false;
    return true;
  }

  function cardHtml(f, i) {
    const cover = f.photos[0] || {};
    const media = cover.type === 'video'
      ? `<video src="${esc(cover.src)}" muted playsinline preload="metadata" aria-label="${esc(f.title)}"></video><span class="play-badge">视频</span>`
      : `<img src="${esc(cover.src)}" alt="${esc(f.title)}" loading="lazy" decoding="async">`;
    // 首页格子保持干净的纯图片：不显示 JPG 格式角标，也不显示「几张图」计数角标。
    // 以后新上传 / 批量上架的商品走的是同一段渲染，自然也不会再带这两个角标。
    // 加图 / 编辑资料统一放到点开框后的详情页里。
    // 价格单独一行：dense 版式会隐藏 .card-cat，价格不能跟着一起被藏掉。
    // 改价后只要 manifest 重新发布，手机前台每个格子都会立刻显示新价。
    const rawPrice = f.detail && f.detail.price ? String(f.detail.price).trim() : '';
    const price = rawPrice
      ? `<span class="card-price">${esc(/[¥￥]/.test(rawPrice) ? rawPrice : '¥' + rawPrice)}</span>` : '';
    return `<button class="card" type="button" data-index="${i}" aria-label="查看：${esc(f.title)}">` +
      `<span class="card-media">${media}</span>` +
      `<span class="card-meta"><span class="card-title">${esc(f.title)}</span>` + price +
      `<span class="card-cat">${esc(f.categoryLabel)}</span></span></button>`;
  }

  function addTileHtml() {
    if (!state.canUpload || state.uploading) return '';
    return `<button class="add-tile" type="button" data-add-tile="1" aria-label="新建商品框">` +
      `<span class="add-tile-plus">＋</span><span class="add-tile-text">新建商品框</span>` +
      `<span class="add-tile-hint">点这里挑图 · 可多选</span></button>`;
  }

  function render() {
    const q = state.query.trim().toLowerCase();
    state.all = state.frames.filter((f) => frameMatches(f, q));

    const perPage = pageSize();
    const pages = Math.max(1, Math.ceil(state.all.length / perPage));
    state.page = Math.min(Math.max(1, state.page), pages);
    state.view = state.all.slice((state.page - 1) * perPage, state.page * perPage);

    const noResult = '<p class="no-result">没有匹配的素材，换个关键词或筛选条件试试。' +
      '<button type="button" class="reset-btn" id="reset-filters">清除全部筛选</button></p>';
    el.gallery.innerHTML = (state.view.length ? state.view.map(cardHtml).join('') : noResult) +
      (state.page === pages ? addTileHtml() : '');
    el.gallery.querySelectorAll('img, video').forEach((media) => {
      media.addEventListener('error', () => media.closest('.card')?.classList.add('is-broken'), { once: true });
    });
    const reset = $('reset-filters');
    if (reset) reset.addEventListener('click', clearFilters);

    el.gallery.hidden = false;
    el.pager.hidden = false;
    el.pageInfo.textContent = `第 ${state.page} / ${pages} 页 · 每页 ${PAGE_SIZE} 个框 · 共 ${state.all.length} 个框 / ${state.photos.length} 个素材`;
    el.pagePrev.disabled = state.page <= 1;
    el.pageNext.disabled = state.page >= pages;
    updatePressed();
  }

  function clearFilters() {
    state.filter = 'all';
    state.format = 'all';
    state.query = '';
    state.page = 1;
    el.search.value = '';
    render();
  }

  function updatePressed() {
    el.filters.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === state.filter)));
    el.formatFilters.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === state.format)));
    syncCatSelection();
  }

  function applyLayout(layout) {
    state.layout = LAYOUTS.includes(layout) ? layout : 'dense';
    el.gallery.className = `gallery layout-${state.layout}`;
    el.layouts.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout));
    });
  }

  /* ---------- 本机上传台（往框里加图） ---------- */
  /* 用 var：init() 在文件靠前就同步调 probeConsole()，let 会落进暂时性死区 */
  var probeConsoleTimer = null;
  async function probeConsole() {
    clearTimeout(probeConsoleTimer);
    let ready = false;
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const opts = { cache: 'no-store' };
      if (ctrl) opts.signal = ctrl.signal;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 2000) : null;
      const res = await fetch(`${CONSOLE}/api/status`, opts);
      if (timer) clearTimeout(timer);
      ready = Boolean(res.ok && (await res.json()).ok);
    } catch { ready = false; }

    state.canUpload = ready;
    if (el.consoleState) {
      el.consoleState.textContent = ready
        ? '● 本机上传已就绪 · 点开框在里面加图 / 编辑资料'
        : '○ 本机上传台未启动 · 点「＋ 上传商品」查看说明';
      el.consoleState.classList.toggle('is-ready', ready);
    }
    el.openUpload.textContent = ready ? '＋ 新建商品框' : '＋ 上传商品';
    el.openUpload.classList.toggle('is-direct', ready);
    /* 前台 / 后台已经统一成一个链接：右上角「店家登录」是唯一入口。
       旧的「📋 客户订单」本机按钮停用（DOM 与点击绑定保留，不碰其它逻辑）。 */
    if (el.openOrders) el.openOrders.hidden = true;
    if (state.frames.length) render();
    if (el.frameDetail && !el.frameDetail.hidden) paintFrameDetail();
    /* 上传台掉了会自己回来：连上时 30 秒复查，断开时每 8 秒重连，不用刷新页面 */
    probeConsoleTimer = setTimeout(probeConsole, ready ? 30000 : 8000);
  }

  let toastTimer = null;
  function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (el.uploadToast) el.uploadToast.hidden = true;
  }
  function toast(html, kind) {
    if (!el.uploadToast) return;
    /* 清单已经打开时，件数和金额清单里都有，不再叠一层提示压住底部按钮 */
    const cartPanel = document.getElementById('cart-panel');
    if (cartPanel && !cartPanel.hidden) { hideToast(); return; }
    el.uploadToast.hidden = false;
    el.uploadToast.className = `upload-toast${kind ? ` is-${kind}` : ''}`;
    el.uploadToast.innerHTML = html;
    /* 提示必须自己消失，不能一直挂在屏幕上挡住「提交订单」 */
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, kind === 'warn' ? 4200 : 2800);
  }

  function openPicker(frameId, category) {
    if (!state.canUpload || state.uploading || !el.galleryFile) return;
    state.pendingFrame = frameId || 'new';
    state.pendingCategory = category || 'auto';
    el.galleryFile.value = '';
    el.galleryFile.click();
  }

  async function toBase64(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < buf.length; i += step) binary += String.fromCharCode.apply(null, buf.subarray(i, i + step));
    return btoa(binary);
  }

  async function postConsole(path, body) {
    const res = await fetch(CONSOLE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  }

  async function waitConsolePublish() {
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      await sleep(1200);
      let s;
      try {
        s = await (await fetch(`${CONSOLE}/api/publish/status`, { cache: 'no-store' })).json();
      } catch { continue; }
      if (s.started && !s.running && s.finished && !s.queued) return s;
    }
    throw new Error('发布状态查询超时');
  }

  /* ---------- 编辑商品文字资料 ---------- */
  function openEditor(frame) {
    if (!state.canUpload || !frame) return;
    state.editingFrame = frame;
    const d = frame.detail || {};
    el.edCode.value = d.code || '';
    el.edTitle.value = frame.title || '';
    el.edPrice.value = d.price || '';
    el.edSize.value = d.size || '';
    el.edCondition.value = d.condition || '';
    el.edDescription.value = d.description || '';
    el.edNote.value = d.note || '';
    el.edNewCat.value = '';
    const cats = state.categoryFilters.length
      ? state.categoryFilters
      : [{ id: 'bags', label: '包包' }, { id: 'scarves', label: '围巾' }, { id: 'watches', label: '手表' }, { id: 'other', label: '其他' }];
    el.edCategory.innerHTML = '<option value="">保持原分类</option>' +
      cats.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
    el.edCategory.value = cats.some((c) => c.id === frame.category) ? frame.category : '';
    el.editStatus.textContent = '';
    el.editPanel.hidden = false;
    el.edCode.focus();
  }

  function closeEditor() {
    el.editPanel.hidden = true;
    state.editingFrame = null;
  }

  async function saveDetail(e) {
    if (e) e.preventDefault();
    const frame = state.editingFrame;
    if (!frame || state.saving) return;
    state.saving = true;
    el.editSave.disabled = true;
    el.editStatus.textContent = '正在保存并发布…';
    try {
      await postConsole('/api/save-detail', {
        frame: frame.id,
        title: el.edTitle.value,
        code: el.edCode.value,
        price: el.edPrice.value,
        size: el.edSize.value,
        condition: el.edCondition.value,
        description: el.edDescription.value,
        note: el.edNote.value,
        category: el.edCategory.value,
        newCategory: el.edNewCat.value
      });
      const pub = await waitConsolePublish();
      await loadManifest();
      clearFilters();
      closeEditor();
      reopenFrameDetail(state.returnToDetail);
      toast(pub.resultOk === false
        ? `✔ 资料已保存到本机并立刻显示 · ${esc(pub.message || '线上暂时未同步，会自动补发，你不用操作')}`
        : '✔ 商品资料已保存并发布', 'ok');
    } catch (err) {
      el.editStatus.textContent = '✖ ' + (err.message || '保存失败');
      toast(`✖ ${esc(err.message || '保存失败')}，资料已存在本机，可重试。`, 'warn');
    } finally {
      state.saving = false;
      el.editSave.disabled = false;
      setTimeout(() => { if (!state.saving && el.uploadToast) el.uploadToast.hidden = true; }, 9000);
    }
  }

  async function uploadFiles(files) {
    const list = Array.from(files || []);
    if (!list.length || state.uploading) return;
    state.uploading = true;
    const frameId = state.pendingFrame;
    const category = state.pendingCategory;
    // 「新建商品框」一次选多张图 = 同一个商品的多张实拍图，共用一个框。
    // 后端按 batch 把同批图片归到第一张名下，避免变成一图一框。
    const batch = (frameId === 'new' && list.length > 1)
      ? 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
      : '';
    const count = { added: 0, skipped: 0, needConvert: 0, rejected: 0, failed: 0 };
    let newFrameId = null;
    toast('准备上传…');
    render();

    try {
      for (let i = 0; i < list.length; i++) {
        toast(`正在上传 ${i + 1} / ${list.length} · ${esc(list[i].name)}`);
        try {
          const data = await toBase64(list[i]);
          const r = await postConsole('/api/upload', {
            name: list[i].name, data, category, frame: frameId, batch
          });
          if (r.outcome === 'added' && !newFrameId && r.frame) newFrameId = r.frame;
          if (r.outcome === 'added') count.added += 1;
          else if (r.outcome === 'skipped') count.skipped += 1;
          else if (r.outcome === 'needConvert') count.needConvert += 1;
          else count.rejected += 1;
        } catch { count.failed += 1; }
      }

      if (count.added) {
        toast('正在发布到线上，约 10～30 秒…');
        await postConsole('/api/publish', {});
        const pub = await waitConsolePublish();
        await loadManifest();
        clearFilters();
        reopenFrameDetail(state.returnToDetail || (frameId !== 'new' ? frameId : newFrameId));
        if (pub.resultOk === false) {
          // 线上临时发不出去（例如 Netlify 额度用尽）：图已安全落盘，本机立刻可见，后台会自动补发
          toast(`✔ 图片已保存到本机并立刻显示 · ${esc(pub.message || '线上暂时未同步，会自动补发，你不用操作')}`, 'ok');
        } else {
          toast(frameId === 'new'
            ? (count.added > 1
              ? `✔ 已新建 1 个商品框，装上 ${count.added} 张图，相册已更新`
              : '✔ 已新建 1 个商品框，相册已更新')
            : `✔ 已往这个框里加了 ${count.added} 张图，相册已更新`, 'ok');
        }
      } else {
        toast('没有新图片上架' + (count.skipped ? ` · 跳过重复 ${count.skipped} 张` : ''), 'warn');
      }

      const notes = [];
      if (count.skipped) notes.push(`跳过重复 ${count.skipped} 张`);
      if (count.needConvert) notes.push(`${count.needConvert} 个 HEIC / MOV 等需先转换`);
      if (count.rejected) notes.push(`${count.rejected} 个格式不支持或超过 20 MB`);
      if (count.failed) notes.push(`${count.failed} 个传输中断（图不会丢，可重试）`);
      if (notes.length) toast(`${count.added ? '✔' : '!'} ${notes.join(' · ')}`, count.added ? 'ok' : 'warn');
    } catch (err) {
      toast(`✖ ${esc(err.message || '连接中断')}。已传成功的图不会丢，点「＋ 上传商品」里的上传台可补发布。`, 'warn');
    } finally {
      state.uploading = false;
      render();
      setTimeout(() => { if (!state.uploading && el.uploadToast) el.uploadToast.hidden = true; }, 9000);
    }
  }

  /* ---------- 删除：删单张图 / 删整个商品框，先确认，再移到本机回收站 ---------- */

  // 删某一张：从统计、商品框列表、框内图片列表里同时拿掉；删掉封面时自动换下一张当封面。
  function applyDeletedPhoto(frameId, src, nextFrameId) {
    state.photos = state.photos.filter((p) => p.src !== src);
    const idx = state.frames.findIndex((f) => f.id === frameId || f.photos.some((p) => p.src === src));
    if (idx < 0) return;
    const f = state.frames[idx];
    const rest = f.photos.filter((p) => p.src !== src);
    if (!rest.length) { state.frames.splice(idx, 1); return; }
    state.frames[idx] = makeFrame({
      id: nextFrameId || rest[0].src,
      title: f.title,
      cover: rest[0].src,
      category: f.category,
      categoryLabel: f.categoryLabel,
      detail: f.detail,
      photos: rest
    });
  }

  function applyDeletedFrame(frameId, srcs) {
    const gone = new Set(srcs);
    state.photos = state.photos.filter((p) => !gone.has(p.src));
    state.frames = state.frames.filter((f) => f.id !== frameId);
  }

  function askDelete(job) {
    if (!state.canUpload || state.deleting) return;
    state.pendingDelete = {
      ...job,
      path: job.kind === 'frame' ? '/api/delete-frame' : '/api/delete-photo'
    };
    el.confirmTitle.textContent = job.kind === 'frame' ? '删除整个商品框？' : '删除这一张图片？';
    el.confirmText.textContent = job.kind === 'frame'
      ? `「${job.label}」这个商品框里的 ${job.srcs.length} 张图片和它的编号 / 价格 / 描述等资料会一起删掉。`
      : `将删除 ${job.label}，这个框里其余的图片和资料都保留。`;
    el.confirmOk.textContent = job.kind === 'frame' ? '删除整个框' : '删除这张图';
    el.confirmStatus.textContent = '';
    el.confirmOk.disabled = false;
    el.confirmCancel.disabled = false;
    el.confirmPanel.hidden = false;
    el.confirmCancel.focus();
  }

  function closeConfirm() {
    if (!el.confirmPanel) return;
    el.confirmPanel.hidden = true;
    state.pendingDelete = null;
  }

  async function runDelete() {
    const job = state.pendingDelete;
    if (!job || state.deleting) return;
    state.deleting = true;
    el.confirmOk.disabled = true;
    el.confirmCancel.disabled = true;
    el.confirmStatus.textContent = '正在删除并更新相册…';
    try {
      const data = await postConsole(job.path, job.payload);
      const pub = await waitConsolePublish();

      // 本机预览读的是磁盘上的新索引；线上是静态快照，直接用内存里的新状态立刻刷新。
      let reloaded = false;
      if (!REMOTE_SNAPSHOT) {
        try { await loadManifest(); reloaded = true; } catch { /* 用内存兜底 */ }
      }
      if (!reloaded) {
        if (job.kind === 'frame') applyDeletedFrame(job.frameId, job.srcs);
        else applyDeletedPhoto(job.frameId, job.src, data.frameId);
        paintTotals();
      }
      clearFilters();

      if (job.kind === 'frame') closeFrameDetail();
      else if (job.returnToDetail && data.frameId) reopenFrameDetail(data.frameId);
      else closeFrameDetail();
      closeConfirm();
      toast(pub.resultOk === false
        ? `✔ 已在本机删除 · ${esc(pub.message || '线上快照稍后同步')}`
        : (job.kind === 'frame' ? '✔ 整个商品框已删除' : '✔ 图片已删除，在本机回收站里可找回'), 'ok');
    } catch (err) {
      el.confirmStatus.textContent = '✖ ' + (err.message || '删除失败');
      toast(`✖ ${esc(err.message || '删除失败')}，图片没有被改动，可以重试。`, 'warn');
    } finally {
      state.deleting = false;
      el.confirmOk.disabled = false;
      el.confirmCancel.disabled = false;
      setTimeout(() => { if (!state.deleting && el.uploadToast) el.uploadToast.hidden = true; }, 9000);
    }
  }

  /* ---------- 框内详情页：一眼看到全部图片，点单张再看大图 ---------- */
  const VIDEO_POSTER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#f4f1ec"/><circle cx="60" cy="60" r="20" fill="none" stroke="#837c73" stroke-width="2"/><path d="M55 50l18 10-18 10z" fill="#837c73"/></svg>');

  function dayOf(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function currentFrame() {
    return state.lightboxFromDetail ? state.detailFrame : state.view[state.frameIndex];
  }

  function tileHtml(p, i) {
    const media = p.type === 'video'
      ? `<video src="${esc(p.src)}" muted playsinline preload="metadata"></video><span class="fd-tile-badge">视频</span>`
      : `<img src="${esc(p.src)}" alt="${esc(p.title)}" loading="lazy" decoding="async">`;
    const name = p.file || `${i + 1}.${String(p.ext || 'jpg').toLowerCase()}`;
    const date = dayOf(p.addedAt);
    const tile = `<button class="fd-tile${i === state.detailCursor ? ' is-current' : ''}" type="button" data-photo="${i}" ` +
      `aria-label="第 ${i + 1} 张：${esc(p.title)}，点击看大图">` +
      `<span class="fd-tile-media">${media}<span class="fd-tile-no">${i + 1}</span></span>` +
      `<span class="fd-tile-name">${esc(name)}</span>` +
      `<span class="fd-tile-date">${esc(date || p.ext || '')}${p.size ? ` · ${esc(formatSize(p.size))}` : ''}</span>` +
      `</button>`;
    // 删除按钮是格子外层容器的兄弟节点，避免 button 里套 button
    const del = state.canUpload
      ? `<button class="fd-tile-del" type="button" data-del-photo="${i}" ` +
        `aria-label="删除第 ${i + 1} 张图：${esc(p.title)}" title="删除这张图">×</button>`
      : '';
    return `<div class="fd-cell">${tile}${del}</div>`;
  }

  function paintFrameDetail() {
    const frame = state.detailFrame;
    if (!frame || !el.frameDetail) return;
    const head = frame.photos[0] || {};
    const d = frame.detail || {};
    el.fdCover.src = head.type === 'video' ? VIDEO_POSTER : (head.src || '');
    el.fdCover.alt = frame.title || '';
    el.fdTitle.textContent = frame.title || '未命名商品';
    const videos = frame.photos.filter((p) => p.type === 'video').length;
    // 店家要求：详情页只保留产品描述细节 + 加入选购清单，
    // 「N 张图 · 分类 · 编号 · 日期」和「备注（来源网址）」这些重复 / 杂乱信息一律不显示。
    el.fdSub.textContent = '';
    const rows = [
      ['编号', d.code], ['尺寸', d.size], ['成色', d.condition]
    ].filter(([, v]) => v)
      .map(([k, v]) => `<span class="fd-field"><em>${esc(k)}</em>${esc(v)}</span>`).join('');
    el.fdFields.innerHTML = rows;
    el.fdFields.hidden = !rows;
    // 价格独立成大字一行，不再塞进小胶囊里，手机上改完价一眼能看到
    const priceText = d.price ? String(d.price).trim() : '';
    if (el.fdPrice) {
      el.fdPrice.textContent = priceText ? (/[¥￥]/.test(priceText) ? priceText : '¥' + priceText) : '';
      el.fdPrice.hidden = !priceText;
    }
    el.fdDesc.textContent = d.description || '';
    el.fdDesc.hidden = !d.description;
    el.fdCounter.textContent = `${frame.title || '商品'} · 共 ${frame.count} 张图`;
    el.fdGrid.innerHTML = frame.photos.map(tileHtml).join('');
    el.fdGrid.classList.toggle('is-large', state.detailLarge);
    el.fdDensity.textContent = state.detailLarge ? '▤ 缩略模式' : '▦ 放大缩略图';
    el.fdGrid.querySelectorAll('img, video').forEach((m) => {
      m.addEventListener('error', () => m.closest('.fd-tile')?.classList.add('is-broken'), { once: true });
    });
    el.fdAdd.hidden = !state.canUpload;
    el.fdEdit.hidden = !state.canUpload;
    el.fdDeleteFrame.hidden = !state.canUpload;
    el.fdAdd.textContent = frame.count > 1
      ? `＋ 给这个框加图（已有 ${frame.count} 张）`
      : '＋ 给这个框加图';
    refreshCartButtons();
  }

  function openFrameDetail(index, trigger) {
    const frame = state.view[index];
    if (!frame || !el.frameDetail) return;
    state.detailFrame = frame;
    state.detailIndex = index;
    state.detailCursor = 0;
    state.lastFocus = trigger || null;
    paintFrameDetail();
    el.frameDetail.hidden = false;
    document.body.classList.add('fd-open');
    el.fdClose.focus();
  }

  function closeFrameDetail() {
    if (!el.frameDetail || el.frameDetail.hidden) return;
    el.frameDetail.hidden = true;
    document.body.classList.remove('fd-open');
    el.fdGrid.innerHTML = '';
    state.detailFrame = null;
    if (state.lastFocus && document.body.contains(state.lastFocus)) state.lastFocus.focus();
  }

  /* 上传 / 改完资料后自动回到原来那个框的详情页 */
  function reopenFrameDetail(id) {
    if (!id) return;
    const idx = state.all.findIndex((f) => f.id === id);
    state.returnToDetail = null;
    if (idx < 0) return;
    const per = pageSize();
    state.page = Math.floor(idx / per) + 1;
    render();
    openFrameDetail(idx - (state.page - 1) * per);
  }

  /* ---------- 大图灯箱：从详情页点单张进入，只在框内翻页 ---------- */
  function openLightbox(index, trigger) { openFrameDetail(index, trigger); } // 兼容旧入口

  function openLightboxFromDetail(i) {
    const frame = state.detailFrame;
    if (!frame || !frame.photos.length) return;
    state.lightboxFromDetail = true;
    state.frameCursor = Math.min(Math.max(0, i), frame.photos.length - 1);
    state.detailCursor = state.frameCursor;
    paint();
    el.lightbox.hidden = false;
    document.body.classList.add('lb-open');
    el.lbClose.focus();
  }

  function closeLightbox() {
    const fromDetail = state.lightboxFromDetail;
    el.lightbox.hidden = true;
    document.body.classList.remove('lb-open');
    el.lbVideo.pause();
    el.lbVideo.removeAttribute('src');
    el.lbImg.removeAttribute('src');
    state.lightboxFromDetail = false;
    if (fromDetail && el.frameDetail && !el.frameDetail.hidden) {
      el.fdGrid.querySelectorAll('.fd-tile').forEach((t) => {
        t.classList.toggle('is-current', Number(t.dataset.photo) === state.detailCursor);
      });
      const tile = el.fdGrid.querySelector(`.fd-tile[data-photo="${state.detailCursor}"]`);
      if (tile) tile.focus();
    } else if (state.lastFocus && document.body.contains(state.lastFocus)) {
      state.lastFocus.focus();
    }
  }

  function step(delta) {
    if (el.lightbox.hidden) return;
    const frame = currentFrame();
    if (!frame || !frame.photos.length) return;
    const n = frame.photos.length;
    if (state.lightboxFromDetail) {
      state.frameCursor = (state.frameCursor + delta + n) % n;
      state.detailCursor = state.frameCursor;
      paint();
      return;
    }
    if (!state.view.length) return;
    const next = state.frameCursor + delta;
    if (next >= 0 && next < n) {
      state.frameCursor = next;
      paint();
      return;
    }
    // 框内翻到头，就顺着翻到相邻的商品框
    const ni = (state.frameIndex + delta + state.view.length) % state.view.length;
    state.frameIndex = ni;
    state.frameCursor = delta > 0 ? 0 : Math.max(0, state.view[ni].photos.length - 1);
    paint();
  }

  function paint() {
    const frame = currentFrame();
    if (!frame) return;
    const p = frame.photos[state.frameCursor];
    if (!p) return;
    const isVideo = p.type === 'video';
    el.lbImg.hidden = isVideo;
    el.lbVideo.hidden = !isVideo;
    if (isVideo) {
      el.lbVideo.src = p.src;
      el.lbVideo.poster = '';
    } else {
      el.lbVideo.pause();
      el.lbImg.src = p.src;
      el.lbImg.alt = p.title;
    }
    // 大图页保持干净：不显示商品名、文件名 / JPG / 文件大小 / 分类、框内第几张、翻看提示。
    el.lbTitle.textContent = '';
    el.lbMeta.textContent = '';
    el.lbCount.textContent = '';
    el.lbAdd.hidden = !state.canUpload;
    el.lbAdd.textContent = frame.count > 1
      ? `＋ 给这个框加图（已有 ${frame.count} 张）`
      : '＋ 给这个框加图';
    el.lbEdit.hidden = !state.canUpload;
    el.lbDelete.hidden = !state.canUpload;

    const d = frame.detail || {};
    // 只留「产品描述细节」这一行；编号 / 分类 / 来源网址 / 重复标题全部不输出。
    // 新上传的商品走的是同一段渲染，所以以后也自动保持这个干净版式。
    const desc = d.description ? `<p class="lb-desc">${esc(d.description)}</p>` : '';
    el.lbDetail.hidden = !desc;
    el.lbDetail.innerHTML = desc;
    refreshCartButtons();
  }

  function bindEvents() {
    el.openUpload.addEventListener('click', () => {
      if (state.canUpload) { state.returnToDetail = null; openPicker('new'); return; }
      el.uploadPanel.hidden = false;
    });
    if (el.openOrders) {
      el.openOrders.addEventListener('click', () => {
        if (!state.canUpload) return;
        /* 订单页地址（含店家口令）由本机上传台下发，客户拿到的静态页面里没有口令 */
        window.open(CONSOLE + '/orders', '_blank', 'noopener');
      });
    }
    el.uploadPanelClose.addEventListener('click', () => { el.uploadPanel.hidden = true; });
    el.uploadPanel.addEventListener('click', (e) => {
      if (e.target === el.uploadPanel) el.uploadPanel.hidden = true;
    });

    if (el.galleryFile) {
      el.galleryFile.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        uploadFiles(files);
      });
    }

    if (el.lbAdd) {
      el.lbAdd.addEventListener('click', () => {
        const frame = currentFrame();
        if (!frame) return;
        const fromDetail = state.lightboxFromDetail;
        const id = frame.id;
        const category = frame.category;
        closeLightbox();
        if (fromDetail) closeFrameDetail();
        state.returnToDetail = fromDetail ? id : null;
        openPicker(id, category);
      });
    }

    if (el.lbEdit) {
      el.lbEdit.addEventListener('click', () => {
        const frame = currentFrame();
        if (!frame) return;
        const fromDetail = state.lightboxFromDetail;
        const id = frame.id;
        closeLightbox();
        if (fromDetail) closeFrameDetail();
        state.returnToDetail = fromDetail ? id : null;
        openEditor(frame);
      });
    }

    if (el.lbAddCart) {
      el.lbAddCart.addEventListener('click', () => {
        const f = currentFrame();
        const p = f && f.photos && f.photos[state.frameCursor];
        /* 单张大图里加购：清单里显示的就是眼前这张图，不是整个框的第一张拼图 */
        addFrameToCart(f, p && p.src);
      });
    }

    if (el.lbDelete) {
      el.lbDelete.addEventListener('click', () => {
        const frame = currentFrame();
        const p = frame && frame.photos[state.frameCursor];
        if (!frame || !p) return;
        const fromDetail = state.lightboxFromDetail;
        const id = frame.id;
        closeLightbox();
        if (fromDetail) closeFrameDetail();
        askDelete({
          kind: 'photo',
          payload: { src: p.src, frame: id },
          label: `第 ${state.frameCursor + 1} 张图「${p.title}」`,
          frameId: id, src: p.src, srcs: [],
          returnToDetail: fromDetail ? id : null
        });
      });
    }

    /* 删除确认弹窗：默认聚焦「取消」，Esc 也能撤销，避免手滑误删 */
    if (el.confirmPanel) {
      el.confirmOk.addEventListener('click', runDelete);
      el.confirmCancel.addEventListener('click', () => { if (!state.deleting) closeConfirm(); });
      el.confirmPanel.addEventListener('click', (e) => {
        if (e.target === el.confirmPanel && !state.deleting) closeConfirm();
      });
    }

    if (el.editForm) el.editForm.addEventListener('submit', saveDetail);
    if (el.editClose) el.editClose.addEventListener('click', closeEditor);
    if (el.editCancel) el.editCancel.addEventListener('click', closeEditor);
    if (el.editPanel) {
      el.editPanel.addEventListener('click', (e) => {
        if (e.target === el.editPanel && !state.saving) closeEditor();
      });
    }
    if (el.editAddPic) {
      el.editAddPic.addEventListener('click', () => {
        const frame = state.editingFrame;
        if (!frame) return;
        const id = frame.id, category = frame.category;
        closeEditor();
        openPicker(id, category);
      });
    }

    /* 框内详情页：全部缩略图 / 点单张看大图 / 加图 / 编辑资料 */
    if (el.frameDetail) {
      el.fdClose.addEventListener('click', closeFrameDetail);
      el.fdBack.addEventListener('click', closeFrameDetail);
      el.frameDetail.addEventListener('click', (e) => {
        if (e.target === el.frameDetail) closeFrameDetail();
      });
      el.fdGrid.addEventListener('click', (e) => {
        const del = e.target.closest('.fd-tile-del');
        if (del) {
          e.preventDefault();
          e.stopPropagation();
          const frame = state.detailFrame;
          const i = Number(del.dataset.delPhoto);
          const p = frame && frame.photos[i];
          if (!frame || !p) return;
          askDelete({
            kind: 'photo',
            payload: { src: p.src, frame: frame.id },
            label: `第 ${i + 1} 张图「${p.title}」`,
            frameId: frame.id, src: p.src, srcs: [],
            returnToDetail: frame.id
          });
          return;
        }
        const tile = e.target.closest('.fd-tile');
        if (tile) openLightboxFromDetail(Number(tile.dataset.photo));
      });
      el.fdDensity.addEventListener('click', () => {
        state.detailLarge = !state.detailLarge;
        paintFrameDetail();
      });
      el.fdAdd.addEventListener('click', () => {
        const frame = state.detailFrame;
        if (!frame) return;
        const id = frame.id, category = frame.category;
        closeFrameDetail();
        state.returnToDetail = id;
        openPicker(id, category);
      });
      el.fdEdit.addEventListener('click', () => {
        const frame = state.detailFrame;
        if (!frame) return;
        const id = frame.id;
        closeFrameDetail();
        state.returnToDetail = id;
        openEditor(frame);
      });
      if (el.fdAddCart) el.fdAddCart.addEventListener('click', () => {
        const f = state.detailFrame;
        const p = f && f.photos && f.photos[state.detailCursor];
        addFrameToCart(f, p && p.src);
      });
      el.fdDeleteFrame.addEventListener('click', () => {
        const frame = state.detailFrame;
        if (!frame) return;
        askDelete({
          kind: 'frame',
          payload: { frame: frame.id },
          label: frame.title || '未命名商品',
          frameId: frame.id, src: '', srcs: frame.photos.map((p) => p.src),
          returnToDetail: null
        });
      });
    }

    /* 全部分类：点按钮折叠 / 展开，点面板里的分类即筛选并自动收起 */
    el.catToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setCatPanel(el.catPanel.hidden);
    });
    el.catPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('.cat-item');
      if (!btn) return;
      pickCategory(btn.dataset.cat);
    });
    document.addEventListener('click', (e) => {
      if (!el.catPanel.hidden && !el.catWrap.contains(e.target)) setCatPanel(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.catPanel.hidden) { setCatPanel(false); el.catToggle.focus(); }
    });

    el.filters.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      state.filter = btn.dataset.cat;
      state.page = 1;
      render();
    });

    el.formatFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      state.format = btn.dataset.format;
      state.page = 1;
      render();
    });

    el.layouts.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      applyLayout(btn.dataset.layout);
      state.page = 1;
      render();
      try { localStorage.setItem('sg-layout-v2', state.layout); } catch { /* 隐私模式 */ }
    });

    el.search.addEventListener('input', (e) => {
      state.query = e.target.value;
      state.page = 1;
      render();
    });

    el.pagePrev.addEventListener('click', () => {
      if (state.page > 1) { state.page -= 1; render(); scrollTop(); }
    });

    el.pageNext.addEventListener('click', () => {
      if (state.page < Math.ceil(state.all.length / pageSize())) { state.page += 1; render(); scrollTop(); }
    });

    window.addEventListener('resize', () => render());

    el.gallery.addEventListener('click', (e) => {
      const add = e.target.closest('.card-add');
      if (add) {
        e.preventDefault();
        e.stopPropagation();
        const f = state.view[Number(add.dataset.addIndex)];
        state.returnToDetail = null;
        if (f) openPicker(f.id, f.category);
        return;
      }
      const editBtn = e.target.closest('.card-edit');
      if (editBtn) {
        e.preventDefault();
        e.stopPropagation();
        const f = state.view[Number(editBtn.dataset.editIndex)];
        state.returnToDetail = null;
        if (f) openEditor(f);
        return;
      }
      const tile = e.target.closest('.add-tile');
      if (tile) {
        e.preventDefault();
        state.returnToDetail = null;
        openPicker('new');
        return;
      }
      const card = e.target.closest('.card');
      if (card) openFrameDetail(Number(card.dataset.index), card);
    });

    el.lbClose.addEventListener('click', closeLightbox);
    el.lbPrev.addEventListener('click', () => step(-1));
    el.lbNext.addEventListener('click', () => step(1));
    el.lightbox.addEventListener('click', (e) => {
      if (e.target === el.lightbox) closeLightbox();
    });

    document.addEventListener('keydown', (e) => {
      if (el.confirmPanel && !el.confirmPanel.hidden) {
        if (e.key === 'Escape' && !state.deleting) closeConfirm();
        return;
      }
      if (e.target && e.target.classList && (e.key === 'Enter' || e.key === ' ')) {
        if (e.target.classList.contains('card-add')) {
          e.preventDefault();
          const f = state.view[Number(e.target.dataset.addIndex)];
          if (f) openPicker(f.id, f.category);
          return;
        }
        if (e.target.classList.contains('card-edit')) {
          e.preventDefault();
          const f = state.view[Number(e.target.dataset.editIndex)];
          if (f) openEditor(f);
          return;
        }
      }
      if (!el.editPanel.hidden) {
        if (e.key === 'Escape' && !state.saving) closeEditor();
        return;
      }
      if (!el.uploadPanel.hidden) {
        if (e.key === 'Escape') el.uploadPanel.hidden = true;
        return;
      }
      if (!el.lightbox.hidden) {
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
        return;
      }
      if (el.frameDetail && !el.frameDetail.hidden) {
        if (e.key === 'Escape') closeFrameDetail();
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const f = state.detailFrame;
          if (!f || !f.photos.length) return;
          e.preventDefault();
          const n = f.photos.length;
          state.detailCursor = (state.detailCursor + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
          el.fdGrid.querySelectorAll('.fd-tile').forEach((t) => {
            t.classList.toggle('is-current', Number(t.dataset.photo) === state.detailCursor);
          });
        }
        return;
      }
      if (e.key === '/' && document.activeElement !== el.search) {
        e.preventDefault();
        el.search.focus();
      }
    });
  }
})();
