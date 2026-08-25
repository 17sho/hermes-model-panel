export function securityHeadersAndOrigin({ publicOrigin = "" } = {}) {
  let canonicalOrigin = "";
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.pathname !== "/"
    ) {
      throw new Error("PUBLIC_ORIGIN 必须是 http(s) 站点根地址");
    }
    canonicalOrigin = parsed.origin;
  }

  return async (ctx, next) => {
    ctx.set("X-Content-Type-Options", "nosniff");
    ctx.set("X-Frame-Options", "DENY");
    ctx.set("Referrer-Policy", "same-origin");
    ctx.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
    ctx.set("Cross-Origin-Resource-Policy", "same-origin");
    if (
      ctx.path.startsWith("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(ctx.method)
    ) {
      const origin = ctx.get("origin");
      if (origin) {
        let allowed = false;
        try {
          const expected = canonicalOrigin || `${ctx.protocol}://${ctx.host}`;
          allowed = new URL(origin).origin === expected;
        } catch {}
        if (!allowed) {
          ctx.status = 403;
          ctx.body = { ok: false, error: "Origin 不允许" };
          return;
        }
      }
    }
    await next();
  };
}
