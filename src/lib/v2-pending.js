export const V2_PENDING_STORAGE_KEY = 'rwcar:v2:pending-executions:v1';

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function pendingRecordId(record) {
  return `${record.chainId}:${record.wallet?.toLowerCase()}:${record.phase}:${record.hash || (record.txHashes || []).join(',')}`;
}

export function readPendingExecutions(storage) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(V2_PENDING_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record) => Number.isSafeInteger(record?.chainId)
      && ADDRESS_RE.test(record?.wallet || '')
      && ['submitted', 'indexing'].includes(record?.phase)
      && (record.phase !== 'submitted' || HASH_RE.test(record.hash || ''))
      && (record.phase !== 'indexing' || (Array.isArray(record.txHashes) && record.txHashes.length > 0 && record.txHashes.every((hash) => HASH_RE.test(hash)))));
  } catch {
    return [];
  }
}

function write(storage, records) {
  storage?.setItem(V2_PENDING_STORAGE_KEY, JSON.stringify(records));
  return records;
}

export function upsertPendingExecution(storage, record) {
  const normalized = { ...record, id: record.id || pendingRecordId(record) };
  const records = readPendingExecutions(storage);
  const index = records.findIndex((item) => item.id === normalized.id);
  if (index >= 0) records[index] = normalized;
  else records.push(normalized);
  return write(storage, records);
}

export function removePendingExecution(storage, id) {
  return write(storage, readPendingExecutions(storage).filter((record) => record.id !== id));
}

export function pendingForWallet(storage, chainId, wallet) {
  const normalized = wallet?.toLowerCase();
  return readPendingExecutions(storage).filter((record) => record.chainId === chainId && record.wallet.toLowerCase() === normalized);
}
