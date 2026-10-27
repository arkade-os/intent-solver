export declare class RebalancePanel {
  constructor(api: (path: string, options?: { method: string; body: string }) => Promise<any>, redraw: () => void)
  data: any
  policy: any
  draft: Record<string, string>
  error: string | null
  busy: boolean
  loaded: boolean
  quote: any
  requestKey: string | null
  refresh(): Promise<void>
  act(action: string, body: unknown): Promise<void>
  quoteBody(): Record<string, unknown>
  policyPayload(): any
  render(h: (...args: any[]) => any): any
}
