// Every catch here MUST be reported by `catch-empty`.
export function a() { try { work() } catch { } }
export function b() { try { work() } catch (e) { } }
// ADDED BY THE WAVE-2 UPGRADE: the type annotation is an extra named node, so
// the old `catch ($_) { }` pattern did not cover either of these.
export function c() { try { work() } catch (e: unknown) { } }
export function d() { try { work() } catch (e: any) { } }
