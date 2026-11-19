/**
 * @module @zenith/traits/cells/ids
 *
 * Cell ids, as celld builds them: 32 bytes in hexadecimal. The first 16 bytes are the HMAC-SHA-256 of
 * the name (`idFromName`) or random (`newUniqueId`); the last 16 are the HMAC of the first 16, so
 * `idFromString` refuses an id of another namespace. The namespace key is derived (SHA-256) from the script (app)
 * name and the class name, as in celld: renaming either reaches new, empty cells.
 */
import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { CellError, type DurableObjectId } from "./types.ts";

const HEX64 = /^[0-9a-f]{64}$/;

/** A cell id; `name` is kept only when it came from `idFromName()`. */
export class CellId implements DurableObjectId {
  /** The name it was derived from, if any. */
  readonly name?: string;
  readonly #hex: string;
  /** An id from its hexadecimal form (already validated by the namespace). */
  constructor(hex: string, name?: string) {
    this.#hex = hex;
    if (name !== undefined) this.name = name;
  }
  /** The 64-digit hexadecimal form. */
  toString(): string {
    return this.#hex;
  }
  /** Same cell. */
  equals(other: DurableObjectId): boolean {
    return other.toString() === this.#hex;
  }
  /** Serialized as its hexadecimal form. */
  toJSON(): string {
    return this.#hex;
  }
}

/** Creates and validates the ids of one namespace (one cell class of one app). */
export class CellIdFactory {
  readonly #key: Buffer;
  /** The namespace of class `className` in app (script) `scriptName`. */
  constructor(scriptName: string, className: string) {
    // The namespace key is derived, not secret: SHA-256 over a domain label and the two names (ids are
    // addresses, not credentials; ADR-019).
    this.#key = createHash("sha256").update("zenith-cells/v1\0").update(
      `${scriptName}\0${className}`,
    )
      .digest();
  }
  #mac(label: string, data: Uint8Array | string): Buffer {
    return createHmac("sha256", this.#key).update(label).update(data).digest();
  }
  #seal(head: Uint8Array): string {
    const tag = this.#mac("tag\0", head).subarray(0, 16);
    return Buffer.concat([head, tag]).toString("hex");
  }
  /** The id of `name`: always the same for the same namespace. */
  fromName(name: string): CellId {
    if (typeof name !== "string") throw new CellError("bad_id", "idFromName() needs a string");
    return new CellId(this.#seal(this.#mac("name\0", name).subarray(0, 16)), name);
  }
  /** A new random id. */
  unique(): CellId {
    return new CellId(this.#seal(crypto.getRandomValues(new Uint8Array(16))));
  }
  /** Parses `hex`; throws `CellError("bad_id")` when it does not belong to this namespace. */
  fromString(hex: string, name?: string): CellId {
    const h = String(hex).toLowerCase();
    if (!HEX64.test(h)) {
      throw new CellError("bad_id", "Invalid Durable Object ID: not 64 hex digits");
    }
    const head = Buffer.from(h.slice(0, 32), "hex");
    if (this.#seal(head) !== h) {
      throw new CellError("bad_id", "Durable Object ID is not valid for this namespace");
    }
    return new CellId(h, name);
  }
}
