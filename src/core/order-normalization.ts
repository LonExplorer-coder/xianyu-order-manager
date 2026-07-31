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

export type AddressParts = {
  province: string;
  city: string;
  district: string;
};

export function deriveAddressParts(
  normalizedAddress: string,
  provided: AddressParts,
): AddressParts {
  if (!normalizedAddress) return provided;

  let rest = normalizedAddress;
  const municipality = /^(北京市|上海市|天津市|重庆市)/u.exec(rest)?.[1] ?? '';
  const parsedProvince = municipality ||
    /^([\p{Script=Han}]{2,12}?(?:特别行政区|自治区|省))/u.exec(rest)?.[1] ||
    '';
  rest = stripAddressPrefix(rest, parsedProvince);

  const parsedCity = municipality ||
    /^([\p{Script=Han}]{2,12}?(?:自治州|地区|市|盟))/u.exec(rest)?.[1] ||
    '';
  if (!municipality) rest = stripAddressPrefix(rest, parsedCity);
  rest = rest.replace(
    /^(?:市辖区|省直辖县级行政区(?:划)?|自治区直辖县级行政区(?:划)?)/u,
    '',
  );

  const parsedDistrictCandidate =
    /^([\p{Script=Han}]{1,12}?(?:自治县|市辖区|区|县|旗|市))/u.exec(rest)?.[1] ||
    '';
  const parsedDistrict = isFacilityAddressPart(parsedDistrictCandidate)
    ? ''
    : parsedDistrictCandidate;
  const providedDistrict = isFacilityAddressPart(provided.district)
    ? ''
    : provided.district;
  const hasParsedHierarchy = Boolean(parsedProvince || parsedCity);

  return {
    province: canonicalProvince(
      provided.province,
      parsedProvince,
      parsedCity,
      provided.city,
    ),
    city: administrativePart(
      provided.city,
      parsedCity,
      /(?:自治州|地区|市|盟)$/u,
      hasParsedHierarchy,
    ),
    district: administrativePart(
      providedDistrict,
      parsedDistrict,
      /(?:自治县|市辖区|区|县|旗|市)$/u,
      hasParsedHierarchy,
    ),
  };
}

function isFacilityAddressPart(value: string): boolean {
  return /(?:小区|园区|社区|校区|景区|厂区|片区)$/u.test(
    value.normalize('NFKC').replace(/\s+/gu, '').trim(),
  );
}

function administrativePart(
  provided: string,
  parsed: string,
  completeSuffix: RegExp,
  preferParsed: boolean,
): string {
  if (preferParsed && parsed) return parsed;
  if (provided && completeSuffix.test(provided)) return provided;
  return parsed || provided;
}

function canonicalProvince(
  providedProvince: string,
  parsedProvince: string,
  parsedCity: string,
  providedCity: string,
): string {
  if (parsedProvince) return parsedProvince;
  const province = normalizeAddress(providedProvince);
  for (const city of new Set([parsedCity, providedCity].map(normalizeAddress))) {
    if (!city || province === city || !province.endsWith(city)) continue;
    const provinceOnly = province.slice(0, -city.length);
    if (/(?:特别行政区|自治区|省|市)$/u.test(provinceOnly)) return provinceOnly;
  }
  return administrativePart(
    providedProvince,
    parsedProvince,
    /(?:特别行政区|自治区|省|市)$/u,
    false,
  );
}

function stripAddressPrefix(value: string, prefix: string): string {
  const normalizedPrefix = normalizeAddress(prefix);
  return normalizedPrefix && value.startsWith(normalizedPrefix)
    ? value.slice(normalizedPrefix.length)
    : value;
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
