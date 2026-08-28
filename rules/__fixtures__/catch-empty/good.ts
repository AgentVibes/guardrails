// NOTHING in this file may be reported by `catch-empty`.
export function a() {
  try { work() } catch (e) { logger.error("work failed", e); throw e }
}
export function b(): Result {
  try { return { status: "ok", value: work() } }
  catch (e: unknown) { return { status: "error", message: String(e) } }
}
// A catch that deliberately does nothing must SAY so — the comment is the
// difference between a decision and an oversight, and ast-grep-ignore records it.
export function c() {
  // ast-grep-ignore: catch-empty -- idempotent mkdir, "already exists" is expected
  try { mkdir(p) } catch (e) { }
}
