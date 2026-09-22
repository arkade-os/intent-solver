export interface CarrierArtifact {
  readonly file: string
  readonly package: string
  readonly version: string
  readonly license: string
  readonly licenseFrom: string
  readonly sha256: string
  readonly bytes: number
  readonly source: { readonly repository: string; readonly commit: string; readonly directory: string }
  readonly toolchain: {
    readonly node: string
    readonly pnpm: string
    readonly declaredPackageManager: string
    readonly command: string
    readonly platform: string
  }
}

export interface CarrierManifest {
  readonly note: string
  readonly packedAtUtc: string
  readonly artifacts: readonly CarrierArtifact[]
}

export declare const VENDOR_DIR: string
export declare const MANIFEST_PATH: string
export declare const PINNED_PACKAGES: readonly string[]
export declare const TAXI_CONSUMER: string
export declare const CANDIDATE_SWAP_SYMBOL: string
export declare const CANDIDATE_SDK_SYMBOL: string
export declare const sha256: (bytes: Uint8Array) => string
export declare const readTarMember: (archivePath: string, member: string) => string | undefined
export declare const archiveManifest: (archivePath: string) => Record<string, unknown>
export declare const readJson: (path: string) => Record<string, unknown>
export declare const fileSpec: (from: string, filename: string) => string
export declare const packageRootFrom: (fromFile: string, name: string) => string
export declare const assertCandidateExport: (packageRoot: string, name: string, symbol: string) => Promise<string>
