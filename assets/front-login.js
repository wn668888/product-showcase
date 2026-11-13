/* 前台 / 后台只用一个链接
   ------------------------------------------------------------------
   客户打开链接就是前台相册；店家点右上角「店家登录」输自己的账号密码，
   登录成功后在同一个标签页切到后台视图（URL 只多一个 view=orders，
   分享码不变，用户只需要记住一个链接）。
   登录一次会由云端签发本机凭证，下次点「进入后台」直接进，不用再输。
   主页被设成加密或关闭时，访问门里也留了店家入口，店家永远进得去后台。
   前端不存账号、密码或店家口令；客户页面不主动调任何店家接口。
*/
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const isOrders = () => params.get('view') === 'orders' || document.body.classList.contains('orders-mode');
  if (isOrders()) return;                    // 后台页不需要这套入口

  const btn = $('shop-login-entry');
  const modal = $('front-login-modal');
  if (!btn || !modal) return;

  let busy = false;

  function ordersUrl() {
    const u = new URL(location.href);
    u.searchParams.set('view', 'orders');
    u.searchParams.delete('k');              // 旧链接可能带口令，别带进后台
    u.searchParams.delete('_wb');            // 版本自检参数不需要留着
    return u.toString();
  }
  function navigate(url) {
    try {
      /* 自动化回归里可以注入这个钩子来捕获跳转目标，不影响真实浏览器 */
      if (typeof window.__galleryNavigate === 'function') { window.__galleryNavigate(url); return; }
      window.location.assign(url);
    } catch { window.location.href = url; }
  }
  function goOrders() { navigate(ordersUrl()); }

  function hasSession() {
    try {
      const fn = window.GalleryCart && window.GalleryCart.hasShopSession;
      return typeof fn === 'function' ? !!fn() : false;
    } catch { return false; }
  }
  function paintEntry() {
    const remembered = hasSession();
    btn.textContent = remembered ? '🔓 进入后台' : '🔐 店家登录';
    btn.title = remembered
      ? '这台设备已经登录过，点一下直接进后台'
      : '店家从这里用自己的账号密码进后台';
  }
  function msg(text, warn) {
    const m = $('fl-msg');
    if (!m) return;
    m.textContent = text || '';
    m.hidden = !text;
    m.classList.toggle('fl-msg-warn', !!warn);
  }
  function openModal() {
    modal.hidden = false;
    msg('', false);
    const a = $('fl-account');
    const p = $('fl-password');
    if (p) p.value = '';
    if (a && !a.value) a.focus();
  }
  function closeModal() { modal.hidden = true; }

  async function submit() {
    if (busy) return;
    const a = String(($('fl-account') && $('fl-account').value) || '').trim();
    const p = String(($('fl-password') && $('fl-password').value) || '');
    if (!a || !p) { msg('请把账号和密码都填上。', true); return; }
    const loginBtn = $('fl-login');
    busy = true;
    if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = '正在登录…'; }
    msg('正在核对账号密码…', false);
    let r;
    try {
      const fn = window.GalleryCart && window.GalleryCart.login;
      if (typeof fn !== 'function') throw new Error('服务还没准备好');
      r = await fn(a, p);
    } catch {
      r = { ok: false, message: '登录没成功，请稍后再试一次' };
    }
    busy = false;
    if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = '登录后台'; }
    if (!r || !r.ok) { msg((r && r.message) || '账号或密码不对，请重新输入', true); return; }
    msg('', false);
    goOrders();
  }

  btn.addEventListener('click', () => {
    if (hasSession()) { goOrders(); return; }   // 已保持登录：一键直达
    openModal();
  });
  const loginBtn = $('fl-login');
  if (loginBtn) loginBtn.addEventListener('click', submit);
  ['fl-account', 'fl-password'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  });
  const cancel = $('fl-cancel');
  if (cancel) cancel.addEventListener('click', closeModal);
  const x = $('fl-close');
  if (x) x.addEventListener('click', closeModal);
  const shade = modal.querySelector('[data-fl-close]');
  if (shade) shade.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  /* 主页被加密 / 关闭时，访问门上留一个店家入口，别把店家自己锁在外面 */
  document.querySelectorAll('[data-fl-orders]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); goOrders(); });
  });

  paintEntry();
})();
