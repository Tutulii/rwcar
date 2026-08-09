export type RpcQuantity = `0x${string}`;

/** Convert the executor's canonical base-10 database value to an EVM RPC quantity. */
export function decimalToRpcQuantity(value: string): RpcQuantity {
  if (!/^\d+$/.test(value)) throw new Error('Transaction value must be an unsigned decimal integer');
  return `0x${BigInt(value).toString(16)}`;
}
