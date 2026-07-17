Drives a real Chromium tab with full puppeteer access via JS execution.

<instruction>
- For static web content (articles, docs, issues/PRs, JSON, PDFs, feeds), prefer the `read` tool with a URL. Use this tool only when you need JS execution, authentication, or interactive actions.
- Four actions:
  - `open` — acquire (or reuse) a named tab. `name` defaults to `"main"`. Optional `url`, `viewport`, and `dialogs: "accept" | "dismiss"` (auto-handles `alert`/`confirm`/`beforeunload`). The `app` field selects the browser kind (spawned binary, saved Chrome profile, or existing CDP endpoint); omitted means headless Chromium with stealth patches.
  - `close` — release a tab by `name`, or every tab with `all: true`. `kill: true` also terminates a spawned-app process tree.
  - `act` — run a list of structured `actions` against an existing tab without writing JS (preferred for routine navigation/interaction). Each step is `{ verb, … }`; verbs: `navigate {url, wait_until?}`, `click {id|selector}`, `type {id|selector, text}`, `fill {selector, value}`, `select {selector, values}`, `press {key, selector?}`, `scroll {dx?, dy?}`, `back`, `wait {selector?|ms?}`, `observe {viewport_only?, include_all?}`, `extract {format?}`, `screenshot`. Address elements by the numeric `id` from a prior `observe` (preferred) or a selector. Steps run in order; the tool returns per-step results.
  - `run` — execute JS against an existing tab. `code` is the body of an async function with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. The return value is JSON-stringified into the tool result; `display(value)` calls accumulate text/images. Use `run` only when an `act` verb does not cover what you need.
- Tabs survive across `run` calls and across in-process subagents. Open once, reuse many times.
- Inside `run`, `tab` exposes high-level helpers (`goto`, `observe`, `id`, `click`, `type`, `fill`, `press`, `waitFor`, `screenshot`, `extract`, …); reach for `page` (raw puppeteer Page) when they don't cover it.
- Selectors accept CSS as well as puppeteer query handlers: `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`.
- Full reference — every `tab.*` helper, browser kinds (`app.path`, `app.browser: "chrome"` profiles, `app.cdp_url`), CDP/security details, and more examples — read `docs/tools/browser.md`.
</instruction>

<critical>
- You MUST call `open` before `run` or `act`. Neither implicitly creates a tab.
- You NEVER screenshot just to "see what's on the page" — `tab.observe()` returns structured data with element ids you can act on immediately.
- After a `tab.goto()` or any navigation, prior element ids from `tab.observe()` are invalidated. Re-observe before referencing them.
- `code` runs with full Node access. Treat it as your code, not sandboxed code.
</critical>

<examples>
# Open a tab and read structured page data
`{"action":"open","name":"docs","url":"https://example.com"}`
`{"action":"act","name":"docs","actions":[{"verb":"observe"}]}`

# Click an observed element, then fill and submit a form
`{"action":"act","name":"docs","actions":[{"verb":"click","id":12},{"verb":"fill","selector":"input[name=email]","value":"me@example.com"},{"verb":"click","selector":"text/Continue"}]}`
</examples>

<output>
- Per call: any `display(value)` outputs (text/images) followed by the JSON-stringified return value of the `code` function. `run` always produces at least a status line.
</output>
