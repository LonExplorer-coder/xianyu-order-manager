export function normalizePhone(value: string): string {
  return value.normalize('NFKC').replace(/\D/gu, '');
}

export function isValidPhonePair(phone: string, normalized: string): boolean {
  const canonical = normalizePhone(phone);
  return (
    !phone.includes('*') &&
    /^[+\d\s()-]+$/u.test(phone.trim()) &&
    /^\d{7,20}$/u.test(canonical) &&
    normalized === canonical
  );
}

export function normalizeAddress(value: string): string {
  return value.normalize('NFKC').replace(/[\s,，、;；]+/gu, '');
}

export function isValidAddressPair(original: string, normalized: string): boolean {
  const canonical = normalizeAddress(original);
  return canonical.length > 0 && normalized === canonical;
}

export function normalizeShanghaiDateTime(value: string): string {
  if (!value) return '';
  const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2}):(\d{2}):(\d{2})$/u.exec(
    value.normalize('NFKC'),
  );
  if (!match) return '';
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const checked = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day ||
    checked.getUTCHours() !== hour ||
    checked.getUTCMinutes() !== minute ||
    checked.getUTCSeconds() !== second
  ) {
    return '';
  }
  const pad = (entry: number) => String(entry).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`;
}
