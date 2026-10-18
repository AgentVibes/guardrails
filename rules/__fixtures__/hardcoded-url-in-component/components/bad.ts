// Every URL here MUST be reported by `hardcoded-url-in-component-ts`.
// A `.ts` file under components/ — a hook or helper next to the component.
const API = "https://api.example.com/v1"

export function useUpload(): string[] {
  const upload = "http://uploads.example.com/put"
  const cdn = "https://cdn.example.com/assets"
  return [API, upload, cdn, "https://gallery.internal.example/g/abc"]
}
