import { afterAll, expect } from 'vitest'
import { explained, shadowPlan } from './shadowPlan.js'

// The legacy scenarios, run a second time with `plan` asked before every step. The legacy test file is not edited:
// importing it registers its tests here, after the shadow is in place.
const shadow = shadowPlan()
await import('../../receive/orchestrator.test.js')

afterAll(() => {
  shadow.stop()
  expect(shadow.steps()).toBeGreaterThan(300)
  expect(shadow.differences.filter((difference) => explained(difference) === null)).toEqual([])
})
