/**
 * Just enough protobuf and gRPC framing to open arkd's FILTERED subscription.
 *
 * The TS SDK cannot: `IndexerProvider` exposes only `subscribeForScripts`, and
 * arkd honours a CEL filter solely when `GetSubscription` is opened with an
 * EMPTY subscription_id — which the REST gateway cannot express, since its path
 * carries `{subscription_id}`. Confirmed against mutinynet: the filtered form
 * 404s over REST while the gRPC route answers with `application/grpc` framing.
 *
 * Hand-rolled rather than pulling in protobufjs, because the surface is two
 * messages out and two string fields in. Unknown fields are SKIPPED by wire
 * type rather than assumed absent — arkd may add fields, and a decoder that
 * mis-skips one silently returns the wrong string.
 */

/** A varint, and where it ended. */
const varint = (bytes: Uint8Array, at: number): { value: number; next: number } => {
  let value = 0
  let shift = 0
  let i = at
  for (; i < bytes.length; i += 1) {
    const byte = bytes[i]!
    value += (byte & 0x7f) * 2 ** shift
    // `value` is a JS number, so it stops being exact above 2^53 - 1 — well
    // before the 64 bits the wire format allows. Checked on the VALUE rather
    // than on `shift`, because that is precisely where precision is lost: a
    // shift bound either rejects varints that were fine or accepts one that
    // already rounded. A silently rounded length is worse than a refusal —
    // it would frame the next field at the wrong offset.
    if (!Number.isSafeInteger(value)) {
      throw new Error('protobuf varint exceeds the exact integer range')
    }
    if ((byte & 0x80) === 0) return { value, next: i + 1 }
    shift += 7
    if (shift > 63) throw new Error('protobuf varint overruns 64 bits')
  }
  throw new Error('protobuf varint is truncated')
}

const putVarint = (value: number): number[] => {
  const out: number[] = []
  let v = value
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

/** `field << 3 | wireType`, then a length, then the bytes. */
const lengthDelimited = (field: number, payload: Uint8Array): number[] => [
  ...putVarint(field * 8 + 2),
  ...putVarint(payload.length),
  ...payload,
]

/**
 * `GetSubscriptionRequest{ filter: { expressions } }`, with subscription_id
 * left EMPTY — the only form in which arkd applies the filter.
 */
export const encodeSubscriptionRequest = (expressions: readonly string[]): Uint8Array => {
  const utf8 = new TextEncoder()
  const filter: number[] = []
  for (const expression of expressions) {
    filter.push(...lengthDelimited(1, utf8.encode(expression)))
  }
  return Uint8Array.from(lengthDelimited(2, Uint8Array.from(filter)))
}

/** One gRPC frame: an uncompressed flag, a 4-byte big-endian length, the message. */
export const grpcFrame = (message: Uint8Array): Uint8Array => {
  const framed = new Uint8Array(5 + message.length)
  new DataView(framed.buffer).setUint32(1, message.length, false)
  framed.set(message, 5)
  return framed
}

/** Walk length-delimited fields, handing each to `visit`. Other wire types are skipped. */
const eachField = (bytes: Uint8Array, visit: (field: number, payload: Uint8Array) => void): void => {
  let at = 0
  while (at < bytes.length) {
    const tag = varint(bytes, at)
    const field = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    at = tag.next
    if (wire === 2) {
      const len = varint(bytes, at)
      const end = len.next + len.value
      if (end > bytes.length) throw new Error('protobuf length-delimited field overruns the message')
      visit(field, bytes.subarray(len.next, end))
      at = end
      continue
    }
    // Skip by wire type. Getting this wrong misaligns everything after it, so
    // an unknown type is an error rather than a guess.
    if (wire === 0) at = varint(bytes, at).next
    else if (wire === 5) at += 4
    else if (wire === 1) at += 8
    else throw new Error(`protobuf wire type ${wire} is not supported`)
  }
}

export interface SubscriptionEvent {
  txid: string
  /** The transaction, as arkd encodes it on this field. Empty when absent. */
  tx: string
}

/**
 * The event out of a `GetSubscriptionResponse`, or null for a heartbeat or the
 * subscription-started message — both of which are normal traffic, not faults.
 */
export const decodeSubscriptionResponse = (bytes: Uint8Array): SubscriptionEvent | null => {
  const utf8 = new TextDecoder()
  let event: Uint8Array | null = null
  eachField(bytes, (field, payload) => {
    if (field === 2) event = payload
  })
  if (event === null) return null

  let txid = ''
  let tx = ''
  eachField(event, (field, payload) => {
    if (field === 1) txid = utf8.decode(payload)
    if (field === 5) tx = utf8.decode(payload)
  })
  return { txid, tx }
}

/**
 * Split a gRPC byte stream into messages, keeping whatever remains partial.
 *
 * Frames do not align with chunk boundaries, so a reader that assumed one frame
 * per chunk would drop the tail of every large event.
 */
export const readFrames = (buffer: Uint8Array): { messages: Uint8Array[]; rest: Uint8Array } => {
  const messages: Uint8Array[] = []
  let at = 0
  while (buffer.length - at >= 5) {
    const length = new DataView(buffer.buffer, buffer.byteOffset + at + 1, 4).getUint32(0, false)
    if (buffer.length - at - 5 < length) break
    messages.push(buffer.subarray(at + 5, at + 5 + length))
    at += 5 + length
  }
  return { messages, rest: buffer.subarray(at) }
}
