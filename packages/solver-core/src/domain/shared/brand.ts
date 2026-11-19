import { InvalidValue } from './error.js'

declare const brand: unique symbol

export type Brand<T, Name extends string> = T & { readonly [brand]: Name }

export type ValueOf<T> = T[keyof T]

export const nonEmpty = <B extends string>(name: string, value: string): B => {
  if (value === '') throw new InvalidValue(`${name} must not be empty`)
  return value as B
}
