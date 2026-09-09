export interface VitestAssertion {
  readonly status: string
  readonly title?: string
  readonly fullName?: string
}

export interface VitestFileResult {
  readonly name?: string
  readonly status?: string
  readonly startTime?: number
  readonly endTime?: number
  readonly assertionResults?: readonly VitestAssertion[]
}

export interface VitestJsonReport {
  readonly testResults?: readonly VitestFileResult[]
  readonly [key: string]: unknown
}

export interface DurationRow {
  readonly file: string
  readonly ms: number
  readonly tests: number
  readonly status: string
}

export declare const allTests: (report: VitestJsonReport) => (VitestAssertion & { file: string })[]
export declare const filesRun: (report: VitestJsonReport) => string[]
export declare const skipped: (report: VitestJsonReport) => (VitestAssertion & { file: string })[]
export declare const durations: (report: VitestJsonReport) => DurationRow[]
export declare const formatDurations: (rows: readonly DurationRow[]) => string
export declare const problems: (report: VitestJsonReport, expectedFiles: readonly string[]) => string[]
