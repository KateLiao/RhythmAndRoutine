# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

### Do not update a parent from a child state updater

A functional state updater may run while React is rendering the component that
owns that state. Never call a prop callback that updates a parent component from
inside that updater.

```tsx
// Avoid: onExpandedChange may update the parent during the child's render.
setCollapsed((current) => {
  const next = !current;
  onExpandedChange?.(!next);
  return next;
});

// Use: derive the next value and notify both components from the event handler.
const nextCollapsed = !collapsed;
setCollapsed(nextCollapsed);
onExpandedChange?.(!nextCollapsed);
```

Apply the same rule to all updater callbacks: keep them pure and free of parent
updates, storage writes, network calls, notifications, and other side effects.

### Separate collapsed summaries from the expanded event timeline

Append-only Agent events are both an audit source and the ordering source for the
expanded process timeline. Keep raw events intact and use two projections:
semantic stages for the collapsed summary, chronological events for expansion.

- Expanded rows preserve arrival order. A completed tool updates by stable
  `toolCallId`; a newly started tool appends below it.
- Repeated loop verification events are internal control records and do not
  render in the primary timeline.
- A no-tool terminal turn is a completion decision, not a tool validation.
- Container status must come from the projected current stages. A recovered
  historical failure must not keep the whole process in a failed state.
- Never set a generic “validating tool result” status on `tool_completed`; the
  next real `tool_started` or terminal event owns the next visible state.

Add regression coverage for both live events and legacy persisted events when
changing event labels or projection rules.
