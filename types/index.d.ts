export type StepStatus = 'pending' | 'active' | 'done'

export type Step = { title: string; status: StepStatus }

// The task list Claude keeps, as the bar shows it.
export type Bar = {
  // The plan-progress bar id, one per list.
  id: string
  title: string
  steps: Step[]
  // TaskCreate ids, in step order, for the terminal's task tools ('' for a step from another source).
  taskIds: string[]
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
