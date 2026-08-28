// Every URL here MUST be reported by `hardcoded-url-in-component`.
const API = "https://api.example.com/v1"

export const Panel = () => {
  const upload = "http://uploads.example.com/put"
  const cdn = "https://cdn.example.com/assets"
  return <a href="https://gallery.dev.byokapi.com/g/abc">{API}{upload}{cdn}</a>
}
