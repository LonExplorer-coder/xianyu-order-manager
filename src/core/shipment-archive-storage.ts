export type StoredShipmentArchiveRecipientSnapshot = {
  orderId: string;
  recipient: string;
  phone: string;
  addressOriginal: string;
};

export function parseStoredShipmentArchiveOrderIds(
  serialized: string,
  message: string,
): string[] {
  const parsed = parseStoredJson(serialized, message);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((value) => typeof value === 'string' && value.length > 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(message);
  }
  return parsed;
}

export function parseStoredShipmentArchiveRecipientSnapshots(
  serialized: string,
  message: string,
): StoredShipmentArchiveRecipientSnapshot[] {
  const parsed = parseStoredJson(serialized, message);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(message);
  const snapshots = parsed.map((value) => {
    if (
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      typeof Reflect.get(value, 'orderId') !== 'string' ||
      (Reflect.get(value, 'orderId') as string).length === 0 ||
      typeof Reflect.get(value, 'recipient') !== 'string' ||
      typeof Reflect.get(value, 'phone') !== 'string' ||
      typeof Reflect.get(value, 'addressOriginal') !== 'string'
    ) {
      throw new Error(message);
    }
    return {
      orderId: Reflect.get(value, 'orderId') as string,
      recipient: Reflect.get(value, 'recipient') as string,
      phone: Reflect.get(value, 'phone') as string,
      addressOriginal: Reflect.get(value, 'addressOriginal') as string,
    };
  });
  if (new Set(snapshots.map(({ orderId }) => orderId)).size !== snapshots.length) {
    throw new Error(message);
  }
  return snapshots;
}

function parseStoredJson(serialized: string, message: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}
