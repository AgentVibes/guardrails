// NOTHING in this file may be reported by `hardcoded-url-in-component`.

// The fix: the URL comes from a constants module (or a store computed), so the
// component does not know which environment it is in.
import { API_BASE, GALLERY_URL } from "../../lib/constants/urls"

export const Panel = () => <a href={GALLERY_URL}>{API_BASE}</a>

// Relative paths carry no environment.
export const Link = () => <a href="/g/abc">gallery</a>

// Schema/namespace URLs are identifiers, not endpoints — the honest exception.
export const Icon = () => <svg xmlns="http://www.w3.org/2000/svg" />
export const SCHEMA = "https://json-schema.org/draft/2020-12/schema"
