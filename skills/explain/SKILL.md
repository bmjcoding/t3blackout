---
name: explain
description: Explain a topic as a visual page drawn inline in the thread. Only when the user explicitly invokes /explain; never on your own.
disable-model-invocation: true
triggers: [user]
---

Explain the topic I named as a page drawn in this thread, not as a wall of text.

## Ground it first

If the topic lives in the current codebase, read before you draw. A narrow topic (one module, one flow) you read yourself. A broad one (a subsystem, "how does auth work") goes to an Explore subagent first; draw from its report. Every box, arrow and label must name a real file, symbol or concept from the code, in the project's own vocabulary. Never invent a module to make the picture tidier.

Any other topic, explain from what you know, and say where you're unsure.

## Draw it

One self-contained HTML page: a diagram that carries the idea, then a few short annotated sections for what the diagram can't say (why it's shaped this way, the non-obvious part, the trap).

- Hand-written inline SVG and HTML/CSS. No CDN libraries.
- Colors come only from the theme variables `html_render` describes, so the page follows the user's theme and light/dark mode.
- Make it interactive (step through a sequence, expand a node) only when stepping through is the point: request lifecycles, state machines, multi-stage pipelines. Otherwise keep it static.

## Check, then show

1. `html_preview` at the default width and dark mode. Fix every console error and anything clipped or overlapping.
2. If it's interactive, preview it again in light mode and at 390px wide.
3. `html_render` it.
4. Reply in one to three sentences with only what the page doesn't say: caveats, where to look next. Never restate the page.
