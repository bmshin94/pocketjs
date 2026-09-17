/** Compile-time Micro TS capabilities. These declarations are consumed by
 * micro/compiler; they do not supply a JavaScript runtime implementation. */
import type { JSX } from "solid-js";
export type WindowField = "int" | "bool" | "text";
export type WindowSchema = Readonly<Record<string, WindowField>>;
type FieldValue<T> = T extends "text" ? string : T extends "bool" ? boolean : number;
export type WindowRow<S extends WindowSchema> = {
  readonly [K in keyof S]: () => FieldValue<S[K]>;
} & { valid(): boolean };
export interface WindowHandle<S extends WindowSchema> {
  /** Random access within the visible window, never the remote collection. */
  read<K extends keyof S>(slot: number, field: K): FieldValue<S[K]>;
  valid(slot: number): boolean;
  offset(): number;
  query(): number;
  len(): number;
  capacity(): number;
  /** Number of typed records resident in the native ring cache. */
  cached(): number;
  cacheCapacity(): number;
  inflight(): number;
  prefetching(): boolean;
  bytes(): number;
  received(): number;
  discarded(): number;
  loading(): boolean;
  online(): boolean;
  error(): boolean;
  more(): boolean;
  seek(offset: number): void;
  filter(query: number): void;
  retry(): void;
}
export declare function createWindow<const S extends WindowSchema>(config: {
  method: string;
  /** Compile-time literal, 1..8. text fields hold at most 96 UTF-8 bytes. */
  capacity: number;
  /** Fixed native record budget, capacity..1024; default capacity. */
  cacheCapacity?: number;
  /** Bounded wire page, 1..8, divides cacheCapacity; default capacity. */
  pageSize?: number;
  fields: S;
}): WindowHandle<S>;
/** Expands the row template into capacity reusable slots. Use row.valid()
 * for loading/empty slots. Row accessors borrow the current slot each read. */
export declare function Window<S extends WindowSchema>(props: {
  each: WindowHandle<S>;
  children: (row: WindowRow<S>, slot: number) => JSX.Element;
}): JSX.Element;

/** Immediate edge followed by accelerated frame-paced repeats while held.
 * 200 ms initial delay, 15 rows/s, 30 after 1 s, 60 after 3 s. */
export declare function onButtonRepeat(mask: number, callback: () => void): void;
