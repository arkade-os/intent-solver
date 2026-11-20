import type { Setting } from './setting.js'

export interface SettingRepository {
  get(key: string): Promise<Setting | null>
  list(): Promise<readonly Setting[]>
  // Throws when the stored revision is not the one `setting` was changed from.
  save(setting: Setting): Promise<void>
}
