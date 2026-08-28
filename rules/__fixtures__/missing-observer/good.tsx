// NOTHING in this file may be reported by `missing-observer`.

import { observer } from "mobx-react-lite"
import { useStore } from "../../stores/StoreContext"

// The canonical wrapped shape.
export const SessionsList = observer(() => {
  const { data, ui } = useStore()
  return <div>{data.sessions.length} sessions, tab {ui.tab}</div>
})

// Wrapped named function expression — the shape tg-gallery uses.
export const GalleryEmptyStateView = observer(function GalleryEmptyStateView({
  title,
}: {
  title: string
}) {
  const { platform } = useStore()
  return <p>{title} on {platform.name}</p>
})

// Destructured props, wrapped.
export const SessionRow = observer(({ model }: { model: ISessionModel }) => {
  return <li>{model.title}</li>
})

// A custom hook that reads the store: hooks are not components, the CONSUMER
// carries the observer wrap. camelCase name keeps it out of the rule.
export const useSessionTitle = (id: string) => {
  const { data } = useStore()
  return data.sessionById(id)?.title ?? ""
}

// Same, as a function declaration.
export function useTabLabel() {
  const { ui } = useStore()
  return ui.tab
}

// A presentational component with no store contact at all — observer is not
// required and adding it would be noise.
export const Badge = ({ label }: { label: string }) => <span>{label}</span>

// A non-component helper that happens to be PascalCase but renders no JSX.
export const StoreKeys = () => {
  const { data } = useStore()
  return Object.keys(data)
}

// A `model` prop that is never dereferenced as `model.x` — no observable read.
export const ModelDebugLabel = ({ model }: { model: unknown }) => (
  <code>{JSON.stringify(model)}</code>
)

// Pulls the store ONLY to call a stable action from a handler. Nothing is read
// during render, so nothing needs subscribing and the parent observer owns the
// page. Observatory writes two of these on purpose (`RichEntityListView`,
// `KanbanView`) with a comment saying exactly this.
export const OpenEntityButton = ({ id, label }: { id: string; label: string }) => {
  const { ui } = useStore()
  return <button onClick={() => ui.openPluginEntity(id)}>{label}</button>
}

// Same shape via a component-level handler rather than an inline arrow.
export const CloseButton = ({ id }: { id: string }) => {
  const { ui } = useStore()
  const onPress = () => ui.close(id)
  return <button onClick={onPress}>close</button>
}
