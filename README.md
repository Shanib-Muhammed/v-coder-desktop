<div align="center">

# V-Coder

**An open desktop AI coding studio. Bring your own model.**

V-Coder is a native desktop agent for Windows, macOS and Linux. Connect any
provider you already pay for — OpenAI, Anthropic, Google, OpenRouter, Groq,
DeepSeek, xAI, Mistral, Together, Cerebras, Fireworks, NVIDIA, Azure, Ollama,
LM Studio, vLLM or any OpenAI-compatible endpoint — then let the agent read,
write and run code in your project.

No account. No subscription. No proxy in the middle. Your keys stay on your
machine, encrypted with the OS keychain.

</div>

---

## Download

Releases ship installers for every platform from GitHub Actions:

| Platform | Package |
| --- | --- |
| Windows | `V-Coder-1.0.0-win-x64.exe` (installer) · `V-Coder-1.0.0-portable.exe` |
| Linux | `V-Coder-1.0.0-linux-x64.AppImage` · `V-Coder-1.0.0-linux-x64.deb` |

Grab them from the [Releases page](https://github.com/Shanib-Muhammed/v-coder-REA-desktop/releases).

> macOS and Windows builds are unsigned. On first launch, right-click → Open
> (macOS) or choose “More info → Run anyway” (Windows SmartScreen).

---

## Features

### An agent, not a chatbot
- Runs a real tool loop against your repository: read, write, edit, grep, glob,
  list and shell commands.
- Streams text, reasoning, tool calls and tool output live into the transcript.
- Multi-step execution with a configurable step budget, stop button and retry.
- Tracks a todo list it maintains itself while working.
- Asks for permission before sensitive tools when you want it to (allow / ask /
  deny per tool).

### Your models
- 17 provider presets plus a fully custom OpenAI-compatible slot.
- Per-provider base URL, headers, model list and API key.
- Wire formats implemented natively: OpenAI Chat Completions, Anthropic
  Messages, Google Gemini, Ollama.
- Streaming with tool calls, usage accounting and context compaction.
- API keys encrypted at rest via Electron `safeStorage` (Keychain / DPAPI /
  libsecret).

### The workspace
- Sessions in a sidebar, each with its own working directory, model and agent.
- Fork, rename, compact, export (Markdown) and delete sessions.
- File tree with search, quick open, and a tabbed editor with syntax
  highlighting, dirty state and save.
- Integrated terminal dock that honours your configured shell.
- `@` file mentions and `/` slash commands in the composer.
- Command palette (`Ctrl/Cmd+K`) for every action.
- Diff-aware timeline: file changes are shown as they happen.

### Customisation
- **Agents** — Build and Plan built in; add your own with a custom system
  prompt, model and toolset.
- **Skills** — scans `SKILL.md` folders and loads reusable instructions.
- **MCP** — configure stdio servers and expose their tools to the agent.
- **Themes** — light, dark and system, with seven accent colours.
- **Fonts & scale** — UI font, code font and editor size.
- **Keybinds** — rebind the actions you use.
- **Shell** — auto-detected, or point it at PowerShell, bash, zsh, cmd…

### Slash commands
`/new` `/compact` `/model` `/agent` `/settings` `/export` `/undo` `/init`
`/help` `/clear`

---

## Build from source

Requires **Node.js 22.23.4 or newer**.

```bash
git clone https://github.com/Shanib-Muhammed/v-coder-REA-desktop.git
cd v-coder-REA-desktop
npm install
npm start           # run the app
npm run dev         # run with DevTools open
```

### Package installers

```bash
npm run dist:win     # NSIS installer + portable .exe
npm run dist:mac     # .dmg + .zip (x64 + arm64)
npm run dist:linux   # .AppImage + .deb
npm run pack         # unpacked build, fastest way to check packaging
```

Artifacts land in `dist/`. Cross-compiling has limits: build macOS targets on
macOS, and Linux targets on Linux (the workflow below does exactly that).

### Tests

```bash
npm test                      # core tools + full agent loop against a mock server
npm run test:ui               # real window: composer -> agent -> tool -> transcript
npx electron . --smoke        # boots the UI headlessly and checks for errors
```

### CI

`.github/workflows/build.yml` builds all three platforms on every push and pull
request, uploads the installers as artifacts, and publishes a GitHub Release
when you push a tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Project layout

```
electron/
  main.cjs        window, IPC surface, menus, keychain cipher
  preload.cjs     contextBridge API exposed to the renderer
  agent.cjs       agent loop, system prompt, permissions, compaction
  llm.cjs         streaming adapters per wire format
  tools.cjs       read/write/edit/grep/glob/list/bash
  providers.cjs   provider presets, auth headers, model discovery
  store.cjs       settings, sessions, skills, encrypted providers
src/
  index.html      shell
  app.js          renderer: sidebar, composer, timeline, settings, palette
  styles.css      design tokens and components
  editor.js       textarea-overlay code editor
  markdown.js     markdown renderer + syntax highlighter
  icons.js        inline SVG icon set
scripts/
  smoke.cjs       headless core test suite
  e2e-agent.cjs   full agent loop against a mock model server
  ui-e2e.cjs      real-window test: composer, streaming, tools, transcript
  make-icons.cjs  generates build/icon.png
```

The renderer is dependency-free ES modules — no bundler, no framework. The app
uses a strict CSP (`script-src 'self'`) and a context-isolated preload bridge.

---

## Security

- `nodeIntegration` is off and `contextIsolation` is on.
- Renderer code talks to the main process only through the preload bridge.
- API keys never leave your machine except to the provider you configured.
- Keys are encrypted with the OS keychain when available; otherwise V-Coder
  warns you and keeps them in the local settings file only.
- The agent can run shell commands — permissions are yours to set. Use the
  Plan agent or set `bash` to `ask` if you want a review step.

---

## Credits

The interface is inspired by [OpenCode](https://opencode.ai) (MIT). V-Coder is
an independent app: it reimplements the layout, keybindings and workflow, and
is not affiliated with or endorsed by the OpenCode project.

Built with [Electron](https://www.electronjs.org) and
[electron-builder](https://www.electron.build).

## License

MIT © 2026 Shanib Muhammed — see [LICENSE](LICENSE).
