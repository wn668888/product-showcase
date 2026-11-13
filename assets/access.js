/* 主页访问权限：客户进门 + 店家后台设置
   ------------------------------------------------------------------
   公开  → 客户打开链接直接看相册（默认）
   加密  → 客户先输访问密码，输一次这台设备记住；店家改密码后自动要重输
   关闭  → 客户只看到「相册暂时关闭」，下面的商品点不到
   店家后台（?view=orders）永远不被这层门挡住，且只有登录后才能改设置。
   设置存在云端，改完客户刷新页面就生效，不用重新发布一次。
   前端不存账号、密码、店家口令；公开接口读不到访问密码。
   云端不通 / 超时一律降级为「公开」，绝不把客户卡在「正在检查」。
*/
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CFG = window.GALLERY_CLOUD_CONFIG || null;
  const params = new URLSearchParams(location.search);
  const isOrders = () => params.get('view') === 'orders' || document.body.classList.contains('orders-mode');
  const PASS_KEY = 'sg-gallery-access-v1';

  /* index.html 里的兜底定时器：脚本正常加载就撤掉，改由本文件自己的 6 秒超时接管 */
  if (window.__accessFallback) { clearTimeout(window.__accessFallback); window.__accessFallback = null; }
  window.__galleryAccessReady = true;

  let cloud = null;
  try {
    if (CFG && window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud) {
      const c = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
        publishableKey: CFG.publishableKey
      });
      if (c && c.database) cloud = c;
    }
  } catch { cloud = null; }

  async function rpc(name, args, timeoutMs) {
    if (!cloud) throw new Error('cloud unavailable');
    let timer = null;
    const call = Promise.resolve(cloud.database.rpc(name, args || {}));
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs || 8000);
    });
    try {
      const r = await Promise.race([call, guard]);
      if (r && r.error) throw new Error(r.error.message || 'rpc failed');
      return r ? r.data : null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function firstRow(data) {
    if (Array.isArray(data)) return data[0] || {};
    if (data && typeof data === 'object') return data;
    return {};
  }

  function boolOf(data) {
    let v = Array.isArray(data) ? data[0] : data;
    if (v && typeof v === 'object') {
      v = v.shop_access_set ?? v.gallery_access_check ?? v.check ?? v.value;
    }
    return v === true || v === 'true' || v === 1 || v === 't';
  }

  /* ---------------- 客户侧：进门 ---------------- */
  const gate = $('access-gate');
  const states = {
    loading: $('ag-loading'),
    closed: $('ag-closed'),
    password: $('ag-password')
  };
  let current = { mode: 'public', version: 0 };
  let gateBusy = false;

  function showState(kind) {
    if (!gate) return;
    gate.hidden = false;
    Object.keys(states).forEach((k) => { if (states[k]) states[k].hidden = k !== kind; });
  }
  function hideGate() { if (gate) gate.hidden = true; }
  function passedVersion() { try { return localStorage.getItem(PASS_KEY) || ''; } catch { return ''; } }
  function remember(v) { try { localStorage.setItem(PASS_KEY, String(v)); } catch { /* 隐私模式 */ } }
  function forget() { try { localStorage.removeItem(PASS_KEY); } catch { /* 隐私模式 */ } }
  function gateMsg(text) { const m = $('ag-msg'); if (m) m.textContent = text || ''; }

  async function checkAccess() {
    if (!gate || isOrders()) { hideGate(); return; }
    let mode = 'public';
    let version = 0;
    try {
      const row = firstRow(await rpc('gallery_access_get', {}, 6000));
      mode = ['public', 'password', 'closed'].indexOf(row.access_mode) >= 0 ? row.access_mode : 'public';
      version = Number(row.changed_at) || 0;
    } catch {
      hideGate();                 // 云端故障 / 超时：放行，别让客户卡住
      return;
    }
    current = { mode, version };
    if (mode === 'public') { hideGate(); return; }
    if (mode === 'closed') { forget(); showState('closed'); return; }
    if (passedVersion() === String(version)) { hideGate(); return; }
    gateMsg('');
    const input = $('ag-code');
    if (input) input.value = '';
    showState('password');
  }

  async function submitCode() {
    if (gateBusy) return;
    const input = $('ag-code');
    const code = String((input && input.value) || '').trim();
    if (!code) { gateMsg('请先填访问密码'); return; }
    gateBusy = true;
    gateMsg('正在核对…');
    try {
      const ok = boolOf(await rpc('gallery_access_check', { p_code: code }, 8000));
      if (!ok) { gateMsg('密码不对，请再试一次或问店家'); return; }
      /* 再读一次版本号：店家刚好改了密码的话，不能拿旧版本把客户放进去 */
      try {
        const row = firstRow(await rpc('gallery_access_get', {}, 8000));
        if (row.access_mode === 'closed') { forget(); showState('closed'); return; }
        if (row.access_mode !== 'password') { hideGate(); return; }
        remember(Number(row.changed_at) || 0);
      } catch { remember(current.version); }
      gateMsg('');
      hideGate();
    } catch {
      gateMsg('网络没连上，请稍后再试');
    } finally {
      gateBusy = false;
    }
  }

  /* ---------------- 店家侧：后台设置面板 ---------------- */
  function shopKey() {
    try {
      const fn = window.GalleryCart && window.GalleryCart.shopKey;
      return typeof fn === 'function' ? String(fn() || '') : '';
    } catch { return ''; }
  }
  function setMsg(text, warn) {
    const m = $('ac-msg');
    if (!m) return;
    m.textContent = text || '';
    m.hidden = !text;
    m.classList.toggle('ac-msg-warn', !!warn);
  }
  function paintShop() {
    const radio = document.querySelector('input[name="ac-mode"][value="' + shopState.mode + '"]');
    if (radio) radio.checked = true;
    const row = $('ac-code-row');
    if (row) row.hidden = shopState.mode !== 'password';
    const cur = $('ac-current');
    if (cur) {
      cur.textContent = shopState.code
        ? '当前访问密码：' + shopState.code + '（不改动就留空）'
        : '还没设过密码，请在上面填一个';
    }
    const input = $('ac-code');
    if (input) input.value = '';
  }

  let shopState = { mode: 'public', code: '' };
  let shopBusy = false;

  async function loadShop() {
    const key = shopKey();
    if (!key) { setMsg('后台还没登录好，稍等一下再点开', true); return; }
    try {
      const row = firstRow(await rpc('shop_access_get', { p_key: key }, 8000));
      if (!row.access_mode) throw new Error('empty');
      shopState = { mode: row.access_mode, code: String(row.access_code || '') };
      paintShop();
      setMsg('', false);
    } catch {
      setMsg('没读到当前设置，请稍后再试一次', true);
    }
  }

  async function saveShop() {
    if (shopBusy) return;
    const key = shopKey();
    if (!key) { setMsg('后台还没登录好，稍等一下再保存', true); return; }
    const picked = document.querySelector('input[name="ac-mode"]:checked');
    const mode = picked ? picked.value : 'public';
    let code = String((($('ac-code') && $('ac-code').value) || '')).trim();
    if (mode === 'password') {
      if (!code && shopState.code) code = shopState.code;   // 留空 = 沿用
      if (!code) { setMsg('加密要填一个访问密码（4～32 位）', true); return; }
    } else {
      code = '';
    }
    shopBusy = true;
    setMsg('正在保存…', false);
    try {
      const ok = boolOf(await rpc('shop_access_set', { p_key: key, p_mode: mode, p_code: code }, 10000));
      if (!ok) { setMsg('没保存成功（密码要 4～32 位，或登录已过期）', true); return; }
      shopState = { mode: mode, code: mode === 'password' ? code : '' };
      paintShop();
      setMsg('✅ 已保存。客户刷新页面就生效；改过密码的话，之前输过的客户要重新输一次。', false);
    } catch {
      setMsg('网络没连上，请稍后再试', true);
    } finally {
      shopBusy = false;
    }
  }

  function initShopPanel() {
    const btn = $('orders-access');
    const modal = $('access-modal');
    if (!btn || !modal) return;

    const syncVisibility = () => {
      const body = $('orders-body');
      btn.hidden = !(isOrders() && body && !body.hidden);
    };
    const open = () => { modal.hidden = false; setMsg('', false); loadShop(); };
    const close = () => { modal.hidden = true; };

    btn.addEventListener('click', open);
    const cancel = $('ac-cancel');
    if (cancel) cancel.addEventListener('click', close);
    const x = $('ac-close');
    if (x) x.addEventListener('click', close);
    const shade = modal.querySelector('[data-ac-close]');
    if (shade) shade.addEventListener('click', close);
    const save = $('ac-save');
    if (save) save.addEventListener('click', saveShop);
    document.querySelectorAll('input[name="ac-mode"]').forEach((r) => {
      r.addEventListener('change', () => {
        const on = document.querySelector('input[name="ac-mode"]:checked');
        const row = $('ac-code-row');
        if (row) row.hidden = !on || on.value !== 'password';
        setMsg('', false);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
    syncVisibility();
    setInterval(syncVisibility, 1000);
  }

  /* ---------------- 启动 ---------------- */
  if (!isOrders()) {
    checkAccess();
    const go = $('ag-go');
    if (go) go.addEventListener('click', submitCode);
    const codeInput = $('ag-code');
    if (codeInput) {
      codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitCode(); }
      });
    }
    const retry = $('ag-retry');
    if (retry) retry.addEventListener('click', () => { showState('loading'); checkAccess(); });
    /* 从别的标签页切回来时重新核对一次，店家刚改的设置不用等客户手动刷新 */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkAccess();
    });
  } else {
    hideGate();
    initShopPanel();
  }
})();
