export const QUANTITY_SOURCES = [
  'manual',
  'ocr_explicit',
  'system_default_1',
  'legacy_explicit_or_manual',
] as const;

export type QuantitySource = (typeof QUANTITY_SOURCES)[number];

export function isQuantitySource(value: unknown): value is QuantitySource {
  return typeof value === 'string' && QUANTITY_SOURCES.includes(value as QuantitySource);
}

export function quantitySourceFromOcr(quantityInferred: boolean): QuantitySource {
  return quantityInferred ? 'system_default_1' : 'ocr_explicit';
}

export function quantitySourceFromLegacy(quantityInferred: boolean): QuantitySource {
  return quantityInferred ? 'system_default_1' : 'legacy_explicit_or_manual';
}

export function quantityInferredFromSource(source: QuantitySource): boolean {
  return source === 'system_default_1';
}

export function quantitySourceLabel(source: QuantitySource): string {
  switch (source) {
    case 'manual': return '人工修改';
    case 'ocr_explicit': return 'OCR 识别';
    case 'system_default_1': return '系统默认 1';
    case 'legacy_explicit_or_manual': return '已明确（历史来源不明）';
  }
}

export function quantitySourcePriority(source: QuantitySource): number {
  switch (source) {
    case 'manual': return 3;
    case 'ocr_explicit':
    case 'legacy_explicit_or_manual':
      return 2;
    case 'system_default_1': return 1;
  }
}
