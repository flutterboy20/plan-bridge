# plan-bridge

A Claude Code mod that fills the [plan-progress](https://github.com/zycck/claude-mods) bar above the prompt from the task list Claude already keeps, so you get a live progress bar on every multi-step task without Claude making any extra calls.

## Why

plan-progress draws a progress bar when Claude calls its `plan_progress` tool. In practice Claude often keeps its plan somewhere else:

- in the **Claude Code desktop app**, its own task list (the checklist shown in the conversation);
- in the **terminal**, the `TaskCreate` / `TaskUpdate` task tools, or `TodoWrite`.

When that happens, no bar appears. plan-bridge watches those task lists and sends each change to plan-progress, so the bar always matches what Claude is doing.

## What it does

- A new task list becomes a new bar, titled from your prompt.
- Steps tick over as Claude moves through the list; the bar turns green when Claude finishes.
- A change to the current list (a step added or renamed) updates the same bar.
- Every few file edits it re-sends the open bar unchanged, so plan-progress never has to remind Claude to update it.
- Task lists kept by subagents are left alone; plan-progress already shows agents as rows under the bar.
- If plan-progress isn't installed or is turned off, plan-bridge does nothing and breaks nothing.

## Requirements

- Claude Code 2.1.304 or newer, with mods (function hooks)
- [plan-progress](https://github.com/zycck/claude-mods) installed

## Install

First install plan-progress, if you haven't already. At the prompt of a terminal session:

```
/plugin install plan-progress --marketplace zycck/claude-mods
```

Then plan-bridge. At the prompt of a terminal session:

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
