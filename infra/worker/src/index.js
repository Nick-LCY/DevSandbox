// 极简 Cloudflare Worker（**纯 JS ESM**，无 TypeScript、无构建步骤）。
//
// 分工：
//   - 静态资产（前端 `dist/`）由 Workers 的 `[assets]` 绑定**平台直出**
//     （`run_worker_first = false`）⇒ 资产请求**不经过**本函数；
//   - 本函数只接**非资产路径** ⇒ 一律 404。
//
// 不写业务逻辑、不碰令牌、不代理 API——**API 一律直连后端**
//（跨源由后端 CORS 放行）。

export default {
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
};
