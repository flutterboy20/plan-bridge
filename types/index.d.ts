export type StepStatus = 'pending' | 'active' | 'done'

export type Step = { title: string; status: StepStatus }

// The task list Claude keeps, as the bar shows it.
export type Bar = {
  // One id per list (also plan-progress's bar id, when it draws the bar).
  id: string
  title: string
  steps: Step[]
  // TaskCreate ids, in step order, for the terminal's task tools ('' for a step from another source).
  taskIds: string[]
  // When the list started and, once every step is done, when it finished (ms).
  startedAt: number
  endedAt: number | null
  // plan-progress is installed and draws this list, so this mod draws nothing.
  isFed: boolean
  // Closed with ✕, or a finished bar left behind when the next prompt went in.
  isHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'plan-bridge': {
      bar: Bar | null
      // How many bars this session has made: the next id's number.
      made: number
      // The person's latest prompt, the next bar's title.
      title: string
    }
  }
}
