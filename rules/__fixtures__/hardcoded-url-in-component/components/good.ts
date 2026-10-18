// NOTHING in this file may be reported by `hardcoded-url-in-component-ts`.

// The fix: the URL comes from a constants module.
import { API_BASE, GALLERY_URL } from "../../lib/constants/urls"

export const links = [API_BASE, GALLERY_URL]

// Relative paths carry no environment.
export const local = "/g/abc"

// Schema/namespace URLs are identifiers, not endpoints — the honest exception.
export const SVG_NS = "http://www.w3.org/2000/svg"
export const SCHEMA = "https://json-schema.org/draft/2020-12/schema"
