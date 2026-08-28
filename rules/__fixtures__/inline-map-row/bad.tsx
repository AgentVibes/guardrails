// Every `.map` in this file MUST be reported by `inline-map-row`.
//
// All of them sit inside `observer(...)`: that is the whole defect. The
// parent's reactive scope tracks every field every row body reads, so one
// item changing one field re-renders the entire list.

import { observer } from "mobx-react-lite"

// Arrow with an expression body.
export const A = observer(() => <ul>{xs.map((x) => <li key={x.id}><img src={x.src} /><span>{x.title}</span></li>)}</ul>)

// Arrow with a block body and an explicit return.
export const B = observer(() => (
  <ul>
    {xs.map((x) => {
      return (
        <li key={x.id}>
          <img src={x.src} />
          <span>{x.title}</span>
        </li>
      )
    })}
  </ul>
))

// `function` expression callback.
export const C = observer(() => (
  <ul>
    {xs.map(function (x) {
      return <li key={x.id}><img src={x.src} /><span>{x.title}</span></li>
    })}
  </ul>
))

// Chained before `.map`, parenthesized body, index parameter.
export const D = observer(() => (
  <ul>{xs.filter(Boolean).map((x, i) => (<li key={i}><b>{x.a}</b><i>{x.b}</i></li>))}</ul>
))

// Deeply nested rather than sibling-nested — three levels of inline row body.
export const E = observer(() => (
  <div>
    {rows.map((r) => (
      <div key={r.id}>
        <header>
          <h3>{r.title}</h3>
          <time>{r.at}</time>
        </header>
      </div>
    ))}
  </div>
))

// The real shape, with design-system tags rather than host elements:
// observatory's SessionsTreeSection with its extracted <StatusGroup/> inlined.
export const SessionsTreeSection = observer(() => {
  const { data, ui } = useStore()
  const byStatus = (s: SessionStatus) => data.sessions.filter((x) => x.status === s)
  return (
    <TreeSection sectionKey="section:sessions" onActivate={() => ui.openSessions("all")}>
      {GROUP_ORDER.map((status) => (
        <VStack key={status} gap={0}>
          <HStack align="center">
            <Text weight="bold">{sessionStatusLabel(status)}</Text>
            <Badge count={byStatus(status).length} />
          </HStack>
          <Divider />
        </VStack>
      ))}
    </TreeSection>
  )
})
