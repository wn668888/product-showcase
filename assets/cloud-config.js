/* 本应用的云服务公开配置，值来自云服务开通时返回的 publicConfig。
   这些都是可以放在浏览器里的公开值（publishableKey 本身不带权限，服务端按来源域名校验）。
   请勿手改；重新开通或迁移应用时由助手同步更新。

   2026-11-13：相册迁到当前账号下的新应用 wbapp_89Qd1vTHIVNhPchV6HWwnM，
   域名与 publishableKey 同步换成新应用的，保证店家登录 / 订单 / 收款码 / 聊天
   都连到新环境（旧应用已下线，旧云端数据无法再访问）。 */
window.GALLERY_CLOUD_CONFIG = {
  endpoint: 'https://wenipi-product-gallery-48112.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_89Qd1vTHIVNhPchV6HWwnM_r9B0x5AyQtt5nlPLLmNQ2UVHC0stWrk3'
};
