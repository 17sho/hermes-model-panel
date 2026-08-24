const LOOPBACKS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function createRequireAuth(options) {
  return function requireAuth(ctx, next) {
    const loopback = LOOPBACKS.has(ctx.req.socket?.remoteAddress);
    const proxyAuthenticated =
      options.trustProxyAuth &&
      loopback &&
      options.validTimedHmac(ctx.get(options.trustedProxyAuthHeader), "proxy");
    const cliAuthenticated =
      loopback && options.validTimedHmac(ctx.get(options.cliAuthHeader), "cli");
    if (ctx.path === "/api/login" || ctx.path === "/api/health") return next();
    const payload = options.tokenPayload(ctx.cookies.get(options.cookieName));
    if (
      !options.authDisabled() &&
      !proxyAuthenticated &&
      !cliAuthenticated &&
      !payload
    ) {
      ctx.status = 401;
      ctx.body = { ok: false, error: "unauthorized" };
      return;
    }
    if (
      !options.authDisabled() &&
      !["GET", "HEAD", "OPTIONS"].includes(ctx.method) &&
      !proxyAuthenticated &&
      !cliAuthenticated &&
      (!payload ||
        !options.safeEqual(ctx.get("x-csrf-token"), payload.csrf || ""))
    ) {
      ctx.status = 403;
      ctx.body = { ok: false, error: "CSRF 校验失败" };
      return;
    }
    return next();
  };
}
