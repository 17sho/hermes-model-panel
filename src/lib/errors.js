import crypto from "node:crypto";

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function publicError(error, fallback = "操作失败") {
  let message = String(error?.message || fallback).replace(
    /(?:\/[A-Za-z0-9._-]+){2,}/g,
    "[路径已隐藏]",
  );
  if (/stdout|stderr|child process|command failed/i.test(message))
    message = fallback;
  return message.slice(0, 240);
}
