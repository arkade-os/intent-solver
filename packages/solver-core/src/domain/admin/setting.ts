import { Conflict, InvalidValue } from '../shared/error.js'

export class Setting {
  private constructor(
    readonly key: string,
    /** Null clears the override and falls back to the configured value. */
    readonly value: string | null,
    readonly revision: number,
  ) {}

  static initial(key: string, value: string | null): Setting {
    if (key === '') throw new InvalidValue('setting needs a key')
    return new Setting(key, value, 1)
  }

  static restore(key: string, value: string | null, revision: number): Setting {
    return new Setting(key, value, revision)
  }

  /** `expected` is the revision the operator was looking at; a stale one must not overwrite a newer value. */
  change(value: string | null, expected: number): Setting {
    if (expected !== this.revision) {
      throw new Conflict(`setting ${this.key} is at revision ${this.revision}, not ${expected}`)
    }
    return value === this.value ? this : new Setting(this.key, value, this.revision + 1)
  }
}
