import { recoverMessageAddress, type Address, type Hex } from 'viem';
import { AppError } from '../errors.js';

export function cleanverseOwnerMessage(chain: string, subject: Address): string {
  return `${chain.toLowerCase()}${subject.toLowerCase()}`;
}

export async function verifyCleanverseOwnerSignature(
  chain: string,
  subject: Address,
  expectedOwner: Address,
  signature: Hex,
): Promise<Address> {
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: cleanverseOwnerMessage(chain, subject),
      signature,
    });
  } catch {
    throw new AppError(422, 'INVALID_OWNER_SIGNATURE', 'Owner signature could not be recovered');
  }
  if (recovered.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new AppError(403, 'OWNER_SIGNATURE_MISMATCH', 'Signature does not match the live contract owner');
  }
  return recovered;
}
