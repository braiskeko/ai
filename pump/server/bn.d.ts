/**
 * Minimal type declarations for `bn.js`.
 *
 * bn.js ships no types and `@types/bn.js` is not installed (it is a transitive
 * dependency of @solana/web3.js and the Meteora SDK, both of which import it
 * from their own .d.ts files). Declaring the subset the server actually uses
 * keeps `tsc --noEmit` clean without adding a dependency.
 */
declare module "bn.js" {
  export type Endianness = "le" | "be";

  export default class BN {
    constructor(
      value: number | string | number[] | Uint8Array | Buffer | BN,
      base?: number | "hex",
      endian?: Endianness,
    );

    static isBN(value: unknown): value is BN;
    static max(left: BN, right: BN): BN;
    static min(left: BN, right: BN): BN;

    clone(): BN;
    toString(base?: number | "hex", length?: number): string;
    toNumber(): number;
    toJSON(): string;
    toArray(endian?: Endianness, length?: number): number[];
    toBuffer(endian?: Endianness, length?: number): Buffer;
    bitLength(): number;
    isZero(): boolean;
    isNeg(): boolean;
    abs(): BN;
    neg(): BN;
    add(b: BN): BN;
    sub(b: BN): BN;
    mul(b: BN): BN;
    div(b: BN): BN;
    mod(b: BN): BN;
    pow(b: BN): BN;
    muln(b: number): BN;
    divn(b: number): BN;
    shln(b: number): BN;
    shrn(b: number): BN;
    cmp(b: BN): -1 | 0 | 1;
    lt(b: BN): boolean;
    lte(b: BN): boolean;
    gt(b: BN): boolean;
    gte(b: BN): boolean;
    eq(b: BN): boolean;
  }
}
