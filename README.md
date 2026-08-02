<h1 align="center">tmon</h1>

<p align="center">
  <b>Real-time terminal monitoring &amp; control for AI Agent long-running commands</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tmon"><img src="https://img.shields.io/npm/v/tmon.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.18-339933.svg" alt="Node >= 22.18">
  <img src="https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20macOS-lightgrey.svg" alt="Platforms">
  <a href="https://github.com/cy745/tmon/issues"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

---

## What is tmon?

When an AI Agent runs a long task (big downloads, builds, data migrations), it often goes to the background with **zero visibility** — you can't tell if it's stuck, crawling, or about to finish, and you can't intervene when something goes wrong.

**tmon** wraps the command with a transparent proxy:

```bash
tmon "curl -o big.bin https://example.com/big.bin"
```

The command behaves **exactly the same** for the Agent (same output, same exit code), while you get a **real-time web workbench** showing every line of output with timestamps, inter-line gaps (spot "stuck" vs "slow" at a glance), progress bars, and one-click Ctrl-C cancellation — plus a fully interactive terminal you can type into.

## Features

- 🔍 **Transparent proxy** — output & exit codes identical to direct execution; zero config (server auto-starts)
- ⏱️ **Per-line timestamps** — inter-line gap visualization distinguishes *stuck* from *slow*, long silences highlighted
- 🖥️ **Web workbench** — task sidebar (filter/search/live progress) + terminal view + timeline strip + progress bar
- ⌨️ **Full terminal interaction** — type into the Web terminal to answer password/Y-N prompts on behalf of the stuck command
- 🛑 **One-click cancellation** — Ctrl-C (SIGINT) with auto-escalation, process-group safe
- 🤖 **Agent-friendly API** — `tmon wait <id>` blocks and propagates exit codes for programmatic control
- 📊 **Script progress reporting** — `tmon progress 45 "unpacking"` inside your script → live progress bar in web & sidebar
- 🌐 **Cross-platform** — Windows (ConPTY) / Linux / macOS (forkpty)

## Quick Start

```bash
npm install -g tmon

# wrap any command
tmon "curl -o big.bin https://example.com/big.bin"

# open the web workbench (or visit the URL printed on stderr)
tmon serve
```

Then open the printed URL in your browser — the task list appears instantly.

## Usage

```
tmon "命令字符串"                    run in foreground (blocking, output teed back, task id on stderr)
tmon command args...                 same as above, argv passthrough form
tmon last                            id of the most recent task
tmon ls                              list tasks
tmon status <id>                     task status + exit code (for agent polling)
tmon show <id> [--tail N | --full]   output snapshot (ANSI-stripped)
tmon wait <id> [--timeout=N]         block until done, propagate exit code
tmon kill <id> [--signal=SIGINT|SIGTERM|SIGKILL]
tmon progress <pct> <msg>            report progress from inside a script
tmon stage <name>                    report stage from inside a script
tmon serve                           start server in foreground (normally auto-started)
```

Background pattern for agents:

```bash
tmon "npm run build" &      # task id printed on stderr
tmon last                   # or fetch it
tmon wait 7f2a9c3e          # block until done, exit code propagates
```

## How it works

```
Agent Bash tool  →  tmon CLI (PTY proxy)  →  tmon server (events + JSONL)
                        │                       │
                        ├─ stdout teed back     ├─ WebSocket → Web workbench
                        └─ chunk events         └─ REST → tmon ls/status/wait
                     (seq, wall-clock ts, monotonic dt)
```

Every output chunk is recorded with a wall-clock timestamp and a monotonic delta, persisted as JSONL, and streamed to the web UI. The web UI renders the full terminal (xterm.js) including ANSI/TUI output, with a timeline strip coloring each interval green→red.

## Documentation

| Doc | Description |
|---|---|
| [docs/01-requirements.md](docs/01-requirements.md) | Requirements v0.3 (incl. skill-guide decision) |
| [docs/02-research-report.md](docs/02-research-report.md) | Full market/tech research report (with sources) |
| [docs/03-design.md](docs/03-design.md) | Detailed design v0.2 (protocol / storage / processes) |
| [docs/04-web-design.md](docs/04-web-design.md) | Web UI design v1.0 (workbench layout, minimal style) |
| [skills/tmon/SKILL.md](skills/tmon/SKILL.md) | Agent skill: when & how to use tmon |

## Agent skill

Install the skill so agents automatically reach for tmon on long tasks:

```bash
cp -r skills/tmon ~/.claude/skills/
```

## Development

```bash
npm ci
npm run typecheck
npm test
bash tests/e2e-linux.sh   # Linux/macOS e2e (POSIX paths, signals)
cd web && npm ci && npx tsc --noEmit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the issue → branch → PR workflow.

## License

[MIT](LICENSE) © cy745
