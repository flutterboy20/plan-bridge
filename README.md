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
- **Agent rows:** each subagent Claude starts gets a row under the bar, with its model, the tool it is on and its time, until it finishes.
- A new task list gets a new bar. A change to the current list (a step added or renamed) updates the same bar.
- A finished bar stays until you close it with ✕; the next task's bar stacks under it (three bars at most).
- Task lists kept by subagents are left alone.
- The clock ticks only while a task is running; nothing runs while idle.

## The next-step question moves into the band (desktop app)

When Claude ends a turn on a question in the desktop app (the box with a question and reply buttons), the app hides everything above the prompt while that box is up, plan-bridge's bar included. So plan-bridge moves the question into the band instead:

```
✓ Fix the checkout flow        ━━━━━━━━━━━━━━━━━━━━  100%  ✕
? Run the tests now?  [Yes, run them]  [Not now]
```

- The question and its buttons are taken off Claude's call as it streams in, so the app draws no box and the bar stays in view.
- A reply button puts its text in the prompt box. It does not send it: edit it if you like, then press Enter.
- The question row goes when you send your next prompt, or on `/clear`. The bar stays until ✕.
- The app's own box still shows when a button is an app action (commit, create a PR, merge), since only the app can run those.
- Turns run by subagents, the terminal and VS Code are not touched.

What changes for you with this on:

- The app no longer marks the session as "waiting on you" for these questions.
- Replies take one more Enter, since a button fills the prompt rather than sending.
- If you collapse the band (`[-]`), the question is collapsed with it; no box comes back in its place.
- Claude is told nothing is pending, so it won't repeat the question in its message; the question is in the band.

Turn plan-bridge off, or uninstall it, and the app's box comes back as before. plan-bridge changes no settings or files.

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
