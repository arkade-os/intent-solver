import type { LockupContract } from '@arkade-os/solver-next/ports/arkade.js'

export const lockupContract = (paymentHash: string, payoutSats: number): LockupContract => ({
  id: 'swap-1',
  paymentHash,
  pkScript: '5120aa',
  lockupAddress: 'tark1lockup',
  payoutAddress: 'tark1payout',
  payoutSats,
  claimPacket: null,
  refundLocktime: 9_000,
  claimDelay: 512,
  refundDelay: 1_024,
  refundWithoutReceiverDelay: 1_536,
  receiverPubkey: '02',
  receiverPkScript: '51',
  serverPubkey: '04',
  emulatorPubkey: '05',
  clientRefundPubkey: '03',
  refundPkScript: '52',
  nonInteractiveParameters: true,
})
