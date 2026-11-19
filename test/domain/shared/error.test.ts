import { describe, expect, it } from 'vitest'
import { Setting } from '@arkade-os/solver-core/domain/admin/setting.js'
import { DomainError, ErrorCode } from '@arkade-os/solver-core/domain/shared/error.js'
import { Hashlock } from '@arkade-os/solver-core/domain/swap/hashlock.js'
import { Swap } from '@arkade-os/solver-core/domain/swap/swap.js'
import { quoted, t } from '../support.js'

describe('domain errors', () => {
  it('throws errors a caller can tell apart by code', () => {
    const swap = quoted()
    const codeOf = (run: () => unknown): unknown => {
      try {
        run()
      } catch (error) {
        return error instanceof DomainError ? error.code : error
      }
    }
    expect(codeOf(() => swap.refund('from', t(1_001)))).toBe(ErrorCode.IllegalTransition)
    expect(codeOf(() => swap.lock('to', t(1_001)))).toBe(ErrorCode.RuleViolated)
    expect(codeOf(() => Swap.fromEvents([]))).toBe(ErrorCode.Corrupt)
    expect(codeOf(() => Hashlock.of('zz'))).toBe(ErrorCode.Invalid)
    expect(codeOf(() => Setting.initial('KEY', '1').change('2', 7))).toBe(ErrorCode.Conflict)
  })
})
