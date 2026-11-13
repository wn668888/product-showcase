/* 店家后台里的「整个文件夹自动上架」
   ------------------------------------------------------------------
   把本机上传台（127.0.0.1:3210）的批量导入能力直接搬进店家后台页面，
   店主登录后不用再另开一个页面。客户拿到的链接看不到后台，也调不到本机服务。
   所有请求都发给店主自己电脑上的上传台；别的设备没开服务时只给提示，不会假装成功。
   前端不存任何账号、密码或店家口令。

   文件夹列表里的「删除」：只把这条路径从列表里移除（本机上传台 + 本浏览器各存一份），
   随时可在「已删除」里恢复；电脑里的原文件夹和已经上架的商品一个字节都不会动。
*/
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  /* 两个本机地址都试：部分浏览器 / 代理会拦 127.0.0.1 却放行 localhost，反之亦然。
     探测成功后把可用地址记住，后续请求和缩略图都走它；服务掉线后会自动重连。 */
  const HOSTS = ['http://127.0.0.1:3210', 'http://localhost:3210'];
  let CONSOLE = HOSTS[0];
  const LS_KEY = 'wenipi-folder-import-v2';
  const params = new URLSearchParams(location.search);
  const isOrders = () => params.get('view') === 'orders' || document.body.classList.contains('orders-mode');
  // 只在店家后台视图里工作；客户页面直接不初始化
  if (!isOrders()) return;

  const btn = $('orders-folder-import');
  const modal = $('folder-import-modal');
  if (!btn || !modal) return;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const keyOf = (p) => String(p || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const leaf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  const shortName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).slice(-2).join(' / ') || String(p || '');
  const fmtDay = (iso) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : (d.getMonth() + 1) + '/' + d.getDate();
  };

  const pickedPaths = new Set();
  let pickedFiles = [];
  let candidates = [];
  let serverHidden = [];
  let consoleReady = false;
  let busy = false;

  /* 本机浏览器也存一份：上传台没开时，删除 / 恢复照样能随手用 */
  function localState() {
    try {
      const v = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      return {
        hidden: Array.isArray(v.hidden) ? v.hidden.filter((x) => typeof x === 'string') : [],
        used: (v.used && typeof v.used === 'object' && !Array.isArray(v.used)) ? v.used : {}
      };
    } catch { return { hidden: [], used: {} }; }
  }
  function saveLocal(fn) {
    try {
      const s = localState();
      fn(s);
      localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch { /* 隐私模式下写不了也不影响本次操作 */ }
  }
  function hiddenList() {
    const map = new Map();
    for (const p of [...serverHidden.map((h) => h.path), ...localState().hidden]) {
      if (p) map.set(keyOf(p), p);
    }
    return [...map.entries()].map(([key, path]) => ({ key, path, name: leaf(path) }));
  }

  async function api(pathname, body) {
    const init = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const hosts = CONSOLE === HOSTS[0] ? HOSTS : [CONSOLE, ...HOSTS.filter((h) => h !== CONSOLE)];
    let lastErr = null;
    for (const base of hosts) {
      let timer = null;
      try {
        const opts = { ...init };
        if (typeof AbortController === 'function') {
          const ctrl = new AbortController();
          opts.signal = ctrl.signal;
          timer = setTimeout(() => ctrl.abort(), 4000);
        }
        const res = await fetch(base + pathname, opts);
        const j = await res.json();
        if (!res.ok || j.ok === false) throw new Error(j.message || ('HTTP ' + res.status));
        CONSOLE = base; // 记住能通的地址，后面的请求和缩略图都走它
        return j;
      } catch (e) { lastErr = e; }
      finally { if (timer) clearTimeout(timer); }
    }
    throw lastErr || new Error('连不上本机上传台');
  }
  // 上传到本机的记录是「锦上添花」：上传台没开也不能挡住手动删除
  async function tryApi(pathname, body) {
    try { return await api(pathname, body); } catch { return null; }
  }

  function result(title, html, warn) {
    const box = $('fi-result');
    box.hidden = false;
    box.innerHTML = '<h3' + (warn ? ' class="fi-warn"' : '') + '>' + esc(title) + '</h3>' + html;
  }

  function renderChips() {
    const box = $('fi-chips');
    if (!box) return;
    const paths = [...pickedPaths];
    box.innerHTML = paths.length
      ? '<span class="fi-chips-label">已加进来的文件夹（点 × 移除）：</span>' + paths.map((p) =>
        '<span class="fi-chip"><span>' + esc(shortName(p)) + '</span>' +
        '<button type="button" data-rm="' + esc(p) + '" title="移除，不删电脑文件" aria-label="移除">×</button></span>').join('')
      : '';
    box.querySelectorAll('[data-rm]').forEach((b) => {
      b.addEventListener('click', () => {
        if (busy) return;
        const p = b.dataset.rm;
        pickedPaths.delete(p);
        $('fi-candidates').querySelectorAll('.fi-cand').forEach((x) => {
          const c = candidates[Number(x.dataset.p)];
          if (c && c.path === p) x.classList.remove('on');
        });
        hint();
        result('已移除', '<p>' + esc(p) + ' 不再参与这次上架，电脑里的原文件夹没动。</p>', false);
      });
    });
  }

  function hint() {
    const n = pickedPaths.size;
    const picked = pickedFiles.length ? '已选文件夹里的 ' + pickedFiles.length + ' 个文件' : '还没选文件夹';
    $('fi-picked').textContent = n ? '已选中 ' + n + ' 个文件夹（' + picked + '）' : picked;
    renderChips();
  }

  let probeTimer = null;
  let lastReady = null;
  async function probe() {
    clearTimeout(probeTimer);
    let now = false;
    try { await api('/api/status'); now = true; } catch { now = false; }
    const changed = now !== lastReady;
    lastReady = now;
    consoleReady = now;
    const h = $('fi-console-hint');
    if (h) {
      h.textContent = now
        ? '● 已连上店家这台电脑的上传台，可以直接上架'
        : '○ 本机上传台暂时没连上，正在自动重连…（一直不行时，在店家这台电脑双击桌面「Gallery-Upload.bat」；手机或别的电脑用不了这个功能）';
      h.classList.toggle('fi-off', !now);
    }
    /* 服务被拉起后不用刷新页面：自动把文件夹列表补回来 */
    if (changed && now && !modal.hidden) {
      try { await refreshCandidates(); } catch { /* noop */ }
    }
    probeTimer = setTimeout(probe, now ? 15000 : 5000);
  }

  function usedInfo(c) {
    if (c.used) return { times: c.usedCount || 1, at: c.usedAt || '' };
    const u = localState().used[keyOf(c.path)];
    return u ? { times: Number(u.times) || 1, at: u.at || '' } : null;
  }

  function renderCandidates(offline) {
    const box = $('fi-candidates');
    const hidden = hiddenList();
    const hiddenKeys = new Set(hidden.map((h) => h.key));
    const list = candidates.filter((c) => !hiddenKeys.has(keyOf(c.path)));
    let html = '';

    if (!list.length) {
      html += '<div class="fi-empty">' + (offline
        ? '本机上传台正在自动重连，连上后文件夹列表会自己出现；也可以直接点「📁 选其它文件夹」，已经删掉的文件夹仍可在下面恢复。'
        : '没有可显示的文件夹了。点「📁 选其它文件夹」自己挑，或把下面删掉的文件夹恢复回来。') + '</div>';
    }

    html += list.map((c) => {
      const i = candidates.indexOf(c);
      const u = usedInfo(c);
      const badge = u
        ? ' <em class="fi-used">已上架过' + (u.times > 1 ? ' ×' + u.times : '') +
          (u.at ? ' · ' + esc(fmtDay(u.at)) : '') + '</em>'
        : '';
      return '<div class="fi-cand-row">' +
        '<button type="button" class="fi-cand' + (pickedPaths.has(c.path) ? ' on' : '') + '" data-p="' + i + '">' +
        '<span><b>' + esc(c.name) + badge + '</b><small>' + esc(c.path) + ' · ' + c.folders + ' 个商品 · 约 ' +
        c.images + ' 张图' + (c.hasDetails ? ' · 带文字细节' : '') + '</small></span>' +
        '<span class="fi-tick">✓</span></button>' +
        '<button type="button" class="fi-del" data-del="' + i + '" title="从列表删除这个文件夹（不删电脑文件）">删除</button>' +
        '</div>';
    }).join('');

    if (hidden.length) {
      html += '<details class="fi-hidden"><summary>🗑 已删除 ' + hidden.length +
        ' 个文件夹 · 点开恢复</summary><div class="fi-hidden-body">' +
        hidden.map((h) => '<div class="fi-hidden-item"><span><b>' + esc(h.name) + '</b><small>' + esc(h.path) +
          '</small></span><button type="button" data-restore="' + esc(h.path) + '">恢复</button></div>').join('') +
        '<button type="button" class="fi-restore-all" data-restore-all="1">全部恢复</button>' +
        '</div></details>';
    }
    box.innerHTML = html;

    box.querySelectorAll('.fi-cand').forEach((b) => {
      b.addEventListener('click', () => {
        if (busy) return;
        const c = candidates[Number(b.dataset.p)];
        if (!c) return;
        if (pickedPaths.has(c.path)) { pickedPaths.delete(c.path); b.classList.remove('on'); }
        else { pickedPaths.add(c.path); b.classList.add('on'); }
        pickedFiles = [];
        hint();
      });
    });
    box.querySelectorAll('[data-del]').forEach((d) => {
      d.addEventListener('click', async () => {
        if (busy) return;
        const c = candidates[Number(d.dataset.del)];
        if (!c) return;
        if (!window.confirm('把「' + c.name + '」从列表里删掉？\n\n只从列表移除：电脑里的原文件夹、已经上架的商品都不会动。随时可以在「已删除」里恢复。')) return;
        d.disabled = true;
        const k = keyOf(c.path);
        saveLocal((s) => { if (!s.hidden.some((x) => keyOf(x) === k)) s.hidden.push(c.path); });
        const r = await tryApi('/api/folder-import/hide', { path: c.path });
        if (r && r.hidden) serverHidden = r.hidden;
        pickedPaths.delete(c.path);
        renderCandidates();
        hint();
        result('已从列表删除', '<p>' + esc(c.path) + '</p>' +
          '<p>原文件夹还在电脑里，一个字节都没动；已经上架的商品也不受影响。点列表下面「已删除」就能恢复。</p>', false);
      });
    });
    const restore = async (path, all) => {
      if (busy) return;
      if (all) {
        saveLocal((s) => { s.hidden = []; });
        const r = await tryApi('/api/folder-import/restore', { all: true });
        if (r && r.hidden) serverHidden = r.hidden;
      } else {
        const k = keyOf(path);
        saveLocal((s) => { s.hidden = s.hidden.filter((x) => keyOf(x) !== k); });
        const r = await tryApi('/api/folder-import/restore', { path });
        if (r && r.hidden) serverHidden = r.hidden;
      }
      await refreshCandidates();
      result(all ? '已全部恢复' : '已恢复', '<p>' + (all ? '删掉的文件夹都回到列表里了。' : esc(path) + ' 回到列表里了。') + '</p>', false);
    };
    box.querySelectorAll('[data-restore]').forEach((b) => {
      b.addEventListener('click', () => { b.disabled = true; restore(b.dataset.restore, false); });
    });
    const all = box.querySelector('[data-restore-all]');
    if (all) all.addEventListener('click', () => { all.disabled = true; restore('', true); });
  }

  async function refreshCandidates() {
    try {
      const r = await api('/api/folder-import/scan');
      candidates = r.candidates || [];
      serverHidden = r.hidden || [];
      renderCandidates(false);
      hint();
    } catch (e) {
      candidates = [];
      serverHidden = [];
      renderCandidates(true);
      hint();
    }
  }

  function open(on) {
    modal.hidden = !on;
    if (on) {
      probe();
      refreshCandidates();
      hint();
    }
  }

  async function toBase64(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < buf.length; i += step) binary += String.fromCharCode.apply(null, buf.subarray(i, i + step));
    return btoa(binary);
  }

  // 浏览器选的文件夹拿不到磁盘绝对路径，先按目录结构暂存到本机上传台
  async function uploadPicked() {
    const batch = 'bg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let done = 0;
    for (const f of pickedFiles) {
      const rel = f.webkitRelativePath || f.name;
      const data = await toBase64(f);
      await api('/api/folder-import/file', { batch, rel, data });
      done += 1;
      $('fi-go').textContent = '正在读取文件夹 ' + done + ' / ' + pickedFiles.length + '…';
      $('fi-progress-bar').style.width = Math.round(done / pickedFiles.length * 12) + '%';
    }
    return batch;
  }

  function markUsedLocal() {
    const now = new Date().toISOString();
    saveLocal((s) => {
      for (const p of pickedPaths) {
        const k = keyOf(p);
        const prev = s.used[k] || {};
        s.used[k] = { name: shortName(p), at: now, times: (Number(prev.times) || 0) + 1 };
      }
    });
  }

  // 缩略图用 blob 生成，避免 HTTPS 页面直接加载 http 图片被浏览器拦掉
  async function thumbs(covers) {
    const box = $('fi-thumbs');
    box.innerHTML = '';
    for (const c of (covers || []).slice(0, 6)) {
      try {
        const res = await fetch(CONSOLE + '/' + c, { cache: 'no-store' });
        if (!res.ok) continue;
        const blob = await res.blob();
        const img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        img.alt = '刚上架的商品图';
        img.onload = () => URL.revokeObjectURL(img.src);
        box.appendChild(img);
      } catch { /* 单张失败不影响其它 */ }
    }
  }

  async function poll() {
    const t0 = Date.now();
    while (Date.now() - t0 < 60 * 60 * 1000) {
      await sleep(1000);
      let s;
      try { s = await api('/api/folder-import/status'); } catch { continue; }
      const pct = s.totalImages
        ? Math.min(99, Math.round(s.images / s.totalImages * 88) + 12)
        : (s.total ? Math.round(s.done / s.total * 88) + 12 : 5);
      $('fi-progress-bar').style.width = pct + '%';
      result('正在自动上架…', '<p>' + esc(s.phase || '正在扫描文件夹…') +
        (s.total ? ' · 已完成 ' + s.done + ' / ' + s.total + ' 个商品' : '') + '</p>', false);
      if (!s.running && s.finishedAt) {
        $('fi-progress-bar').style.width = '100%';
        const r = s.result || {};
        result(s.ok ? '上架完成 ✅' : '没完全成功',
          '<p>' + esc(s.message || '') + '</p>' +
          (r.folders ? '<p>共 ' + r.folders + ' 个商品框、' + r.images + ' 张图，压缩后约 ' + r.megabytes + ' MB。</p>' : '') +
          '<div id="fi-thumbs" class="fi-thumbs"></div>' +
          '<div class="fi-links"><a href="./?t=' + Date.now() + '" target="_blank" rel="noopener">🌐 打开线上相册（客户看到的，已自动同步）↗</a>' +
          '<a href="' + CONSOLE + '/?t=' + Date.now() + '#folder-box" target="_blank" rel="noopener">📁 打开完整上传台 ↗</a></div>',
          !s.ok);
        thumbs(r.covers);
        // 刚用过的文件夹立刻打上「已上架过」，想清掉列表随时点右侧「删除」
        refreshCandidates();
        return;
      }
    }
    result('还在跑', '<p>批量上架比较久，留着这个窗口等一会儿就好，已经建好的商品不会丢。</p>', false);
  }

  btn.addEventListener('click', () => open(true));
  $('fi-close').addEventListener('click', () => { if (!busy) open(false); });
  modal.querySelector('[data-fi-close]').addEventListener('click', () => { if (!busy) open(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden && !busy) open(false);
  });

  $('fi-pick').addEventListener('click', () => { if (!busy) $('fi-input').click(); });
  $('fi-input').addEventListener('change', () => {
    pickedFiles = Array.from($('fi-input').files || []);
    pickedPaths.clear();
    $('fi-candidates').querySelectorAll('.fi-cand').forEach((b) => b.classList.remove('on'));
    hint();
    if (pickedFiles.length) result('文件夹已选好', '<p>共 ' + pickedFiles.length + ' 个文件，点「开始自动上架」即可。</p>', false);
  });
  $('fi-path-add').addEventListener('click', () => {
    const p = $('fi-path').value.trim().replace(/^"|"$/g, '');
    if (!p) return;
    pickedPaths.add(p);
    pickedFiles = [];
    hint();
    result('已加入这个文件夹', '<p>' + esc(p) + '</p><p>点「开始自动上架」就会把里面每个子文件夹变成一件商品。不想要了，点上面小标签的 × 就能删掉。</p>', false);
  });

  $('fi-go').addEventListener('click', async () => {
    if (busy) return;
    if (!pickedPaths.size && !pickedFiles.length) {
      result('先选一个文件夹', '<p>点一下上面自动找到的文件夹，或点「📁 选其它文件夹」。</p>', true);
      return;
    }
    if (!consoleReady) {
      result('还没连上店家电脑', '<p>请在店家那台电脑上双击桌面「Gallery-Upload.bat」，等上传台打开后再点开始。这台设备本身没法读店家电脑里的文件夹。</p>', true);
      return;
    }
    busy = true;
    $('fi-go').disabled = true;
    $('fi-progress').hidden = false;
    $('fi-progress-bar').style.width = '0';
    result('正在准备…', '<p>正在把文件夹交给本机相册，请不要关这个窗口。</p>', false);
    try {
      let batch = '';
      if (pickedFiles.length) batch = await uploadPicked();
      const r = await api('/api/folder-import/start', {
        paths: [...pickedPaths], batch, label: $('fi-label').value.trim() || '组合套装'
      });
      if (!r.ok) throw new Error(r.message || '没能开始');
      markUsedLocal();
      await poll();
    } catch (e) {
      result('没能开始', '<p class="fi-warn">' + esc(e.message) + '</p><p>原文件夹没有改动，重新点一次即可。</p>', true);
    } finally {
      busy = false;
      $('fi-go').disabled = false;
      $('fi-go').textContent = '开始自动上架';
      $('fi-progress').hidden = true;
    }
  });

  // 后台要登录成功、订单区显示出来之后才把这个入口摆出来，客户页面永远看不到
  const syncVisibility = () => {
    const body = $('orders-body');
    const loggedIn = body && !body.hidden;
    btn.hidden = !(loggedIn && isOrders());
  };
  syncVisibility();
  setInterval(syncVisibility, 1000);
})();
