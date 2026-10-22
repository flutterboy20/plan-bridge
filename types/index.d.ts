export type StepStatus = 'pending' | 'active' | 'done'

export type Step = { title: string; status: StepStatus }

// running: at work; needs: waiting on the person (a question or a permission);
// error: stopped, or a step keeps failing; done: every step finished.
export type BarState = 'running' | 'needs' | 'error' | 'done'

export type AgentState = 'running' | 'needs' | 'done' | 'failed'

// One subagent at work for the task, as its row under the bar shows it.
export type AgentRun = {
  id: string
  title: string
  // The model it runs on, as the engine names it ('' until its first request).
  model: string
  effort: string
  // The tool it is using now, or how it ended.
  tool: string
  state: AgentState
  startedAt: number
  endedAt: number | null
  // Started by another subagent rather than by the main conversation.
  isNested: boolean
}

// The task list Claude keeps, as the bar shows it.
export type Bar = {
  // One id per list (also plan-progress's bar id, when it draws the bar).
  id: string
  title: string
  // Empty for a bar that only tracks agents (no task list was kept).
  steps: Step[]
  // TaskCreate ids, in step order, for the terminal's task tools ('' for a step from another source).
  taskIds: string[]
  // When the list started and, once it is done, when it finished (ms).
  startedAt: number
  endedAt: number | null
  state: BarState
  // Why it waits or stopped, in a few words; '' when running or done.
  note: string
  agents: AgentRun[]
  // plan-progress is installed and draws this list, so this mod draws nothing.
  isFed: boolean
  // Closed with ✕, or a finished bar left behind when the next prompt went in.
  isHidden: boolean
}

// A reply button under the bars: a press puts `message` in the prompt to send.
export type Reply = { label: string; message: string }

// The desktop's next-step question (wrap_up's), drawn in the band under the
// bars, since the desktop hides the band while its own box is up.
export type Question = { ask: string; replies: Reply[] }

declare module 'claude-code' {
  interface PluginState {
    'plan-bridge': {
      // The bars shown, oldest first: finished ones stay until closed with ✕.
      bars: Bar[]
      // How many bars this session has made: the next id's number.
      made: number
      // The person's latest prompt, the next bar's title.
      title: string
      // The question the last turn ended on, until the person's next prompt.
      question: Question | null
    }
  }
}
