/* 简白图库 · 客户选购清单与订单
   ------------------------------------------------------------------
   访客：加购 / 减一 / 移除 / 清空，实时看到件数与合计金额；选好后可「提交订单」。
         前台可读「店家收款码」自行扫码付款；页面只展示二维码，不代收款、
         不自动扣款、不自动改订单状态，订单状态恒为「未付款」。
   云端：加购变动以「只追加」流水保存；订单单独存 customer_orders，只能新增。
         访客读不到、改不了、删不掉任何记录，也碰不到商品图片和资料。
   店家：带口令的独立视图，能看到已提交订单 + 还在挑选的清单，含商品、
         数量、单价、小计与合计金额；后台可上传 / 更换收款码。
*/
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CFG = window.GALLERY_CLOUD_CONFIG || null;
  const LS = {
    list: 'sg-cart-list-v1', guest: 'sg-cart-guest-v1', items: 'sg-cart-items-v1',
    pending: 'sg-cart-pending-v1', shop: 'sg-shop-key-v1',
    phone: 'sg-cart-phone-v1', wechat: 'sg-cart-wechat-v1',
    address: 'sg-cart-address-v1',
    lastOrder: 'sg-cart-last-order-v1',
    /* 只存云端签发的「本机登录凭证」，绝不存账号、密码或店家口令 */
    session: 'sg-shop-session-v1'
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式 */ } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let cloud = null;
  let ready = false;
  let chain = Promise.resolve();
  let lastLists = [];
  let lastPlacedCount = 0;
  /* 店家口令只放内存；本机另外存一枚可撤销的会话凭证，用来免输账号密码 */
  let shopKey = '';
  const listeners = [];
  /* 店家后台「客户新消息未读」：只在店家登录后才会拉，客户页面完全不碰 */
  let unreadMap = new Map();       // order_no -> { count, body, hasImage, at }
  let unreadBusy = false;
  let activeChatOrder = '';
  let lastMarked = { no: '', at: 0 };
  /* 店家后台「点商品查看」：按唯一 key 记住每个商品行的来源，刷新也不会错位 */
  const viewIndex = new Map();
  let frameMap = null;
  let framePromise = null;
  let ivPhotos = [];

  function initCloud() {
    try {
      if (!CFG || !window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) return false;
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
        publishableKey: CFG.publishableKey
      });
      ready = Boolean(cloud && cloud.database);
    } catch { ready = false; }
    return ready;
  }

  function enqueue(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  /* ---------- 本地状态 ---------- */
  function listId() {
    let v = lsGet(LS.list, '');
    if (!v) {
      v = 'L-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      lsSet(LS.list, v);
    }
    return v;
  }
  const shortId = (id) => String(id || '').replace(/^L-/, '').slice(-8).toUpperCase() || '—';
  const myShortId = () => shortId(listId());
  const guest = () => lsGet(LS.guest, '') || '';
  function setGuest(name) { lsSet(LS.guest, String(name || '').trim().slice(0, 30)); }
  /* 输入框里的值优先：客户边填边下单也能带上称呼 / 联系方式，不必先点别处 */
  function liveInput(id, key, max) {
    const el = $(id);
    if (!el) return lsGet(key, '') || '';
    const v = String(el.value || '').trim().slice(0, max);
    if (v) lsSet(key, v);
    return v || lsGet(key, '') || '';
  }
  const currentGuest = () => liveInput('cart-guest', LS.guest, 30);
  const currentPhone = () => liveInput('cart-phone', LS.phone, 40);
  const currentWechat = () => liveInput('cart-wechat', LS.wechat, 40);
  const currentAddress = () => liveInput('cart-address', LS.address, 160);
  function getItems() {
    const v = lsGet(LS.items, []);
    return Array.isArray(v) ? v.filter((x) => x && x.frameId && Number(x.qty) > 0) : [];
  }
  const qtyOf = (frameId) => { const x = getItems().find((i) => i.frameId === frameId); return x ? Number(x.qty) : 0; };

  function money(n) {
    const v = Number(n) || 0;
    return '¥' + v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  function parsePrice(text) {
    const m = String(text || '').replace(/[,，\s]/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  function totals(items) {
    const list = items || getItems();
    return {
      qty: list.reduce((n, x) => n + Number(x.qty || 0), 0),
      amount: list.reduce((n, x) => n + Number(x.qty || 0) * Number(x.price || 0), 0),
      lines: list.length
    };
  }
  function toItem(frame) {
    const d = frame.detail || {};
    const priceText = String(d.price || '').trim();
    return {
      frameId: frame.id,
      title: frame.title || '未命名商品',
      code: String(d.code || '').trim(),
      priceText,
      price: parsePrice(priceText),
      cover: frame.cover || (frame.photos && frame.photos[0] && frame.photos[0].src) || ''
    };
  }
  function eventRow(item, delta) {
    return {
      list_id: listId(), guest_name: currentGuest(),
      frame_id: item.frameId, title: item.title, code: item.code,
      price_text: item.priceText, price: item.price, cover: item.cover,
      delta: Math.trunc(delta)
    };
  }

  /* ---------- 云端只追加流水（失败进待发队列，联网自动补发） ---------- */
  async function flush() {
    const pending = lsGet(LS.pending, []);
    if (!Array.isArray(pending) || !pending.length) return { ok: true };
    if (!ready || !cloud) return { ok: false, message: '暂时没连上相册服务，清单已存在本机，联网后会自动补发' };
    const { error } = await cloud.database.from('cart_events').insert(pending);
    if (error) {
      return { ok: false, message: '同步给店家暂时没成功（' + (error.message || '网络不通') + '）；清单已存在本机，会自动重发' };
    }
    const now = lsGet(LS.pending, []);
    lsSet(LS.pending, Array.isArray(now) ? now.slice(pending.length) : []);
    return { ok: true };
  }
  async function pushRows(rows) {
    const pending = lsGet(LS.pending, []);
    lsSet(LS.pending, (Array.isArray(pending) ? pending : []).concat(rows));
    return flush();
  }

  function notify(result) {
    const items = getItems(), t = totals(items);
    paintCart(items, t, result);
    listeners.forEach((cb) => { try { cb(items, t); } catch { /* noop */ } });
  }

  /* ---------- 对外操作 ---------- */
  function add(frame, delta = 1) {
    if (!frame || !frame.id) return Promise.resolve({ ok: false, message: '商品信息不完整' });
    return enqueue(async () => {
      const item = toItem(frame);
      const items = getItems();
      const idx = items.findIndex((x) => x.frameId === item.frameId);
      let realDelta = Math.trunc(delta);
      if (idx >= 0) {
        const next = Number(items[idx].qty) + realDelta;
        if (next <= 0) { realDelta = -Number(items[idx].qty); items.splice(idx, 1); }
        else items[idx] = { ...item, qty: next };
      } else if (realDelta > 0) {
        items.push({ ...item, qty: realDelta });
      } else {
        return { ok: true, changed: false };
      }
      lsSet(LS.items, items);
      const res = await pushRows([eventRow(item, realDelta)]);
      notify(res);
      return { ok: true, changed: true, ...res };
    });
  }
  function remove(frame) {
    const found = getItems().find((x) => x.frameId === (frame && frame.id));
    if (!found) return Promise.resolve({ ok: true, changed: false });
    return add(frame, -Number(found.qty));
  }
  function clear() {
    return enqueue(async () => {
      const items = getItems();
      if (!items.length) return { ok: true, changed: false };
      const rows = items.map((x) => eventRow(x, -Number(x.qty)));
      lsSet(LS.items, []);
      const res = await pushRows(rows);
      notify(res);
      return { ok: true, changed: true, ...res };
    });
  }

  /* ---------- 提交订单：只下单，不付款 ---------- */
  function orderNo() {
    const d = new Date();
    const day = String(d.getFullYear()).slice(2) +
      String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    return 'WG' + day + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  /* 收件信息三项必填：收件人 / 收件人电话 / 详细地址，缺一项都不给提交订单 */
  function shipProblems() {
    const out = [];
    if (!String(currentGuest() || '').trim()) out.push({ id: 'cart-guest', label: '收件人' });
    const phone = String(currentPhone() || '').trim();
    if (!/^[\d+\-\s()]{6,}$/.test(phone) || phone.replace(/\D/g, '').length < 7) {
      out.push({ id: 'cart-phone', label: '收件人电话' });
    }
    if (String(currentAddress() || '').trim().length < 6) {
      out.push({ id: 'cart-address', label: '详细地址（写到街道门牌号）' });
    }
    return out;
  }
  function markShipProblems(list) {
    ['cart-guest', 'cart-phone', 'cart-address'].forEach((id) => {
      const input = $(id);
      const label = input && input.closest('label');
      if (label) label.classList.toggle('is-missing', list.some((p) => p.id === id));
    });
    const box = $('cart-ship-error');
    if (!box) return;
    if (!list.length) { box.hidden = true; box.textContent = ''; return; }
    box.textContent = '提交订单前请先填好：' + list.map((p) => p.label).join('、') +
      '。带 * 的三项只有店家能看到，不会公开给其他客人。';
    box.hidden = false;
  }
  /* 已经提示过一次后，边填边把红框和错误文案收掉，不用再点一次提交 */
  function syncShipError() {
    const box = $('cart-ship-error');
    if (box && !box.hidden) markShipProblems(shipProblems());
  }

  async function placeOrder() {
    const missing = shipProblems();
    if (missing.length) {
      return { ok: false, message: '请先填完整收件信息：' + missing.map((p) => p.label).join('、') };
    }
    if (!ready || !cloud) {
      return { ok: false, message: '暂时没连上店家服务，请联网后重试（清单不会丢）' };
    }
    return enqueue(async () => {
      const cur = getItems();
      if (!cur.length) return { ok: false, message: '清单还是空的，先加入商品再提交订单' };
      const t = totals(cur);
      const row = {
        order_no: orderNo(),
        list_id: listId(),
        guest_name: currentGuest(),
        wechat_name: currentWechat(),
        phone: currentPhone(),
        address: currentAddress(),
        items: cur.map((x) => ({
          frameId: x.frameId, title: x.title, code: x.code,
          priceText: x.priceText, price: Number(x.price) || 0,
          cover: x.cover, qty: Number(x.qty) || 0
        })),
        qty: t.qty,
        amount: t.amount,
        pay_status: 'unpaid',
        note: ''
      };
      const { error } = await cloud.database.from('customer_orders').insert([row]);
      if (error) {
        return { ok: false, message: '订单没能发出去（' + (error.message || '网络不通') + '）；清单还在，请稍后重试' };
      }
      /* 先按旧清单号生成归零流水，店家的「未下单清单」才不会和订单重复计 */
      const rows = cur.map((x) => eventRow(x, -Number(x.qty)));
      lsSet(LS.items, []);
      lsSet(LS.list, '');
      lsSet(LS.lastOrder, {
        no: row.order_no, qty: row.qty, amount: row.amount,
        wechatName: row.wechat_name, guestName: row.guest_name,
        phone: row.phone, address: row.address,
        at: new Date().toISOString()
      });
      await pushRows(rows);
      notify({ ok: true });
      return { ok: true, orderNo: row.order_no, qty: row.qty, amount: row.amount };
    });
  }

  /* ---------- 访客：购物车侧栏 ---------- */
  function summaryText() {
    const items = getItems(), t = totals(items);
    const lines = ['【选购清单】' + myShortId(),
      '微信名：' + (currentWechat() || '（未填）'),
      '收件人：' + (currentGuest() || '（未填）'),
      '收件人电话：' + (currentPhone() || '（未填）'),
      '详细地址：' + (currentAddress() || '（未填）'), ''];
    items.forEach((x, i) => {
      lines.push(`${i + 1}. ${x.title}${x.code ? '（' + x.code + '）' : ''} × ${x.qty}  ${x.price ? money(x.price * x.qty) : '未标价'}`);
    });
    lines.push('', `共 ${t.qty} 件，合计 ${money(t.amount)}`, '（正式订单请在页面里点「提交订单给店家」；付款请扫「💰 店家收款码」，页面不代收款）');
    return lines.join('\n');
  }

  function lineHtml(x, i) {
    /* 图片和商品名都可点：客户在清单里直接看大图与商品资料 */
    const viewKey = esc(x.frameId || '');
    return `<div class="cart-line">` +
      `<button type="button" class="cart-thumb-btn" data-cart-view="${viewKey}" title="点击查看大图与商品资料" aria-label="查看 ${esc(x.title)} 的大图">` +
        `<img class="cart-thumb" src="${esc(x.cover)}" alt="" loading="lazy">` +
      `</button>` +
      `<div class="cart-line-main">` +
        `<button type="button" class="cart-line-title-btn" data-cart-view="${viewKey}" title="点击查看大图与商品资料">${esc(x.title)}</button>` +
        `<p class="cart-line-meta">${x.code ? '编号 ' + esc(x.code) + ' · ' : ''}${x.price ? esc(money(x.price)) : '未标价'}</p>` +
        `<div class="cart-qty">` +
          `<button type="button" data-act="minus" data-i="${i}" aria-label="减少一件">−</button>` +
          `<span>${Number(x.qty)}</span>` +
          `<button type="button" data-act="plus" data-i="${i}" aria-label="增加一件">＋</button>` +
          `<button type="button" class="cart-remove" data-act="remove" data-i="${i}">移除</button>` +
        `</div>` +
      `</div>` +
      `<span class="cart-subtotal">${x.price ? esc(money(x.price * x.qty)) : '—'}</span>` +
    `</div>`;
  }

  function paintCart(items, t, result) {
    items = items || getItems(); t = t || totals(items);
    const badge = $('cart-count');
    if (badge) { badge.textContent = String(t.qty); badge.hidden = t.qty === 0; }
    const toggle = $('cart-toggle');
    if (toggle) toggle.classList.toggle('has-items', t.qty > 0);

    const box = $('cart-items');
    if (box) {
      box.innerHTML = items.length
        ? items.map(lineHtml).join('')
        : '<div class="cart-empty"><span>🛒</span><p>清单还是空的</p>' +
          '<p>点开任意一个商品框，按「＋ 加入选购清单」就能把商品加进来。</p></div>';
    }
    const q = $('cart-total-qty'), a = $('cart-total-amount'), n = $('cart-total-note');
    if (q) q.textContent = String(t.qty);
    if (a) a.textContent = money(t.amount);
    if (n) n.textContent = items.some((x) => !x.price) ? '含未标价商品，未计入合计' : '';
    const sync = $('cart-sync');
    if (sync) {
      if (result && result.ok === false) {
        sync.hidden = false;
        sync.textContent = '⚠ ' + result.message;
      } else if (!ready) {
        sync.hidden = false;
        sync.textContent = '⚠ 暂时没连上相册服务，清单先存在这台设备上';
      } else sync.hidden = true;
    }
    const copyBtn = $('cart-copy');
    if (copyBtn) copyBtn.disabled = !items.length;
    const clearBtn = $('cart-clear');
    if (clearBtn) clearBtn.disabled = !items.length;
    const orderBtn = $('cart-order');
    if (orderBtn) orderBtn.disabled = !items.length;
    const done = $('cart-order-done');
    if (done) {
      const last = lsGet(LS.lastOrder, null);
      if (last && last.no) {
        done.hidden = false;
        done.innerHTML = '<strong>✔ 订单 ' + esc(last.no) + ' 已提交，店家已收到</strong>' +
          '<span>状态 <b>未付款</b> · ' + esc(String(last.qty)) + ' 件 · ' + esc(money(last.amount)) + '</span>' +
          '<p>订单已保留，状态未付款。想付款就点下面小图放大扫码；付完请和店家确认到账。</p>' +
          '<div id="cart-pay-strip" class="cart-pay-strip"></div>' +
          '<button type="button" class="cart-pay-btn" data-vpay-open="1">💰 看店家收款码，扫码付款</button>' +
          '<button type="button" class="cart-chat-btn" data-chat="' + esc(last.no) + '">💬 联系店家（在线聊）</button>';
        /* 下完单立刻把两张真码放进成功卡，客户不用再点开浮层 */
        renderVisitorPay();
        refreshVisitorPay();
      } else { done.hidden = true; done.innerHTML = ''; }
    }
  }

  function showCartHint(text, kind) {
    const el = $('cart-hint');
    if (!el) return;
    el.hidden = false;
    el.className = 'cart-hint' + (kind ? ' is-' + kind : '');
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.hidden = true; }, 5000);
  }

  async function copySummary() {
    const text = summaryText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('clipboard unavailable');
      showCartHint('✔ 清单已复制，可以直接粘贴发给店家', 'ok');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      showCartHint(ok ? '✔ 清单已复制，可以直接粘贴发给店家' : '复制失败，请手动截图清单', ok ? 'ok' : 'warn');
    }
  }

  function setCartOpen(open) {
    const panel = $('cart-panel'), shade = $('cart-shade');
    if (panel) panel.hidden = !open;
    if (shade) shade.hidden = !open;
    if (open) {
      /* 打开清单时收掉还挂着的加购提示，别让它压住底部「提交订单」按钮 */
      const t = document.getElementById('upload-toast');
      if (t) t.hidden = true;
      $('cart-close')?.focus();
    }
  }

  function bindCart() {
    const toggle = $('cart-toggle');
    const panel = $('cart-panel');
    if (toggle && panel) {
      toggle.addEventListener('click', () => setCartOpen(panel.hidden));
    }
    $('cart-close')?.addEventListener('click', () => setCartOpen(false));
    $('cart-shade')?.addEventListener('click', () => setCartOpen(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel && !panel.hidden) setCartOpen(false);
    });
    const listLabel = $('cart-list-id');
    if (listLabel) listLabel.textContent = myShortId();

    const list = $('cart-items');
    if (list) list.addEventListener('click', (e) => {
      /* 点商品图 / 名称 → 只看商品的大图与资料（不显示店家字段） */
      const view = e.target.closest && e.target.closest('[data-cart-view]');
      if (view) {
        const found = getItems().find((x) => x.frameId === view.dataset.cartView);
        if (found) openItemViewer(found, { customer: true });
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const i = Number(btn.dataset.i);
      const x = getItems()[i];
      if (!x) return;
      const item = { id: x.frameId, title: x.title, cover: x.cover, detail: { code: x.code, price: x.priceText } };
      if (btn.dataset.act === 'plus') add(item, 1);
      else if (btn.dataset.act === 'minus') add(item, -1);
      else if (btn.dataset.act === 'remove') remove(item);
    });

    $('cart-clear')?.addEventListener('click', async () => {
      if (!getItems().length) return;
      if (window.confirm('清空这份选购清单？店家那边也会同步更新。')) {
        await clear();
        showCartHint('清单已清空');
      }
    });
    $('cart-copy')?.addEventListener('click', copySummary);
    /* 收件信息四项一眼可见，填过的值下次自动带回；带 * 的三项边填边校验 */
    const guestInput = $('cart-guest');
    if (guestInput) {
      guestInput.value = guest();
      guestInput.addEventListener('input', () => { setGuest(guestInput.value); syncShipError(); });
      guestInput.addEventListener('change', () => {
        setGuest(guestInput.value);
        showCartHint('✔ 收件人已记下，店家那边能看到', 'ok');
      });
    }
    const wechatInput = $('cart-wechat');
    if (wechatInput) {
      wechatInput.value = lsGet(LS.wechat, '') || '';
      wechatInput.addEventListener('input', () => {
        lsSet(LS.wechat, String(wechatInput.value || '').trim().slice(0, 40));
        syncShipError();
      });
    }
    const phoneInput = $('cart-phone');
    if (phoneInput) {
      phoneInput.value = lsGet(LS.phone, '') || '';
      phoneInput.addEventListener('input', () => {
        lsSet(LS.phone, String(phoneInput.value || '').trim().slice(0, 40));
        syncShipError();
      });
    }
    const addressInput = $('cart-address');
    if (addressInput) {
      addressInput.value = lsGet(LS.address, '') || '';
      addressInput.addEventListener('input', () => {
        lsSet(LS.address, String(addressInput.value || '').trim().slice(0, 160));
        syncShipError();
      });
      addressInput.addEventListener('change', () => {
        showCartHint('✔ 详细地址已记下，下单后店家能看到', 'ok');
      });
    }
    /* 客户侧：订单成功卡里的「联系店家」 */
    $('cart-panel')?.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-chat]');
      if (!b || !window.GalleryChat) return;
      const last = lsGet(LS.lastOrder, null) || {};
      window.GalleryChat.open(b.dataset.chat, {
        shop: false,
        wechatName: last.wechatName || currentWechat(),
        guestName: last.guestName || currentGuest()
      });
    });
    $('cart-order')?.addEventListener('click', async () => {
      if (!getItems().length) return;
      /* 提交前必须填齐收件人 / 收件人电话 / 详细地址，缺一项就高亮并跳到那一栏 */
      const missing = shipProblems();
      markShipProblems(missing);
      if (missing.length) {
        showCartHint('✖ 请先填完整收件信息：' + missing.map((p) => p.label).join('、'), 'warn');
        const first = $(missing[0].id);
        if (first) {
          try { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* noop */ }
          try { first.focus({ preventScroll: true }); } catch { /* noop */ }
        }
        return;
      }
      if (!window.confirm('把这份清单提交成订单给店家？\n收件人：' + currentGuest() + '\n电话：' + currentPhone() + '\n地址：' + currentAddress() +
        '\n\n提交后店家会立刻看到；想付款可点「💰 店家收款码」扫码，页面不代收款、不自动改状态，订单仍是「未付款」。')) return;
      const btn = $('cart-order');
      if (btn) { btn.disabled = true; btn.textContent = '正在提交订单…'; }
      const r = await placeOrder();
      if (btn) btn.textContent = '✅ 提交订单给店家';
      showCartHint(r.ok
        ? '✔ 订单 ' + (r.orderNo || '') + ' 已提交，店家已收到（未付款，可点「💰 店家收款码」扫码付款）'
        : '✖ ' + (r.message || '提交失败，请稍后重试'), r.ok ? 'ok' : 'warn');
      notify(r);
    });
  }

  /* ---------- 店家：客户选购清单 ---------- */
  function ordersMode() {
    return new URLSearchParams(location.search).get('view') === 'orders';
  }
  function timeOf(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function groupOrders(rows) {
    const map = new Map();
    rows.forEach((r) => {
      const id = String(r.list_id || '未知清单');
      if (!map.has(id)) map.set(id, { id, guestName: '', updated: null, items: [] });
      const g = map.get(id);
      if (r.guest_name && !g.guestName) g.guestName = String(r.guest_name);
      if (r.updated_at && (!g.updated || new Date(r.updated_at) > new Date(g.updated))) g.updated = r.updated_at;
      g.items.push({
        frameId: r.frame_id, title: r.title || '未命名商品', code: r.code || '',
        priceText: r.price_text || '', price: Number(r.price) || 0,
        cover: r.cover || '', qty: Number(r.qty) || 0
      });
    });
    const lists = [...map.values()];
    lists.forEach((g) => {
      g.qty = g.items.reduce((n, x) => n + x.qty, 0);
      g.amount = g.items.reduce((n, x) => n + x.qty * x.price, 0);
      g.items.sort((a, b) => (b.qty * b.price) - (a.qty * a.price));
    });
    lists.sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0));
    return lists;
  }

  /* ---------- 店家后台：点商品查看大图与资料（只读） ---------- */
  function ensureFrames() {
    if (frameMap) return Promise.resolve(frameMap);
    if (framePromise) return framePromise;
    framePromise = (async () => {
      const map = new Map();
      try {
        const res = await fetch('./photos/manifest.json?t=' + Date.now(), { cache: 'no-store' });
        if (res && res.ok) {
          const m = await res.json();
          (Array.isArray(m.frames) ? m.frames : []).forEach((f) => {
            if (f && f.id) map.set(f.id, f);
          });
        }
      } catch { /* 读不到索引时，退回用订单里存的封面图 */ }
      frameMap = map;
      return map;
    })();
    return framePromise;
  }
  function regView(key, item, meta) {
    viewIndex.set(key, { item, meta });
    return key;
  }
  const isVideoItem = (p) => String((p && p.type) || '').toLowerCase() === 'video' ||
    /\.(mp4|webm|m4v|ogv)$/i.test(String((p && p.src) || ''));

  function showIvPhoto(i) {
    const p = ivPhotos[i];
    if (!p) return;
    const img = $('iv-photo'), vid = $('iv-video');
    if (isVideoItem(p)) {
      if (img) { img.hidden = true; img.removeAttribute('src'); }
      if (vid) { vid.hidden = false; vid.src = p.src || ''; }
    } else {
      if (vid) {
        vid.hidden = true;
        try { vid.pause(); } catch { /* noop */ }
        vid.removeAttribute('src');
      }
      if (img) { img.hidden = false; img.src = p.src || ''; img.alt = p.title || ''; }
    }
    const thumbs = $('iv-thumbs');
    if (thumbs) {
      [...thumbs.querySelectorAll('[data-iv]')].forEach((b) => {
        b.classList.toggle('is-current', Number(b.dataset.iv) === i);
      });
    }
  }

  async function openItemViewer(item, meta) {
    meta = meta || {};
    const customer = Boolean(meta.customer); // 客户在选购清单里看自己的商品，不显示任何店家字段
    const panel = $('item-viewer');
    if (!panel || !item) return;
    const map = await ensureFrames();
    const frame = map.get(item.frameId) || null;
    const allPhotos = (frame && Array.isArray(frame.photos) && frame.photos.length)
      ? frame.photos : [{ src: item.cover || '', title: item.title || '' }];
    /* 加购 / 下单未付款后，清单和订单里显示的都是「客户当时选的那一张单图」。
       点开放大必须还是这一张：以前按 frameId 取整框图片，最大封面图变成
       整框的拼图、下面还铺一排小图，跟刚加购的那件对不上。
       客户清单、店家后台「挑选中」清单、「已下单未付款」订单三个入口统一处理。 */
    let photos = allPhotos;
    if (item.cover) {
      const picked = allPhotos.filter((p) => p && p.src === item.cover);
      // 老数据的 cover 可能已经不在框里，也直接用它当唯一大图，
      // 保证放大的最大图和清单缩略图永远是同一张。
      photos = picked.length ? picked : [{ src: item.cover, title: item.title || '' }];
    }
    ivPhotos = photos;
    const p = Number(item.price) || 0, q = Number(item.qty) || 0;
    const d = (frame && frame.detail) || {};
    $('iv-title').textContent = item.title || '未命名商品';
    $('iv-order').textContent = customer
      ? (photos.length > 1 ? '🛒 我选的商品 · 点下方小图可切换其他图片' : '🛒 我选的这个商品')
      : meta.orderNo
        ? '订单 ' + meta.orderNo + ' · 未付款'
        : '清单 ' + shortId(meta.listId || '') + ' · 还在挑选中（未下单）';
    const fields = [
      ['商品编号', item.code || d.code || '—'],
      ['单价', p ? money(p) : '未标价'],
      ['数量', String(q)],
      ['小计', p ? money(p * q) : '—'],
      ['尺寸', d.size || '—'],
      ['成色', d.condition || '—'],
      ['分类', (frame && frame.categoryLabel) || '—']
    ];
    if (!customer) {
      fields.push(['客户微信名', meta.wechatName || '客户未填'], ['客户称呼', meta.guestName || '—']);
    }
    $('iv-fields').innerHTML = fields.map(([k, v]) =>
      `<div><em>${esc(k)}</em><span>${esc(v)}</span></div>`).join('');
    $('iv-desc').textContent = d.description || d.note || '';
    const note = $('iv-note');
    if (note) note.textContent = customer
      ? '这里只是看商品大图和资料，不能改价；关掉后回到选购清单继续挑。'
      : '这里只能查看商品，不能改价、不能收款；订单状态仍是「未付款」。';
    const card = panel.querySelector('.iv-card');
    if (card) card.setAttribute('aria-label', customer ? '查看商品大图' : '查看订单商品');
    const thumbs = $('iv-thumbs');
    if (thumbs) {
      thumbs.innerHTML = photos.map((x, i) =>
        `<button type="button" data-iv="${i}" class="iv-thumb ${i === 0 ? 'is-current' : ''}" aria-label="第 ${i + 1} 张">` +
        `<img src="${esc(x.src || '')}" alt="" loading="lazy"></button>`).join('');
      thumbs.hidden = photos.length <= 1;
    }
    showIvPhoto(0);
    panel.hidden = false;
    const close = $('iv-close');
    if (close) { try { close.focus(); } catch { /* noop */ } }
  }

  function closeItemViewer() {
    const panel = $('item-viewer');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    const vid = $('iv-video');
    if (vid) {
      try { vid.pause(); } catch { /* noop */ }
      vid.removeAttribute('src');
    }
  }

  function paintOrders(lists) {
    const allQty = lists.reduce((n, g) => n + g.qty, 0);
    const allAmount = lists.reduce((n, g) => n + g.amount, 0);
    const noPrice = lists.reduce((n, g) => n + g.items.filter((x) => !x.price).length, 0);
    $('orders-list-count').textContent = String(lists.length);
    $('orders-qty').textContent = String(allQty);
    $('orders-amount').textContent = money(allAmount);
    $('orders-noprice').textContent = String(noPrice);

    const box = $('orders-lists');
    if (!box) return;
    if (!lists.length) {
      box.innerHTML = '<div class="orders-empty"><p>暂时还没有客户加购记录</p>' +
        '<p>把相册链接发给客户，客户点开商品框加入清单后，这里会自动出现商品、数量和合计金额。点「↻ 刷新」可随时更新。</p></div>';
      return;
    }
    box.innerHTML = lists.map((g) => `<section class="orders-card">` +
      `<header class="orders-card-head">` +
        `<div><h2>${esc(g.guestName || '客人 ' + shortId(g.id))}</h2>` +
        `<p>清单 ${esc(shortId(g.id))} · ${esc(timeOf(g.updated) || '刚刚')} · ${g.items.length} 种商品</p></div>` +
        `<div class="orders-card-total"><em>这份清单合计</em><strong>${esc(money(g.amount))}</strong><span>${g.qty} 件</span></div>` +
      `</header>` +
      `<div class="orders-table-wrap"><table class="orders-table"><thead><tr>` +
        `<th>商品</th><th>编号</th><th>单价</th><th>数量</th><th>小计</th>` +
      `</tr></thead><tbody>` +
      g.items.map((x, ri) => {
        const key = regView('L:' + g.id + ':' + ri + ':' + (x.frameId || ''), x, {
          listId: g.id, guestName: g.guestName || '', wechatName: g.guestName || ''
        });
        return `<tr>` +
          `<td class="orders-pname"><button type="button" class="orders-item-btn" data-view="${esc(key)}" title="点击查看商品大图与资料">` +
          `<img src="${esc(x.cover)}" alt="" loading="lazy"><span>${esc(x.title)} 🔍</span></button></td>` +
          `<td>${esc(x.code || '—')}</td>` +
          `<td>${x.price ? esc(money(x.price)) : '未标价'}</td>` +
          `<td><strong>${x.qty}</strong></td>` +
          `<td>${x.price ? esc(money(x.price * x.qty)) : '—'}</td>` +
        `</tr>`;
      }).join('') +
      `</tbody></table></div></section>`).join('');
  }

  /* ---------- 店家：已提交订单（全部「未付款」） ---------- */
  function paintPlacedOrders(rows) {
    const list = Array.isArray(rows) ? rows : [];
    lastPlacedCount = list.length;
    const countEl = $('orders-placed-count');
    if (countEl) countEl.textContent = list.length
      ? `共 ${list.length} 单 · 全部「未付款」（前台只展示收款码，不代收款，请自行核对到账）`
      : '暂时还没有客户提交订单';
    const box = $('orders-placed');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="orders-empty"><p>还没有客户提交订单</p>' +
        '<p>客户在「🛒 选购清单」里按「✅ 提交订单」后，订单会自动出现在这里，不用刷新。</p></div>';
      return;
    }
    box.innerHTML = list.map((o) => {
      let items = [];
      try { items = Array.isArray(o.items) ? o.items : JSON.parse(o.items || '[]'); } catch { items = []; }
      if (!Array.isArray(items)) items = [];
      const name = o.guest_name || '客人 ' + shortId(o.list_id);
      const wechat = String(o.wechat_name || '').trim();
      const phone = String(o.phone || '').trim();
      const addr = String(o.address || '').trim();
      const contact = phone
        ? `<p class="orders-ship-line">收件人电话：<strong>${esc(phone)}</strong></p>` : '';
      const addrLine = addr
        ? `<p class="orders-ship-line">详细地址：<strong>${esc(addr)}</strong></p>` : '';
      const wxLine = wechat
        ? `<p class="orders-wechat">微信名：<strong>${esc(wechat)}</strong></p>`
        : '<p class="orders-wechat">微信名：客户未填</p>';
      return `<section class="orders-card is-order">` +
        `<header class="orders-card-head">` +
          `<div><h2>📦 ${esc(o.order_no || '订单')} <span class="orders-unpaid">未付款</span></h2>` +
          `<p>收件人：<strong>${esc(name)}</strong> · 清单 ${esc(shortId(o.list_id))} · ${esc(timeOf(o.created_at) || '刚刚')} · ${items.length} 种商品</p>${wxLine}${contact}${addrLine}</div>` +
          `<div class="orders-card-total"><em>订单合计</em><strong>${esc(money(o.amount))}</strong><span>${Number(o.qty) || 0} 件</span></div>` +
        `</header>` +
        `<div class="orders-table-wrap"><table class="orders-table"><thead><tr>` +
          `<th>商品</th><th>编号</th><th>单价</th><th>数量</th><th>小计</th>` +
        `</tr></thead><tbody>` +
        items.map((x, ri) => {
          const p = Number(x.price) || 0, q = Number(x.qty) || 0;
          const key = regView('O:' + (o.order_no || '') + ':' + ri + ':' + (x.frameId || ''), x, {
            orderNo: o.order_no || '', guestName: name, wechatName: wechat
          });
          return `<tr><td class="orders-pname"><button type="button" class="orders-item-btn" data-view="${esc(key)}" title="点击查看商品大图与资料">` +
            `<img src="${esc(x.cover || '')}" alt="" loading="lazy"><span>${esc(x.title || '未命名商品')} 🔍</span></button></td>` +
            `<td>${esc(x.code || '—')}</td><td>${p ? esc(money(p)) : '未标价'}</td>` +
            `<td><strong>${q}</strong></td><td>${p ? esc(money(p * q)) : '—'}</td></tr>`;
        }).join('') +
        `</tbody></table></div>` +
        `<p class="orders-order-note">⚠ 客户前台能看到店家收款码自行扫码；页面只展示二维码，不代收款、不自动改状态，请核对到账后再确认。</p>` +
        `<div class="orders-card-actions">` +
          `<button type="button" class="fd-btn orders-chat-btn" data-chat="${esc(o.order_no || '')}" data-wechat="${esc(wechat)}" data-guest="${esc(name)}">💬 和客户聊天</button>` +
        `</div>` +
      `</section>`;
    }).join('');
  }

  /* ---------- 店家后台：客户新消息不用点进聊天就能看到 ----------
     云端按「店家最后一次读到哪条消息」统计未读；这里只负责把红点数字、
     买家最新一句话和顶部汇总画到已经渲染好的订单卡片上，不重绘整张表格。 */
  function paintUnread() {
    const bar = $('orders-unread-bar');
    const text = $('orders-unread-text');
    let orders = 0, total = 0;
    unreadMap.forEach((v) => {
      const n = Math.max(0, Number(v && v.count) || 0);
      if (n > 0) { orders += 1; total += n; }
    });
    if (bar) bar.hidden = orders === 0;
    if (text) text.textContent = orders
      ? `🔔 ${orders} 个订单收到客户新消息，共 ${total} 条还没看 · 订单卡片上的红色数字就是没读的条数`
      : '';
    document.querySelectorAll('#orders-placed [data-chat]').forEach((btn) => {
      const no = btn.getAttribute('data-chat') || '';
      const rec = unreadMap.get(no);
      const n = rec ? Math.max(0, Number(rec.count) || 0) : 0;
      let badge = btn.querySelector('.orders-chat-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'orders-chat-badge';
        badge.setAttribute('aria-label', '未读消息');
        btn.appendChild(badge);
      }
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = n === 0;
      btn.classList.toggle('has-unread', n > 0);

      const actions = btn.closest('.orders-card-actions');
      if (!actions) return;
      let pv = actions.querySelector('.orders-chat-preview');
      if (!pv) {
        pv = document.createElement('p');
        pv.className = 'orders-chat-preview';
        actions.insertBefore(pv, btn);
      }
      if (n > 0 && rec) {
        const who = btn.getAttribute('data-wechat') || btn.getAttribute('data-guest') || '客户';
        let body = rec.hasImage ? '📷 发来一张图片' : String(rec.body || '新消息');
        body = body.replace(/\s+/g, ' ').trim().slice(0, 48);
        pv.textContent = `💬 ${who}：${body}${n > 1 ? ` …（还有 ${n - 1} 条没看）` : ''}`;
        pv.hidden = false;
      } else {
        pv.hidden = true;
        pv.textContent = '';
      }
    });
  }

  async function refreshUnread() {
    if (!ready || !cloud || !shopKey || unreadBusy) return;
    const panel = $('chat-panel');
    if (activeChatOrder && panel && panel.hidden) activeChatOrder = '';
    unreadBusy = true;
    try {
      const { data, error } = await cloud.database.rpc('shop_chat_unread', { p_key: shopKey });
      if (error) throw new Error(error.message || '读取未读失败');
      const map = new Map();
      (Array.isArray(data) ? data : []).forEach((r) => {
        const no = String((r && r.order_no) || '').trim();
        const n = Number((r && r.unread_count) || 0);
        if (!no || n <= 0) return;
        /* 店家此刻正开着这一单的聊天，就不算未读，避免红点闪回来 */
        const openPanel = $('chat-panel');
        if (no === activeChatOrder && openPanel && !openPanel.hidden) return;
        map.set(no, {
          count: n,
          body: String((r && r.last_body) || ''),
          hasImage: Boolean(r && r.last_has_image),
          at: (r && r.last_at) || ''
        });
      });
      unreadMap = map;
      paintUnread();
    } catch { /* 静默，下一次自动刷新再试，不要盖掉订单状态文字 */ }
    unreadBusy = false;
  }

  async function markChatRead(orderNo) {
    const no = String(orderNo || '').trim();
    if (!no) return;
    activeChatOrder = no;
    unreadMap.delete(no);
    paintUnread();               /* 先把红点立刻抹掉，再慢慢告诉云端 */
    const now = Date.now();
    if (lastMarked.no === no && now - lastMarked.at < 4000) return;
    lastMarked = { no, at: now };
    if (!ready || !cloud || !shopKey) return;
    try {
      await cloud.database.rpc('shop_chat_mark_read', { p_key: shopKey, p_order_no: no });
    } catch { /* 下次打开聊天会再标一次 */ }
  }

  /* 店家：客户加购后又取消的清单，避免「明明加了怎么不显示」的困惑 */
  function paintCancelled(rows) {
    const box = $('orders-cancelled');
    if (!box) return;
    const list = (Array.isArray(rows) ? rows : []).filter((r) => Number(r.added_qty) > 0);
    if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<strong>ℹ 另有 ' + list.length + ' 份清单客户加购后又全部取消，所以不计入上面的合计</strong>' +
      '<ul>' + list.map((r) => `<li>清单 ${esc(shortId(r.list_id))} · 曾加购 ${Number(r.added_qty)} 件 / ${Number(r.kinds)} 种商品 · ${esc(timeOf(r.last_at))} · 已移除或清空</li>`).join('') + '</ul>' +
      '<p>客户把商品减到 0 或点「清空」，这份清单就不再显示；已经「提交订单」的订单不受影响，会一直保留在订单区。</p>';
  }

  function exportCsv() {
    if (!lastLists.length) return;
    const rows = [['清单', '称呼', '时间', '商品', '编号', '单价', '数量', '小计']];
    lastLists.forEach((g) => g.items.forEach((x) => rows.push([
      shortId(g.id), g.guestName || '', timeOf(g.updated), x.title, x.code || '',
      x.price || '', x.qty, x.price ? (x.price * x.qty).toFixed(2) : ''
    ])));
    const csv = '\ufeff' + rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '客户选购清单-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch { /* noop */ } }, 1500);
  }

  async function checkKey(key) {
    if (!ready || !cloud) throw new Error('云服务没连上，请通过正式线上链接打开');
    if (CFG && location.origin !== new URL(CFG.endpoint).origin) {
      throw new Error('请用桌面「店家看订单-勿转发」快捷方式打开正式线上页面（本机预览读不到云端数据）');
    }
    const { data, error } = await cloud.database.rpc('cart_check_key', { p_key: key });
    if (error) throw new Error(error.message || '口令校验失败');
    let v = Array.isArray(data) ? data[0] : data;
    if (v && typeof v === 'object') v = v.cart_check_key ?? v.check ?? v.value;
    return v === true || v === 'true' || v === 1 || v === 't';
  }

  /* ---------- 店家：账号密码登录 + 本机保持登录 ----------
     账号和密码只存在云端，页面源码里一个字都没有。登录成功由云端返回店家口令，
     之后沿用原来的清单 / 订单 / 收款码读取，不用改动任何数据结构。
     登录后云端额外签发一枚随机「本机凭证」存 localStorage：下次打开后台用它换回
     店家口令，就不用再输账号密码。凭证可撤销、会过期，且不是账号密码或主口令；
     退出登录会同时撤销云端凭证并清掉本机记录。客户链接永远拿不到这枚凭证。 */
  function sessionToken() {
    try { return String(lsGet(LS.session, '') || '').trim(); } catch { return ''; }
  }
  function clearShopSession() {
    try { localStorage.removeItem(LS.session); } catch { /* 隐私模式 */ }
  }
  function showAutoLogin(on) {
    const tag = $('orders-autologin');
    if (tag) tag.hidden = !on;
  }

  /* 用本机凭证换回店家口令：只在店家后台视图里跑，客户页面一次都不会调 */
  async function restoreShopSession() {
    if (shopKey) return true;                 // 本地 / 回归用 k 注入过，就不必再恢复
    const token = sessionToken();
    if (!token || !ready || !cloud) return false;
    try {
      const { data, error } = await cloud.database.rpc('shop_session_resume', { p_token: token });
      if (error) return false;               // 网络不通先留着凭证，下次再试
      let v = Array.isArray(data) ? data[0] : data;
      if (v && typeof v === 'object') v = v.shop_session_resume ?? v.value ?? v.shop_key;
      const key = typeof v === 'string' ? v.trim() : '';
      if (!key || key.length < 8) { clearShopSession(); return false; }
      shopKey = key;
      showAutoLogin(true);
      return true;
    } catch { return false; }
  }

  /* 登录成功后签发并保存本机凭证；存不下也不影响本次使用 */
  async function issueShopSession() {
    if (!ready || !cloud || !shopKey) return;
    try {
      const { data, error } = await cloud.database.rpc('shop_session_issue', { p_key: shopKey });
      if (error) return;
      let v = Array.isArray(data) ? data[0] : data;
      if (v && typeof v === 'object') v = v.shop_session_issue ?? v.value ?? v.token;
      const token = typeof v === 'string' ? v.trim() : '';
      if (token && token.length >= 32) lsSet(LS.session, token);
    } catch { /* 存不下就下次再输一次 */ }
  }

  /* 退出登录：撤销云端凭证（换设备不受影响），再清本机记录 */
  function revokeShopSession(key) {
    const token = sessionToken();
    clearShopSession();
    if (!token || !ready || !cloud || !key) return;
    try {
      cloud.database.rpc('shop_session_revoke', { p_key: key, p_token: token });
    } catch { /* 本机已经清掉，撤销失败也不会自动登录回来 */ }
  }

  function gateMsg(text, kind) {
    const el = $('orders-gate-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'orders-gate-msg' + (kind ? ' is-' + kind : '');
  }
  function showGate(message, kind) {
    const gate = $('orders-gate'); if (gate) gate.hidden = false;
    const body = $('orders-body'); if (body) body.hidden = true;
    const payBtn = $('orders-pay'); if (payBtn) payBtn.hidden = true;
    const logout = $('orders-logout'); if (logout) logout.hidden = true;
    showAutoLogin(false);
    payLoaded = false;
    closePay();
    if (message !== undefined) gateMsg(message, kind);
    else gateMsg('');
    const status = $('orders-status'); if (status) status.textContent = '';
    const unreadBar = $('orders-unread-bar'); if (unreadBar) unreadBar.hidden = true;
  }
  async function shopLogin(account, password) {
    if (!ready || !cloud) return { ok: false, message: '暂时没连上店家服务，请联网后再试' };
    const { data, error } = await cloud.database.rpc('shop_login', {
      p_account: account, p_password: password
    });
    if (error) return { ok: false, message: '登录没成功（' + (error.message || '网络不通') + '），请稍后再试' };
    let v = Array.isArray(data) ? data[0] : data;
    if (v && typeof v === 'object') v = v.shop_login ?? v.value ?? v.shop_key;
    const key = typeof v === 'string' ? v.trim() : '';
    if (!key || key.length < 8) return { ok: false, message: '账号或密码不对，请重新输入' };
    return { ok: true, key };
  }
  /* 前台右上角「店家登录」：复用同一套账号密码校验，成功后把口令放内存、
     再签发本机免登录凭证；前台页面平时一次都不会调这些店家接口。 */
  async function loginFromFront(account, password) {
    const r = await shopLogin(account, password);
    if (!r.ok) return r;
    shopKey = r.key;
    await issueShopSession();
    return { ok: true };
  }
  function hasShopSession() { return Boolean(sessionToken()); }
  function shopLogout() {
    revokeShopSession(shopKey);   // 撤销云端凭证并清掉本机记录，下次必须重新输账号密码
    shopKey = '';
    unreadMap = new Map();
    activeChatOrder = '';
    lastMarked = { no: '', at: 0 };
    paintUnread();
    /* 早期版本可能在本机存过「记住登录」，退出时彻底删掉，不留任何残留 */
    try { localStorage.removeItem(LS.shop); } catch { /* 隐私模式 */ }
    payCodes = [];
    payLoaded = false;
    /* 老链接里可能还带着口令参数，退出时顺手抹掉，别留在地址栏里 */
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('k')) {
        u.searchParams.delete('k');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } catch { /* 预览环境不支持就忽略 */ }
    const pw = $('orders-password'); if (pw) pw.value = '';
    showGate('已退出登录，这台设备的自动登录也取消了。想再看订单，请重新输一次账号和密码。');
  }

  async function refreshOrders(key) {
    const status = $('orders-status');
    const k = key || shopKey || '';
    if (!k) {
      showGate('请先输一次账号和密码登录；登录过之后这台设备就会自动保持登录。');
      return;
    }
    if (status) status.textContent = '正在读取客户清单…';
    try {
      const ok = await checkKey(k);
      if (!ok) {
        showGate('口令不对，或登录已过期，请重新输入账号和密码。', 'warn');
        return;
      }
      shopKey = k;
      const { data, error } = await cloud.database.rpc('cart_summary', { p_key: k });
      if (error) throw new Error(error.message || '读取清单失败');
      lastLists = groupOrders(Array.isArray(data) ? data : []);
      const gate = $('orders-gate'); if (gate) gate.hidden = true;
      const body = $('orders-body'); if (body) body.hidden = false;
      /* 收款码只在店家口令通过后才出现；客户页面永远没有这个按钮 */
      const payBtn = $('orders-pay'); if (payBtn) payBtn.hidden = false;
      const logout = $('orders-logout'); if (logout) logout.hidden = false;
      gateMsg('');
      if (!payLoaded) refreshPayCodes(); // 收款码卡片在 orders-body 里，随后台一起出现
      paintOrders(lastLists);
      try {
        const [placed, cancelled] = await Promise.all([
          cloud.database.rpc('orders_summary', { p_key: k }),
          cloud.database.rpc('cart_cancel_summary', { p_key: k })
        ]);
        paintPlacedOrders(placed && placed.data);
        paintCancelled(cancelled && cancelled.data);
      } catch {
        paintPlacedOrders([]);
        paintCancelled([]);
      }
      /* 订单卡片刚重绘过，先把已有红点补回去，再拉一次最新未读 */
      paintUnread();
      refreshUnread();
      if (status) status.textContent = `已更新 · ${lastPlacedCount} 单订单、${lastLists.length} 份待下单清单、${lastLists.reduce((n, g) => n + g.qty, 0)} 件商品`;
    } catch (err) {
      if (status) status.textContent = '✖ ' + (err.message || '读取失败，请稍后点「↻ 刷新」重试');
    }
  }

  /* ---------- 店家专用：收款码（客户页面没有入口，也不代收款） ----------
     微信 / 支付宝两个槽位都存在云端，只有店家口令能读能写；手机、电脑打开
     店家后台都能换码，改完所有设备立刻看到，不依赖本机上传台、也不用重新发布。 */
  const PAY_SLOTS = [
    { slot: 'wechat', label: '微信支付', icon: '💚' },
    { slot: 'alipay', label: '支付宝', icon: '💙' }
  ];
  let payCodes = [];        // [{ slot, label, src, changedAt }]
  let payLoaded = false;    // 本次会话是否已成功从云端读过
  let payBusy = false;      // 正在上传，避免连点重复提交
  let payPendingSlot = '';  // 卡片里点「更换」后，等待选图的槽位
  let payActiveSlot = '';   // 浮层当前显示 / 待更换的槽位

  function closePay() {
    const v = $('pay-viewer');
    if (v) v.hidden = true;
  }
  function payStatus(text, kind) {
    [['pv-status', 'pv-status'], ['pay-card-status', 'pay-status']].forEach(([id, cls]) => {
      const s = $(id);
      if (!s) return;
      s.hidden = !text;
      s.className = cls + (kind ? ' is-' + kind : '');
      s.textContent = text || '';
    });
  }
  function shopPayKey() { return shopKey || ''; }
  function paySlotDef(slot) { return PAY_SLOTS.find((x) => x.slot === slot) || null; }
  function renderPayCodes() {
    const box = $('pay-card-list');
    if (!box) return;
    box.innerHTML = PAY_SLOTS.map((d) => {
      const rec = payCodes.find((x) => x.slot === d.slot) || {};
      const src = rec.src || '';
      const media = src
        ? `<button class="pay-slot-img" type="button" data-pay-zoom="${d.slot}" aria-label="放大${esc(d.label)}收款码"><img src="${esc(src)}" alt="${esc(d.label)}收款码"></button>`
        : `<p class="pay-slot-empty">这张还没上传。点下面绿色按钮选一张${esc(d.label)}收款码图片就行。</p>`;
      const zoom = src ? `<button class="pay-zoom" type="button" data-pay-zoom="${d.slot}">🔍 放大给客户扫</button>` : '';
      return `<div class="pay-slot" data-pay-slot="${d.slot}">` +
        `<div class="pay-slot-head"><span class="pay-slot-name">${d.icon} ${esc(d.label)}</span>` +
        `<span class="pay-slot-tag">${src ? '已上传' : '未上传'}</span></div>` +
        media +
        `<div class="pay-slot-actions">` +
          `<button class="pay-upload" type="button" data-pay-upload="${d.slot}">⬆ 上传 / 更换${esc(d.label)}码</button>` +
          zoom +
        `</div></div>`;
    }).join('');
  }
  function showPaySlot(slot) {
    const d = paySlotDef(slot) || PAY_SLOTS[0];
    payActiveSlot = d.slot;
    const rec = payCodes.find((x) => x.slot === d.slot) || {};
    const src = rec.src || '';
    const title = $('pv-title'); if (title) title.textContent = d.label + '收款码';
    const img = $('pv-qr'), empty = $('pv-empty');
    if (src) {
      if (img) { img.hidden = false; img.src = src; img.alt = d.label + '收款码'; }
      if (empty) empty.hidden = true;
    } else {
      if (img) { img.hidden = true; img.removeAttribute('src'); }
      if (empty) { empty.hidden = false; empty.textContent = '这张' + d.label + '收款码还没上传，点下面按钮选一张图片就行。'; }
    }
    const actions = $('pv-actions'); if (actions) actions.hidden = false;
    const up = $('pv-upload'); if (up) up.textContent = '⬆ 上传 / 更换这张' + d.label + '收款码';
  }
  async function refreshPayCodes(force) {
    if (!ordersMode()) return;                     // 客户页面一律不碰收款码
    const key = shopPayKey();
    if (!key || !ready || !cloud) return;
    if (payLoaded && !force) return;
    try {
      const { data, error } = await cloud.database.rpc('shop_pay_codes_get', { p_key: key });
      if (error) throw new Error(error.message || '读取收款码失败');
      payCodes = (Array.isArray(data) ? data : []).map((r) => ({
        slot: r.code_slot || r.slot || '',
        label: r.code_label || r.label || '',
        src: r.code_src || r.src || '',
        changedAt: r.changed_at || ''
      }));
      payLoaded = true;
      renderPayCodes();
      const v = $('pay-viewer');
      if (v && !v.hidden && payActiveSlot) showPaySlot(payActiveSlot);
    } catch {
      payLoaded = false;
      renderPayCodes();
      payStatus('✖ 暂时读不到收款码，稍后会自动重试。', 'warn');
    }
  }
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || '')) { reject(new Error('请选一张图片文件')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读不到这张图片，请换一张'));
      reader.onload = () => {
        const raw = String(reader.result || '');
        /* 常见格式且大小合适就直接用原图，不重新编码，二维码最清晰 */
        if (/^data:image\/(png|jpeg|webp);base64,/.test(raw) && raw.length <= 1800000) {
          resolve(raw); return;
        }
        /* 其它格式或超大图：逐档缩小并转 JPEG，保证能扫又不会撑爆云端请求 */
        const im = new Image();
        im.onerror = () => reject(new Error('这张图片打不开，请换一张'));
        im.onload = () => {
          try {
            const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
            const c = document.createElement('canvas');
            const ctx = c.getContext('2d');
            for (const max of [1200, 900, 700, 520]) {
              const scale = Math.min(1, max / Math.max(w, h));
              c.width = Math.max(1, Math.round(w * scale));
              c.height = Math.max(1, Math.round(h * scale));
              ctx.clearRect(0, 0, c.width, c.height);
              ctx.drawImage(im, 0, 0, c.width, c.height);
              const out = c.toDataURL('image/jpeg', 0.92);
              if (out.length <= 1800000) { resolve(out); return; }
            }
            reject(new Error('这张图片太大了，请截图小一点或换一张收款码图片'));
          } catch { reject(new Error('图片处理失败，请换一张')); }
        };
        im.src = raw;
      };
      reader.readAsDataURL(file);
    });
  }
  async function uploadPayCode(file, slot) {
    if (payBusy) return;
    const target = paySlotDef(slot);
    if (!target) return;
    const key = shopPayKey();
    if (!ordersMode() || !key || !ready || !cloud) {
      payStatus('✖ 请用「店家看订单-勿转发」链接打开后台再上传。', 'warn');
      return;
    }
    payBusy = true;
    const btns = [...document.querySelectorAll('[data-pay-upload]'), $('pv-upload')].filter(Boolean);
    btns.forEach((b) => { b.disabled = true; });
    payStatus('正在上传' + target.label + '收款码…');
    try {
      const dataUrl = await fileToDataUrl(file);
      const { data, error } = await cloud.database.rpc('shop_pay_code_set_slot', {
        p_key: key, p_slot: target.slot, p_src: dataUrl
      });
      if (error) throw new Error(error.message || '保存失败，请重试');
      let ok = Array.isArray(data) ? data[0] : data;
      if (ok && typeof ok === 'object') ok = ok.shop_pay_code_set_slot ?? ok.value;
      if (!(ok === true || ok === 'true' || ok === 1 || ok === 't')) {
        throw new Error('保存没成功，请换一张收款码截图再试');
      }
      const rec = payCodes.find((x) => x.slot === target.slot);
      if (rec) { rec.src = dataUrl; rec.changedAt = new Date().toISOString(); }
      else payCodes.push({ slot: target.slot, label: target.label, src: dataUrl, changedAt: '' });
      payLoaded = true;
      renderPayCodes();
      const v = $('pay-viewer');
      if (v && !v.hidden && payActiveSlot === target.slot) showPaySlot(target.slot);
      payStatus('✔ ' + target.label + '收款码已保存！所有设备打开店家后台立刻能看到，不用再发布。', 'ok');
    } catch (err) {
      payStatus('✖ ' + (err.message || '保存失败，请重试'), 'warn');
    } finally {
      payBusy = false;
      [...document.querySelectorAll('[data-pay-upload]'), $('pv-upload')].filter(Boolean)
        .forEach((b) => { b.disabled = false; });
      ['pv-file', 'pay-card-file'].forEach((id) => { const f = $(id); if (f) f.value = ''; });
    }
  }
  function openPay(slot) {
    const btn = $('orders-pay'), v = $('pay-viewer');
    if (!btn || !v || btn.hidden) return; // 口令没通过、或不是店家页面，一律不给开
    v.hidden = false;
    const c = $('pv-close');
    if (c) { try { c.focus(); } catch { /* noop */ } }
    const first = (payCodes.find((x) => x.src) || {}).slot || PAY_SLOTS[0].slot;
    showPaySlot(typeof slot === 'string' && slot ? slot : first);
    if (!payLoaded) refreshPayCodes();
  }

  /* ---------- 前台客户：只读收款码（方便扫码付款） ----------
     走公开只读 RPC customer_pay_codes_get()，不带任何店家口令。
     客户只能看 / 放大，不能上传、更换、改订单状态，也不往云端写任何东西。
     懒加载：只有打开浮层或提交订单成功时才读，首页不会白白拉两张大图。 */
  let visitorPayCodes = [];
  let visitorPayLoaded = false;
  let visitorPayBusy = false;
  let visitorPayZoomSlot = '';

  function visitorPayStatus(text, kind) {
    const s = $('cpay-status');
    if (!s) return;
    s.hidden = !text;
    s.className = 'cpay-status' + (kind ? ' is-' + kind : '');
    s.textContent = text || '';
  }

  function renderVisitorPay() {
    const box = $('cpay-list');
    if (box) {
      box.innerHTML = PAY_SLOTS.map((d) => {
        const rec = visitorPayCodes.find((x) => x.slot === d.slot) || {};
        const src = rec.src || '';
        const media = src
          ? `<button class="cpay-slot-img" type="button" data-vpay-zoom="${d.slot}" aria-label="放大${esc(d.label)}收款码"><img src="${esc(src)}" alt="${esc(d.label)}收款码"></button>`
          : `<p class="cpay-slot-empty">店家还没上传这张${esc(d.label)}收款码，可以先扫另一张，或联系店家要。</p>`;
        const zoom = src ? `<button class="cpay-zoom-btn" type="button" data-vpay-zoom="${d.slot}">🔍 放大这张码</button>` : '';
        return `<div class="cpay-slot" data-vpay-slot="${d.slot}">` +
          `<div class="cpay-slot-head"><span class="cpay-slot-name">${d.icon} ${esc(d.label)}</span>` +
          `<span class="cpay-slot-tag">${src ? '可扫码' : '未上传'}</span></div>` +
          media + `<div class="cpay-slot-actions">${zoom}</div></div>`;
      }).join('');
    }
    /* 订单成功卡里也放两张小码：客户下完单不用再点开浮层就能扫 */
    const strip = $('cart-pay-strip');
    if (strip) {
      const pics = PAY_SLOTS.map((d) => {
        const rec = visitorPayCodes.find((x) => x.slot === d.slot) || {};
        if (!rec.src) return '';
        return `<button class="cart-pay-mini" type="button" data-vpay-zoom="${d.slot}" aria-label="放大${esc(d.label)}收款码">` +
          `<img src="${esc(rec.src)}" alt="${esc(d.label)}收款码">` +
          `<span>${d.icon} ${esc(d.label)}</span></button>`;
      }).filter(Boolean).join('');
      strip.innerHTML = pics
        ? `<p class="cart-pay-lead">💰 点小图放大扫码（页面不代收款）：</p><div class="cart-pay-minis">${pics}</div>`
        : `<p class="cart-pay-lead">💰 想付款？点右上「💰 店家收款码」查看（页面不代收款）。</p>`;
    }
  }

  async function refreshVisitorPay(force) {
    if (visitorPayBusy) return;
    if (visitorPayLoaded && !force) return;
    if (!ready || !cloud) { renderVisitorPay(); visitorPayStatus('✖ 暂时连不上店家收款码，请稍后再试。', 'warn'); return; }
    visitorPayBusy = true;
    renderVisitorPay();               // 先摆好两个槽位，读不到也不会是空白一片
    visitorPayStatus('正在读取店家收款码…');
    try {
      const { data, error } = await cloud.database.rpc('customer_pay_codes_get', {});
      if (error) throw new Error(error.message || '读取失败');
      visitorPayCodes = (Array.isArray(data) ? data : []).map((r) => ({
        slot: r.code_slot || r.slot || '',
        label: r.code_label || r.label || '',
        src: r.code_src || r.src || ''
      }));
      visitorPayLoaded = true;
      renderVisitorPay();
      visitorPayStatus('');
      const z = $('customer-pay-zoom');
      if (z && !z.hidden && visitorPayZoomSlot) showVisitorZoom(visitorPayZoomSlot);
    } catch {
      visitorPayLoaded = false;
      renderVisitorPay();
      visitorPayStatus('✖ 暂时读不到店家收款码，请稍后重试，或点「💬 联系店家」问店家要。', 'warn');
    } finally { visitorPayBusy = false; }
  }

  function openVisitorPay() {
    const v = $('customer-pay-viewer');
    if (!v) return;
    renderVisitorPay();
    v.hidden = false;
    const c = $('cpay-close');
    if (c) { try { c.focus(); } catch { /* noop */ } }
    refreshVisitorPay();
  }
  function closeVisitorPay() {
    const v = $('customer-pay-viewer');
    if (v) v.hidden = true;
    closeVisitorZoom();
  }
  function showVisitorZoom(slot) {
    const d = paySlotDef(slot);
    if (!d) return;
    const rec = visitorPayCodes.find((x) => x.slot === d.slot) || {};
    const src = rec.src || '';
    const z = $('customer-pay-zoom'), img = $('cpay-zoom-img');
    if (!z || !img || !src) return;
    visitorPayZoomSlot = d.slot;
    img.src = src;
    img.alt = d.label + '收款码';
    const t = $('cpay-zoom-title');
    if (t) t.textContent = d.icon + ' ' + d.label + '收款码';
    z.hidden = false;
  }
  function closeVisitorZoom() {
    const z = $('customer-pay-zoom');
    if (z) z.hidden = true;
    const img = $('cpay-zoom-img');
    if (img) img.removeAttribute('src');
    visitorPayZoomSlot = '';
  }

  function bindVisitorPay() {
    $('customer-pay')?.addEventListener('click', openVisitorPay);
    $('cpay-close')?.addEventListener('click', closeVisitorPay);
    document.querySelector('[data-cpay-close]')?.addEventListener('click', closeVisitorPay);
    $('cpay-list')?.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-vpay-zoom]');
      if (b) showVisitorZoom(b.dataset.vpayZoom);
    });
    /* 订单成功卡 / 选购清单里的小码和入口，统一走事件委托 */
    $('cart-panel')?.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-vpay-zoom], [data-vpay-open]');
      if (!b) return;
      if (b.dataset.vpayOpen) openVisitorPay();
      else showVisitorZoom(b.dataset.vpayZoom);
    });
    $('cpay-zoom-close')?.addEventListener('click', closeVisitorZoom);
    document.querySelector('[data-cpay-zoom-close]')?.addEventListener('click', closeVisitorZoom);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const z = $('customer-pay-zoom');
      if (z && !z.hidden) { closeVisitorZoom(); return; }
      const v = $('customer-pay-viewer');
      if (v && !v.hidden) closeVisitorPay();
    });
    $('cpay-zoom-img')?.addEventListener('error', () => {
      visitorPayStatus('✖ 这张收款码图片打不开，请稍后重试。', 'warn');
      closeVisitorZoom();
    });
  }

  function bindOrders() {
    /* 店家侧：收款码。第一屏两张码各自能换、能放大；浮层只用来放大给客户扫 */
    $('orders-pay')?.addEventListener('click', () => openPay());
    $('pay-card-list')?.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[data-pay-zoom], [data-pay-upload]');
      if (!t) return;
      if (t.dataset.payZoom) { openPay(t.dataset.payZoom); return; }
      if (t.dataset.payUpload) {
        payPendingSlot = t.dataset.payUpload;
        const f = $('pay-card-file');
        if (f) { f.value = ''; f.click(); }
      }
    });
    $('pay-card-file')?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file && payPendingSlot) uploadPayCode(file, payPendingSlot);
    });
    $('pv-upload')?.addEventListener('click', () => {
      const f = $('pv-file');
      if (f) { f.value = ''; f.click(); }
    });
    $('pv-file')?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file && payActiveSlot) uploadPayCode(file, payActiveSlot);
    });
    $('pv-close')?.addEventListener('click', closePay);
    document.querySelector('[data-pv-close]')?.addEventListener('click', closePay);
    $('pv-qr')?.addEventListener('error', () => {
      const img = $('pv-qr'), empty = $('pv-empty');
      if (img) { img.hidden = true; img.removeAttribute('src'); }
      if (empty) { empty.hidden = false; empty.textContent = '这张收款码图片打不开，请重新上传一张。'; }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePay(); });
    /* 店家侧：订单卡片里的「和客户聊天」——点开即把这单标成已读 */
    $('orders-placed')?.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-chat]');
      if (!b || !window.GalleryChat) return;
      window.GalleryChat.open(b.dataset.chat, {
        shop: true,
        shopKey: shopKey,
        wechatName: b.dataset.wechat || '',
        guestName: b.dataset.guest || ''
      });
      markChatRead(b.dataset.chat);
    });
    /* 聊天面板每 8 秒拉一次消息：只要店家正看着这一单，就一直是「已读」 */
    document.addEventListener('gallery-chat-read', (e) => {
      const no = e && e.detail && e.detail.orderNo;
      if (no) markChatRead(no);
    });
    document.addEventListener('gallery-chat-closed', () => {
      activeChatOrder = '';
      refreshUnread();
    });
    $('orders-unread-jump')?.addEventListener('click', () => {
      const first = document.querySelector('#orders-placed .orders-chat-btn.has-unread');
      if (first && typeof first.scrollIntoView === 'function') {
        try { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* noop */ }
      }
    });
    /* 点订单 / 清单里的商品 → 查看大图与商品资料 */
    $('orders-body')?.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-view]');
      if (!b) return;
      const rec = viewIndex.get(b.dataset.view);
      if (rec) openItemViewer(rec.item, rec.meta);
    });
    $('iv-close')?.addEventListener('click', closeItemViewer);
    document.querySelector('[data-iv-close]')?.addEventListener('click', closeItemViewer);
    $('iv-thumbs')?.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-iv]');
      if (b) showIvPhoto(Number(b.dataset.iv));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeItemViewer();
    });
    $('orders-refresh')?.addEventListener('click', () => refreshOrders());
    $('orders-export')?.addEventListener('click', exportCsv);
    /* 主入口：账号 + 密码登录，手机和电脑都一样 */
    $('orders-login')?.addEventListener('click', async () => {
      const a = String($('orders-account')?.value || '').trim();
      const p = String($('orders-password')?.value || '');
      const btn = $('orders-login');
      if (!a || !p) { gateMsg('请把账号和密码都填上。', 'warn'); return; }
      if (btn) { btn.disabled = true; btn.textContent = '正在登录…'; }
      gateMsg('正在核对账号密码…');
      let r;
      try { r = await shopLogin(a, p); }
      catch { r = { ok: false, message: '登录没成功，请稍后再试一次' }; }
      if (btn) { btn.disabled = false; btn.textContent = '登录后台'; }
      if (!r.ok) { gateMsg(r.message, 'warn'); return; }
      const pw = $('orders-password'); if (pw) pw.value = '';
      gateMsg('');
      await refreshOrders(r.key);
      await issueShopSession();   // 登录成功后给这台设备发一枚可撤销的免登录凭证
    });
    ['orders-account', 'orders-password'].forEach((id) => {
      $(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('orders-login')?.click();
      });
    });
    $('orders-logout')?.addEventListener('click', shopLogout);
    /* 账号密码是唯一入口：不再提供「直接填店家口令」的备用通道 */
  }

  function openOrders() {
    document.body.classList.add('orders-mode');
    const view = $('orders-view');
    if (view) view.hidden = false;
    /* 登录态只在本内存里：刷新 / 重开页面一律回到登录框，自己重新登 */
    if (!shopKey) {
      showGate();
      return;
    }
    refreshOrders(shopKey);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    ready = initCloud();
    const params = new URLSearchParams(location.search);
    /* 正式线上页面（带 sharecode）一律不认 URL 里的旧口令：要么用本机凭证自动恢复，
       要么自己输一次账号密码；不带 sharecode 的本地 / 自动化环境才允许用 k 注入，方便回归。 */
    const urlKey = params.has('sharecode') ? '' : params.get('k');
    if (urlKey) shopKey = urlKey;
    bindCart();
    bindOrders();
    bindVisitorPay();
    paintCart();
    if (ordersMode()) {
      ensureFrames(); // 后台先把商品索引读好，点商品立刻出图
      /* 先用本机凭证恢复登录：成功就直接进后台，不用再输账号密码；
         失败（换设备 / 退出过 / 凭证过期）才回到登录框。 */
      restoreShopSession().then(() => {
        openOrders();
        // 店家视图每 20 秒自动刷新一次，客户刚下单也能及时看到
        setInterval(() => { if (!document.hidden) refreshOrders(); }, 20000);
        // 未读消息每 12 秒单独刷一次：买家刚发消息，后台不用手动刷新就能看到红点
        setInterval(() => { if (!document.hidden) refreshUnread(); }, 12000);
        refreshUnread();
      });
    } else if (ready) {
      flush().then((r) => { if (r.ok === false) notify(r); }).catch(() => {});
    }
  }

  window.GalleryCart = {
    add, remove, clear, placeOrder, setGuest, guest, getItems, qtyOf, totals, money,
    myShortId, onChange: (cb) => { if (typeof cb === 'function') listeners.push(cb); },
    notify, ordersMode, refreshOrders, refreshUnread, restoreShopSession, summaryText,
    /* 后台「主页访问权限」面板用：店家口令只在内存里，登录后才有，客户页面拿到的是空值 */
    shopKey: () => shopKey,
    /* 前台「店家登录」用：账号密码校验 + 签发本机凭证；只读本机凭证是否存在 */
    login: loginFromFront, hasShopSession
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
