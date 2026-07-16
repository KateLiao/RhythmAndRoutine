# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

### Do not run Next.js development and production builds against the same output directory

`next dev` and `next build` both write to `.next`. Running them concurrently can
replace development chunks while the dev server is still serving the page. The
browser may then receive a new React tree with a stale or missing CSS chunk,
creating layout failures that do not represent either a clean development build
or a production build.

Before running `npm run build`, stop the local development server. After the
build finishes, restart `npm run dev` before visual verification. If the page
shows structurally impossible styling after a concurrent build, restart the dev
server and reload the page before changing application code.

For parallel verification, configure distinct Next.js output directories rather
than sharing `.next`.

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

For calendar layout changes, visual verification must check all of the following:

- time labels and the day grid occupy the same row;
- an event appears at the matching time label;
- every header boundary aligns with its day-lane boundary;
- the today and selected-date states remain visually distinct;
- header and lanes stay synchronized during horizontal scrolling.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
