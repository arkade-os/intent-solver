// Process-wide because the packages that log these timings sit below the app's Config.
let latency = false

export const setLatencyDiagnostics = (on: boolean): void => {
  latency = on
}

export const latencyDiagnosticsEnabled = (): boolean => latency
