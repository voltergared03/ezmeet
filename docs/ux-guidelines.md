# UX/UI guidelines — Garely frontend rework

Source: a UX/UI carousel by Wadhah Aloui (@wadhah_the_uxer), 20 rules, captured 2026-08-26.
Each rule below is followed by **where Garely stands today**, measured against the code
rather than guessed, so the rework has a checklist and not a mood board.

Two rules are marked **TRANSLATE**: they are sound advice aimed at consumer mobile apps,
and copying them literally into a desktop-first work OS would make it worse. They are kept
here with the adaptation spelled out.

---

## Typography

### 1. Simple fonts for readability
Body and UI text use a plain, high-legibility sans — Inter, Poppins, Manrope. Never a
display or decorative face (Italiana, Reggae One, Aclonica) for anything a user has to read.

> **Garely: compliant.** `--font: 'DM Sans'` — a geometric sans in the same family of
> choices, plus JetBrains Mono for code/data. No decorative faces anywhere. Keep as is;
> changing it buys nothing.

---

## Colour

### 2. Avoid pure black and pure white
Ground surfaces at `#242424` rather than `#000000`, and text/light surfaces at `#E7E9EB`
rather than `#FFFFFF`. Pure black flattens elevation — shadows and raised surfaces have
nothing to separate from — and pure white on a dark ground buzzes.

> **Garely: half compliant.** The palette is right: `--bg: oklch(0.18 0.012 250)` is a dark
> blue-grey, never `#000`, with four surface steps above it. But **72 literal `#fff`/`#ffffff`**
> remain in components, bypassing `--text` (which is correctly `oklch(0.97 …)`, not pure white).
> **Action:** replace every literal `#fff` with the token.

### 3. Colour psychology — destructive actions are red
A "Delete" button gets the danger colour, not the brand accent. The colour is part of the
warning; a purple Delete reads as just another action.

> **Garely: mostly compliant** — `--red` is defined and used in 61 places. **Action:** audit
> that every destructive confirm (delete task, delete user, end meeting, delete server) is
> actually on `--red`, not on `--accent`.

### 4. Smooth gradients
Blend between adjacent hues (violet → blue). A gradient across the wheel (red → blue) muddies
through grey in the middle.

> **Garely: not applicable yet** — the UI is essentially gradient-free. This is a constraint
> for anything new, not a fix.

---

## Forms

### 5. Boxes in form fields, not underlines
Every input gets a visible bordered box, a persistent label above it, and a placeholder
inside. Underline-only fields have weak affordance and the label has nowhere to live once
the user types.

### 6. Horizontal alignment — labels above fields, one left edge
Label above its input, everything sharing a single left edge. Label-left/field-right forces
the eye to zigzag down the form.

### 7. Input masks to guide the expected format
Show the shape of the answer: `MM/DD/YYYY`, `(+___) __ ___ ___`. An empty box asking for a
date is a guessing game.

### 8. Field shape matches the data
A 4-digit code gets four single-character boxes, not one wide text field. The control should
telegraph what goes in it.

### 9. Split long forms into steps, and show progress
Break a long form into stages with a visible step indicator, so the user knows how much is
left and never faces one intimidating wall.

> **Garely, rules 5–9:** the form surfaces to rebuild are Settings (7 tabs, `IntegrationsTab`
> alone is 1170 lines), meeting creation, and the `/setup` wizard. Rule 8 has one concrete
> target: the 2FA code field, currently `placeholder="000000"` — a single input where six
> boxes belong. Rule 9 partly exists (`/setup`) but there is no shared stepper component.

---

## Controls

### 10. Show all options when there are 2–3 values
Two or three choices become radio buttons, visible at once. A dropdown hides the options and
costs a click to learn what they even are.

### 11. Radio for single choice, checkboxes for multiple
The control communicates the arity before the user touches it. Getting this wrong makes
people test the UI to find out what it does.

### 12. Let users both type and scroll a long list
A long list (countries, timezones, ClickUp lists) needs a combobox: type to filter, or scroll
to browse. A bare `<select>` with 200 entries is unusable.

> **Garely, rules 10–12: the worst gap in the whole audit.** There are **8 `<select>` elements
> and zero radio buttons** in the codebase. Every single-choice control is a dropdown,
> including binary ones. And the long lists — timezone, ClickUp list picker, department — are
> plain selects with no filtering.
> **Action:** build three primitives — `RadioGroup`, `CheckboxGroup`, `Combobox` — and this
> rule set closes in one pass.

### 13. Placeholders that hint at content, not the obvious
A search field says `Artists, Albums, Songs…`, not `Search`. The placeholder is free
real estate for teaching people what is searchable.

> **Garely:** existing placeholders are good and specific (`smtp.gmail.com`, `us-east-1`).
> **Action:** check the search inputs on tasks / meetings / archive specifically.

---

## Feedback and state

### 14. Skeleton loading, not a spinner
Show the shape of the content while it loads. A spinner communicates only "wait"; a skeleton
communicates "here is what is coming, and roughly how much".

> **Garely: 8 spinners against 2 skeletons.** **Action:** a `Skeleton` primitive plus per-page
> loading shapes for dashboard, tasks, meetings, report, database grid.

### 15. Show where and why an error occurred
The error attaches to the field that caused it, in a danger colour, with the specific reason.
A generic "Error Found" banner at the top of a form makes the user hunt. Best case, live
criteria (password rules ticking green as they are met).

> **Garely: the biggest correctness gap.** **8 `alert()` calls** and **zero `aria-invalid`** —
> there is no inline field-error mechanism at all. This one is not cosmetic: it is why the
> silent-save-failure bugs earlier in this project were invisible to users.
> **Action:** a `Field` wrapper owning label + control + error + `aria-invalid`, and delete
> every `alert()`.

### 16. Highlight the one important action
Among peers, the recommended action gets filled emphasis and the others stay outlined.
Three identical CTAs make the user choose without guidance.

---

## Layout and language

### 17. Group similar and related elements together
Related items sit adjacent; interleaving related and unrelated ones destroys the grouping
the user is trying to read (Gestalt proximity).

### 18. Human language, not system language
"Looks Good" beats "Confirm and continue". "Take a new photo" beats "Retake Photo". Write
what a person would say, not what the function is called.

> **Garely:** applies to both locale files (`src/messages/uk.json`, `en.json`) — and the
> Ukrainian copy is the one users actually read, so it matters more than the English.

---

## TRANSLATE — do not copy literally

### 19. Touch-friendly controls
The original says: use an iOS wheel picker for time instead of three dropdowns.

> **Garely is desktop-first** — a meetings/tasks/RDP console used at a keyboard. A wheel
> picker on desktop is worse than a good text input. **The principle that survives:** the
> control should suit the input device. On desktop that means keyboard-first — type a time
> directly, arrow keys to adjust, generous hit targets (≥ 40 px) — and the mobile/PWA views
> get proper touch targets (≥ 44 px) instead of hover-dependent affordances.

### 20. Skip option in onboarding
The original: onboarding screens always offer Skip.

> **Garely has no consumer onboarding** — it has a one-time admin `/setup` wizard, where
> skipping steps like the domain or secrets is not meaningful. **The principle that survives:**
> optional steps must be visibly optional and skippable; required ones must say why they are
> required. Never trap someone in a flow with only one way forward.

---

## What this adds that the source did not

The carousel says nothing about keyboard access, and Garely has **zero `:focus-visible`
styles** in 1031 lines of `globals.css`. Every rebuilt control needs a visible focus ring —
otherwise the whole app is unusable without a mouse, and no amount of the above fixes that.

## Scale of the job

26 pages, 3 layouts, 12 components, 1031-line `globals.css` with a solid OKLCH token system
already in place — and **2533 inline `style={{…}}` against 742 `className`**. The tokens are
worth keeping; the inline styles are the thing that makes a global rework hard, because there
is no component layer to change once. The order that follows from this audit:

1. **Primitives first** — `Field`, `RadioGroup`, `CheckboxGroup`, `Combobox`, `Skeleton`,
   `Button` (with the emphasis levels rule 16 needs), focus rings.
2. **Forms** — Settings tabs, meeting creation, `/setup`.
3. **Loading and errors** — skeletons per page, kill every `alert()`.
4. **Copy pass** — both locale files, rule 18.

## Theming — decided, and built

**Both themes ship.** The token layer is done: every colour in `globals.css` is declared once
as `light-dark(<light>, <dark>)`, resolved from the computed `color-scheme`. There is no second
palette to keep in sync and no `@media` block for a `[data-theme]` override to out-specify.
`color-scheme` also themes what CSS cannot reach — native controls, the caret, the scrollbar.

- Default is **dark**, not system: the app shipped dark-only and an upgrade must not repaint
  the product for everyone whose OS happens to be light. Following the OS is one click away.
- The switch is three-way — System / Light / Dark — in Settings → Profile, saved per device in
  `localStorage` (a property of the screen you are at, not of the account), with an inline
  `<head>` script that stamps the attribute before first paint so light users get no white flash.
- New semantic tokens: `--danger|warn|success|info` each as a **triple** (solid / `-fg` / `-bg`),
  because a badge needs a foreground and a background that invert together. Plus `--on-accent`,
  `--hover`, `--hover-2`, `--press`, `--overlay`, `--focus`, `--shadow-lg`.

### Measured contrast (WCAG 2.1, against `--surface`)

| | light | dark |
|---|---|---|
| `--text` | 15.53 AA | 14.87 AA |
| `--text-2` | 8.33 AA | 8.68 AA |
| `--muted` | 4.88 AA | 5.63 AA |
| `--muted-2` | 3.06 AA-lg | 4.11 AA-lg |
| `--accent` | 5.10 AA | 4.41 AA-lg |
| status badge `-fg` on `-bg` | 4.51–5.49 AA | — |

Building the light theme surfaced a defect in the **existing dark** one: `--muted-2` scored
**2.48:1**, a straight failure, and `--muted` sat at 4.46, just under AA. Both were raised
(0.48 → 0.60 and 0.62 → 0.68 lightness), so dark secondary text is now slightly brighter than
it was. **Still open:** white on `--accent` in dark scores 3.68 — under AA for button labels at
13.5 px. Fixing it means darkening the dark-theme blue, which is a brand call, not a code one.

### Colour migration status

Hard-coded colours in `.tsx` went from **433 → 209**, and token usage from **1715 → 2020**.
What moved: every exact match of a token's own value, the `rgba(255,255,255,.0x)` hovers (a
white veil is invisible on a white ground), the `rgba(0,0,0,.5)` scrims, and pale chip text
like `#fca5a5` in a `color:` position. What is left is genuinely ambiguous — the same hex in
SVG fills, gradients and chart series — and needs eyes on each, page by page, during the
component work.
