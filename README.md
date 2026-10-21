# plan-bridge

A Claude Code mod that puts a live progress bar above the prompt, filled from the task list Claude already keeps. Every multi-step task gets a bar, in the terminal and in the desktop app, and Claude makes no extra calls for it.

```
▶ Make an HTML page of my setup                 1/3 · 33% · 1m 12s ✕
━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━ ────────────────────
Collect descriptions  then Generate the page
```

## How it works

Claude already keeps a plan while it works:

- in the **Claude Code desktop app**, its own task list (the checklist shown in the conversation);
- in the **terminal**, the `TaskCreate` / `TaskUpdate` task tools, or `TodoWrite`.

plan-bridge watches those lists and draws them as a bar:

- **First row:** the task, titled from your prompt, then steps done, the percent and the time running, and ✕ to close it.
- **Second row:** one segment per step. Green is done, gold is the step at work, dim is still to come. The desktop draws it as a graphic; the terminal uses line characters sized to the window.
- **Third row:** the step at work and the one after it, or "All done · took 2m 14s" once Claude finishes.
- A new task list gets a new bar. A change to the current list (a step added or renamed) updates the same bar.
- A finished bar steps aside when you send your next prompt.
- Task lists kept by subagents are left alone.
- The clock ticks only while a task is running; nothing runs while idle.

## Works with plan-progress (optional)

If you also use [plan-progress](https://github.com/zycck/claude-mods), plan-bridge hands each list to plan-progress and draws nothing itself, so there is only ever one bar, in plan-progress's style. If plan-progress is turned off, plan-bridge draws its own bar again. You don't need plan-progress for anything.

## Requirements

Claude Code 2.1.304 or newer, with mods (function hooks).

## Install

At the prompt of a terminal session:

```
/plugin install plan-bridge --marketplace flutterboy20/plan-bridge
```

Answer `y` to add the marketplace, then choose a scope (user scope makes it work in every project).

From a shell:

```
claude plugin install plan-bridge --marketplace flutterboy20/plan-bridge
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `flutterboy20/plan-bridge`, then **Add plugin**.

## Develop and test

```
claude plugin validate .
claude plugin test .
```

## License

MIT
