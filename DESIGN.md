# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-09
- Primary product surfaces: standalone `orchestrator` CLI and Pi's `/orchestrator` command
- Evidence reviewed: `README.md`, `Plan.md`, `src/extension.ts`, `src/commands.ts`, and Pi 0.84.1 extension/TUI documentation

## Brand

- Personality: calm, precise, observable, and operationally trustworthy
- Trust signals: honest persisted state, explicit elapsed time, clear outcomes, and unchanged CLI evidence
- Avoid: fake percentage progress, celebratory noise, hidden failures, and a second custom TUI

## Product goals

- Goals: acknowledge every Pi command immediately, make long work visibly active, expose real task progress when available, and announce the final outcome
- Non-goals: changing standalone CLI output, adding a model-callable tool, or replacing Pi's transcript/footer
- Success signals: no silent wait, no stale loading indicator, and success/blocked/failure states are distinguishable without reading raw JSON first

## Personas and jobs

- Primary personas: developers running multi-agent repository work from Pi
- User jobs: start work, understand whether it is still running, inspect orchestration state, and know what happened at completion
- Key contexts of use: long model-backed commands, quick read-only commands, recovery after failures, and narrow terminal windows

## Information architecture

- Primary navigation: one `/orchestrator` slash command with subcommands
- Core routes/screens: Pi transcript, footer status, temporary progress widget, and notifications
- Content hierarchy: current action and elapsed time first, persisted task progress second, complete command output in the transcript last

## Design principles

- Immediate acknowledgement: show activity before filesystem, Git, or model work begins.
- Honest progress: use indeterminate motion until a plan exists, then derive task counts and stages from `.orchestrator` state.
- Durable evidence: notifications summarize; the custom transcript message remains the complete result.
- Clean teardown: every success and exception path clears transient progress UI.
- Tradeoffs: prefer a compact text progress bar over a custom component so Pi modes and terminal sizes behave consistently.

## Visual language

- Color: use Pi's existing notification semantics; progress text must remain understandable without color
- Typography: terminal-native text with short labels and tabular numerals where Pi provides them
- Spacing/layout rhythm: one compact footer label and one single-line widget
- Shape/radius/elevation: not applicable
- Motion: low-frequency spinner updates while work is active
- Imagery/iconography: conventional `✓`, `!`, and spinner glyphs paired with text

## Components

- Existing components to reuse: `ctx.ui.setStatus`, `ctx.ui.setWidget`, `ctx.ui.notify`, and the existing custom transcript message
- New/changed components: an extension-local command activity controller and outcome classifier
- Variants and states: starting, running, task progress, success, blocked, and failure
- Token/component ownership: Pi owns rendering and theme; this package owns only concise text content

## Accessibility

- Target standard: terminal feedback understandable without animation or color
- Keyboard/focus behavior: progress UI never takes focus
- Contrast/readability: rely on Pi-native status and notification rendering
- Screen-reader semantics: pair symbols with explicit words such as `completed`, `blocked`, and `failed`
- Reduced motion and sensory considerations: animation is limited to a compact spinner; the action and elapsed time remain textual

## Responsive behavior

- Supported breakpoints/devices: terminal widths supported by Pi 0.84.1
- Layout adaptations: keep progress to one short line and truncate task detail before core status
- Touch/hover differences: not applicable

## Interaction states

- Loading: show action, spinner, and elapsed time immediately
- Empty: `/orchestrator` without arguments displays help without a lingering loader
- Error: clear activity, show an error notification with the first actionable message, and persist full stderr in the transcript
- Success: clear activity and show a completion notification with elapsed time
- Disabled: not applicable
- Offline/slow network: elapsed time and persisted task stages continue to communicate activity

## Content voice

- Tone: concise, factual, and action-oriented
- Terminology: use existing command and lifecycle names
- Microcopy rules: lead with `Orchestrator`, name the action/outcome, include elapsed time, and never claim completion for `blocked` or `failed` lifecycle results

## Implementation constraints

- Framework/styling system: Pi 0.84.1 extension API and TypeScript
- Design-token constraints: use native notification types and plain text rather than hard-coded ANSI colors
- Performance constraints: poll only small persisted JSON files and stop timers reliably
- Compatibility constraints: preserve standalone CLI output, custom message visibility, `triggerTurn: false`, and all non-TUI Pi modes
- Test/screenshot expectations: fake UI contract tests cover start, cleanup, notification, outcome classification, and unchanged transcript output

## Open questions

- [ ] Validate whether users prefer the progress widget above or below the editor after real-world use; default is below to keep transcript evidence unobstructed.
