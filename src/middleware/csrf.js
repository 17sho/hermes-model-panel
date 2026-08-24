export function securityHeadersAndOrigin() {
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
          const parsed = new URL(origin);
          allowed =
            parsed.host === ctx.host && parsed.protocol === `${ctx.protocol}:`;
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
