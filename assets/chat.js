/* 简白图库 · 订单线上聊天（文字 + 图片）
   ------------------------------------------------------------------
   客户和店家就「某一笔订单」在页面里沟通，不会跳到微信，也不在这里收款。
   消息只追加：客户只能以 sender='customer' 新增；店家凭登录拿到的口令通过 RPC 回复。
   图片先在浏览器里自动缩小压缩成 JPG data URL，再随消息一起存；点气泡里的图片可看大图。
   双方每 8 秒自动拉取一次，对方的新消息会自己冒出来，不用手动刷新。
   微信名由客户自己填写，页面拿不到微信官方昵称。
*/
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CFG = window.GALLERY_CLOUD_CONFIG || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const urlKey = () => {
    try { return new URLSearchParams(location.search).get('k') || ''; } catch { return ''; }
  };

  /* 云端对 image_src 的上限是 400000 字符，前端留一点余量 */
  const MAX_IMAGE_CHARS = 360000;
  const SAFE_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i;
  const isImageSrc = (s) => SAFE_IMAGE.test(String(s || '')) && String(s).length <= 400000;

  let cloud = null;
  let ready = false;
  let timer = null;
  let sending = false;
  let images = [];
  let ctx = { orderNo: '', shop: false, wechatName: '', guestName: '', shopKey: '' };

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

  function timeOf(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function status(text, kind) {
    const el = $('chat-status');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'chat-status' + (kind ? ' is-' + kind : '');
    el.textContent = text;
  }

  function busy(on) {
    ['chat-send', 'chat-image-btn'].forEach((id) => { const b = $(id); if (b) b.disabled = Boolean(on); });
  }

  function bubble(m, imageIndex) {
    const mine = ctx.shop ? m.sender === 'shop' : m.sender === 'customer';
    const who = m.sender === 'shop'
      ? '店家'
      : (m.wechat_name || ctx.wechatName || ctx.guestName || '客户');
    const wx = m.sender === 'customer' && m.wechat_name ? ' · 微信名 ' + esc(m.wechat_name) : '';
    const content = imageIndex >= 0
      ? `<div class="chat-bubble chat-bubble-img"><button class="chat-img-btn" type="button" data-chat-img="${imageIndex}" title="点开看大图" aria-label="点开看大图"><img class="chat-img" src="${esc(images[imageIndex])}" alt="聊天图片，点开看大图"></button></div>`
      : `<div class="chat-bubble">${esc(m.body)}</div>`;
    return `<div class="chat-msg ${mine ? 'is-mine' : 'is-theirs'}">` +
      `<span class="chat-who">${esc(who)}${wx}</span>` +
      content +
      `<span class="chat-time">${esc(timeOf(m.created_at))}${imageIndex >= 0 ? ' · 图片' : ''}</span>` +
    `</div>`;
  }

  function paint(rows) {
    const box = $('chat-messages');
    if (!box) return;
    const list = Array.isArray(rows) ? rows : [];
    images = [];
    box.innerHTML = list.length
      ? list.map((m) => {
        const src = String(m && m.image_src ? m.image_src : '');
        let idx = -1;
        if (isImageSrc(src)) { images.push(src); idx = images.length - 1; }
        return bubble(m || {}, idx);
      }).join('')
      : '<div class="chat-empty"><span>💬</span><p>还没有消息，先打声招呼，也可以点「🖼 图片」发张图</p></div>';
    box.scrollTop = box.scrollHeight;
  }

  async function load() {
    if (!ready || !cloud || !ctx.orderNo) {
      status('暂时没连上聊天服务，请通过正式链接打开后再试', 'warn');
      return;
    }
    const { data, error } = await cloud.database.rpc('chat_thread', { p_order_no: ctx.orderNo });
    if (error) { status('暂时没读到消息，稍后会自动重试', 'warn'); return; }
    paint(data);
    status('', '');
    /* 店家正开着这一单聊天 → 通知后台把这一单标成已读，红点就不该再亮 */
    if (ctx.shop && ctx.shopKey) {
      try {
        document.dispatchEvent(new CustomEvent('gallery-chat-read', { detail: { orderNo: ctx.orderNo } }));
      } catch { /* 老浏览器不支持自定义事件就跳过 */ }
    }
  }

  /* 店家身份：优先用 cart.js 登录后传进来的内存口令；本地旧链接仍兼容 URL 上的 k */
  const currentKey = () => ctx.shopKey || urlKey() || '';

  async function deliver(body, imageSrc) {
    const isImg = Boolean(imageSrc);
    try {
      if (ctx.shop) {
        const name = isImg ? 'shop_chat_send_image' : 'shop_chat_send';
        const args = isImg
          ? { p_key: currentKey(), p_order_no: ctx.orderNo, p_image_src: imageSrc }
          : { p_key: currentKey(), p_order_no: ctx.orderNo, p_body: body };
        const { data, error } = await cloud.database.rpc(name, args);
        if (error) return { ok: false, err: error.message || '发送失败' };
        const v = Array.isArray(data) ? data[0] : data;
        const ok = v === true || v === 'true' || v === 1 || v === 't';
        return ok ? { ok: true, err: '' } : { ok: false, err: '没发出去，请重新登录后台后再试' };
      }
      const row = {
        order_no: ctx.orderNo, sender: 'customer', wechat_name: ctx.wechatName, body
      };
      if (isImg) row.image_src = imageSrc;
      const { error } = await cloud.database.from('chat_messages').insert([row]);
      return error ? { ok: false, err: error.message || '发送失败' } : { ok: true, err: '' };
    } catch (e) {
      return { ok: false, err: (e && e.message) || '发送失败' };
    }
  }

  async function send() {
    const input = $('chat-input');
    const body = String((input && input.value) || '').trim().slice(0, 500);
    if (!body || sending || !ctx.orderNo) return;
    if (!ready || !cloud) { status('暂时没连上聊天服务，请稍后重试', 'warn'); return; }
    sending = true;
    busy(true);
    const r = await deliver(body, '');
    if (r.ok) {
      if (input) input.value = '';
      status('', '');
      await load();
    } else {
      status('✖ ' + (r.err || '发送失败，请重试'), 'warn');
    }
    sending = false;
    busy(false);
    if (input) { try { input.focus(); } catch { /* noop */ } }
  }

  /* ---------- 图片：读取 → 缩小压缩 → 发送 ---------- */

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('这张图片读不出来，请换一张'));
      fr.onload = () => resolve(String(fr.result || ''));
      try { fr.readAsDataURL(file); } catch { reject(new Error('这张图片读不出来，请换一张')); }
    });
  }

  function canvasUsable() {
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const cx = typeof c.getContext === 'function' ? c.getContext('2d') : null;
      return Boolean(cx && typeof c.toDataURL === 'function');
    } catch { return false; }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('这张图片打不开，请换一张 JPG 或 PNG'));
      im.src = src;
    });
  }

  async function imageToDataUrl(file) {
    if (!file) throw new Error('没选中图片');
    if (!/^image\//.test(String(file.type || ''))) throw new Error('只能发图片，不能发其它文件');
    if (file.size && file.size > 20 * 1024 * 1024) throw new Error('图片太大了，请换一张小一点的');

    const raw = await readAsDataUrl(file);
    const rawOk = isImageSrc(raw);

    /* 没有 canvas（老浏览器 / 测试环境）就直接用原图，但只放行安全格式且不过大 */
    if (!canvasUsable()) {
      if (!rawOk) throw new Error('这种图片格式发不了，请换成 JPG 或 PNG');
      if (raw.length > MAX_IMAGE_CHARS) throw new Error('这张图片太大了，请换一张小一点的');
      return raw;
    }

    let im = null;
    try { im = await loadImage(raw); }
    catch {
      if (rawOk && raw.length <= MAX_IMAGE_CHARS) return raw;
      throw new Error('这张图片打不开，请换一张 JPG 或 PNG');
    }

    const canvas = document.createElement('canvas');
    const scales = [1, 0.8, 0.62, 0.48, 0.36, 0.26];
    const qualities = [0.78, 0.68, 0.58, 0.48];
    const w0 = Math.max(1, Number(im.naturalWidth) || Number(im.width) || 800);
    const h0 = Math.max(1, Number(im.naturalHeight) || Number(im.height) || 800);
    let out = '';
    for (const s of scales) {
      const fit = Math.min(1, 1280 / Math.max(w0 * s, h0 * s));
      const w = Math.max(1, Math.round(w0 * s * fit));
      const h = Math.max(1, Math.round(h0 * s * fit));
      canvas.width = w; canvas.height = h;
      const cx = canvas.getContext('2d');
      if (!cx) break;
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, w, h);
      cx.drawImage(im, 0, 0, w, h);
      for (const q of qualities) {
        const d = canvas.toDataURL('image/jpeg', q);
        if (d.length <= MAX_IMAGE_CHARS) { out = d; break; }
      }
      if (out) break;
    }
    if (!out && rawOk && raw.length <= MAX_IMAGE_CHARS) out = raw;
    if (!isImageSrc(out) || out.length > MAX_IMAGE_CHARS) {
      throw new Error('这张图片太大了，请换一张小一点的，或截掉多余部分');
    }
    return out;
  }

  async function sendImage(file) {
    if (!file || sending || !ctx.orderNo) return;
    if (!ready || !cloud) { status('暂时没连上聊天服务，请稍后重试', 'warn'); return; }
    sending = true;
    busy(true);
    status('🖼 正在处理图片…', 'info');
    let src = '';
    try {
      src = await imageToDataUrl(file);
    } catch (e) {
      status('✖ ' + ((e && e.message) || '这张图片发不了，请换一张'), 'warn');
      sending = false;
      busy(false);
      return;
    }
    status('🖼 正在发送图片…', 'info');
    const r = await deliver('[图片]', src);
    if (r.ok) {
      status('', '');
      await load();
    } else {
      status('✖ ' + (r.err || '图片没发出去，请重试'), 'warn');
    }
    sending = false;
    busy(false);
  }

  /* ---------- 放大看大图 ---------- */

  function showZoom(src) {
    const v = $('chat-image-viewer'), im = $('chat-image-full');
    if (!v || !im || !isImageSrc(src)) return;
    im.src = src;
    v.hidden = false;
  }

  function hideZoom() {
    const v = $('chat-image-viewer'), im = $('chat-image-full');
    if (v) v.hidden = true;
    if (im) im.removeAttribute('src');
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function close() {
    const panel = $('chat-panel'), shade = $('chat-shade');
    if (panel) panel.hidden = true;
    if (shade) shade.hidden = true;
    hideZoom();
    stopTimer();
    ctx = { orderNo: '', shop: false, wechatName: '', guestName: '', shopKey: '' };
    try { document.dispatchEvent(new CustomEvent('gallery-chat-closed')); } catch { /* noop */ }
  }

  function open(orderNo, opts) {
    const no = String(orderNo || '').trim();
    if (!no) return;
    const o = opts || {};
    ctx = {
      orderNo: no,
      shop: Boolean(o.shop),
      wechatName: String(o.wechatName || '').trim().slice(0, 40),
      guestName: String(o.guestName || '').trim().slice(0, 30),
      shopKey: String(o.shopKey || '').trim()
    };
    const title = $('chat-title'), sub = $('chat-sub');
    if (title) title.textContent = ctx.shop ? '💬 和客户聊天' : '💬 和店家聊天';
    if (sub) sub.textContent = '订单 ' + no + (ctx.wechatName ? ' · 客户微信名 ' + ctx.wechatName : '');
    const fi = $('chat-image-file');
    if (fi) { try { fi.value = ''; } catch { /* noop */ } }
    hideZoom();
    const panel = $('chat-panel'), shade = $('chat-shade');
    if (panel) panel.hidden = false;
    if (shade) shade.hidden = false;
    paint([]);
    status('', '');
    load();
    stopTimer();
    timer = setInterval(() => { if (!document.hidden) load(); }, 8000);
    const input = $('chat-input');
    if (input) { try { input.focus(); } catch { /* noop */ } }
  }

  function bind() {
    $('chat-close')?.addEventListener('click', close);
    $('chat-shade')?.addEventListener('click', close);
    $('chat-send')?.addEventListener('click', send);
    $('chat-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    $('chat-image-btn')?.addEventListener('click', () => $('chat-image-file')?.click());
    $('chat-image-file')?.addEventListener('change', (e) => {
      const t = e.target;
      const f = t && t.files && t.files[0];
      if (t) { try { t.value = ''; } catch { /* noop */ } }
      sendImage(f);
    });
    $('chat-messages')?.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-chat-img]') : null;
      if (!b) return;
      const i = Number(b.getAttribute('data-chat-img'));
      if (Number.isInteger(i) && i >= 0 && i < images.length) showZoom(images[i]);
    });
    $('chat-image-close')?.addEventListener('click', hideZoom);
    $('chat-image-shade')?.addEventListener('click', hideZoom);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const zoom = $('chat-image-viewer');
      if (zoom && !zoom.hidden) { hideZoom(); return; }
      const panel = $('chat-panel');
      if (panel && !panel.hidden) close();
    });
  }

  ready = initCloud();
  bind();
  window.GalleryChat = {
    open, close, load, send, sendImage, showZoom, hideZoom,
    isReady: () => ready
  };
})();
