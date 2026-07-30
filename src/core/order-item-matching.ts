import type { RecognitionItem } from './contracts';

export type IdentifiedOrderItem = RecognitionItem & { id: string };

/**
 * Conservatively maps incoming draft items to persisted items without using row position.
 * A pair is accepted only when its signature is unique on both remaining sides.
 */
export function matchOrderItemIds(
  existingItems: readonly IdentifiedOrderItem[],
  draftItems: readonly IdentifiedOrderItem[],
): Map<string, string> {
  const unmatchedExisting = new Set(existingItems.map((_item, index) => index));
  const unmatchedDraft = new Set(draftItems.map((_item, index) => index));
  const existingIdByDraftId = new Map<string, string>();

  matchUniqueSignatures(
    existingItems,
    draftItems,
    unmatchedExisting,
    unmatchedDraft,
    existingIdByDraftId,
    completeItemSignature,
  );
  matchUniqueSignatures(
    existingItems,
    draftItems,
    unmatchedExisting,
    unmatchedDraft,
    existingIdByDraftId,
    titleSpecPriceSignature,
  );
  matchUniqueSignatures(
    existingItems,
    draftItems,
    unmatchedExisting,
    unmatchedDraft,
    existingIdByDraftId,
    titleSpecSignature,
  );
  matchUniqueAlternativeSignatures(
    existingItems,
    draftItems,
    unmatchedExisting,
    unmatchedDraft,
    existingIdByDraftId,
    [specPriceSignature, titlePriceSignature],
  );

  return existingIdByDraftId;
}

function matchUniqueAlternativeSignatures(
  existingItems: readonly IdentifiedOrderItem[],
  draftItems: readonly IdentifiedOrderItem[],
  unmatchedExisting: Set<number>,
  unmatchedDraft: Set<number>,
  existingIdByDraftId: Map<string, string>,
  signatures: readonly ItemSignature[],
): void {
  const existingCandidatesByDraft = new Map<number, Set<number>>();
  const draftCandidatesByExisting = new Map<number, Set<number>>();

  for (const draftIndex of unmatchedDraft) {
    for (const existingIndex of unmatchedExisting) {
      const matches = signatures.some((signature) => {
        const existingSignature = signature(existingItems[existingIndex]);
        return existingSignature !== null &&
          existingSignature === signature(draftItems[draftIndex]);
      });
      if (!matches) continue;
      addCandidate(existingCandidatesByDraft, draftIndex, existingIndex);
      addCandidate(draftCandidatesByExisting, existingIndex, draftIndex);
    }
  }

  const matches: Array<{ existingIndex: number; draftIndex: number }> = [];
  for (const [draftIndex, existingCandidates] of existingCandidatesByDraft) {
    if (existingCandidates.size !== 1) continue;
    const [existingIndex] = existingCandidates;
    if (draftCandidatesByExisting.get(existingIndex)?.size !== 1) continue;
    matches.push({ existingIndex, draftIndex });
  }

  for (const { existingIndex, draftIndex } of matches) {
    unmatchedExisting.delete(existingIndex);
    unmatchedDraft.delete(draftIndex);
    existingIdByDraftId.set(draftItems[draftIndex].id, existingItems[existingIndex].id);
  }
}

function addCandidate(
  candidates: Map<number, Set<number>>,
  sourceIndex: number,
  targetIndex: number,
): void {
  const targets = candidates.get(sourceIndex) ?? new Set<number>();
  targets.add(targetIndex);
  candidates.set(sourceIndex, targets);
}

type ItemSignature = (item: IdentifiedOrderItem) => string | null;

function matchUniqueSignatures(
  existingItems: readonly IdentifiedOrderItem[],
  draftItems: readonly IdentifiedOrderItem[],
  unmatchedExisting: Set<number>,
  unmatchedDraft: Set<number>,
  existingIdByDraftId: Map<string, string>,
  signature: ItemSignature,
): void {
  const existingBySignature = groupBySignature(existingItems, unmatchedExisting, signature);
  const draftBySignature = groupBySignature(draftItems, unmatchedDraft, signature);
  const matches: Array<{ existingIndex: number; draftIndex: number }> = [];

  for (const [key, existingIndices] of existingBySignature) {
    const draftIndices = draftBySignature.get(key);
    if (existingIndices.length !== 1 || draftIndices?.length !== 1) continue;
    matches.push({ existingIndex: existingIndices[0], draftIndex: draftIndices[0] });
  }

  for (const { existingIndex, draftIndex } of matches) {
    unmatchedExisting.delete(existingIndex);
    unmatchedDraft.delete(draftIndex);
    existingIdByDraftId.set(draftItems[draftIndex].id, existingItems[existingIndex].id);
  }
}

function groupBySignature(
  items: readonly IdentifiedOrderItem[],
  unmatched: ReadonlySet<number>,
  signature: ItemSignature,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const index of unmatched) {
    const key = signature(items[index]);
    if (key === null) continue;
    const indices = groups.get(key) ?? [];
    indices.push(index);
    groups.set(key, indices);
  }
  return groups;
}

function completeItemSignature(item: IdentifiedOrderItem): string {
  return JSON.stringify([
    normalizedItemText(item.sourceTitle),
    normalizedItemText(item.sourceSpec),
    item.unitPriceCents,
    item.quantity,
    item.quantityInferred,
  ]);
}

function titleSpecPriceSignature(item: IdentifiedOrderItem): string | null {
  const title = normalizedItemText(item.sourceTitle);
  if (!title || item.unitPriceCents === null) return null;
  return JSON.stringify([
    title,
    normalizedItemText(item.sourceSpec),
    item.unitPriceCents,
  ]);
}

function titleSpecSignature(item: IdentifiedOrderItem): string | null {
  const title = normalizedItemText(item.sourceTitle);
  if (!title) return null;
  return JSON.stringify([title, normalizedItemText(item.sourceSpec)]);
}

function specPriceSignature(item: IdentifiedOrderItem): string | null {
  const spec = normalizedItemText(item.sourceSpec);
  if (!spec || item.unitPriceCents === null) return null;
  return JSON.stringify([spec, item.unitPriceCents]);
}

function titlePriceSignature(item: IdentifiedOrderItem): string | null {
  const title = normalizedItemText(item.sourceTitle);
  if (!title || item.unitPriceCents === null) return null;
  return JSON.stringify([title, item.unitPriceCents]);
}

function normalizedItemText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}
