import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import { z } from 'zod';
import { type Category, isCategory } from '@/lib/domain/categories';
import type { LlmDeps, LlmResult } from '@/lib/llm/client';
import { callStructured } from '@/lib/llm/structured';
import { wrapUntrusted } from '@/lib/llm/untrusted';
import { type CatalogRow, multiLine, oneLine, SKU_PATTERN } from './csv';
import { CATALOG_SYSTEM_PROMPT } from './prompts';
import { screenText } from './screen';

// The catalog builder: turns a seller's CSV rows or photos into listing drafts in the fixed category
// list, each screened for text aimed at AI agents. The model writes only the title, description,
// category and its own screening. SKUs, prices and stock come from the seller, so nothing the model
// writes can change what a buyer is charged, and the fixed screen runs on the seller's text and on
// the model's output whatever the model says about them.

export type ListingDraft = {
  sku: string;
  title: string;
  description: string;
  category: Category;
  priceCents: number;
  stock: number | null;
  screening: { suspicious: boolean; reason: string | null };
};

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** A product photo with the price and stock the seller gives for it. The model never sets a price. */
export type ListingPhoto = {
  mediaType: (typeof PHOTO_TYPES)[number];
  /** The image bytes in base64, without a `data:` prefix. */
  base64: string;
  priceCents: number;
  stock?: number | null;
};

export type BuildInput = { rows?: CatalogRow[]; images?: ListingPhoto[] };

/** Input the builder refuses before any model call, with a message the seller can act on. */
export class CatalogInputError extends Error {
  override name = 'CatalogInputError';
}

/** Rows per model call. */
export const BATCH_SIZE = 50;
/** Photos per build. They all go in one call. */
export const MAX_PHOTOS = 8;

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const REASON_MAX = 300;
/** The largest value of a Postgres integer, the column type of price and stock. */
const INT_MAX = 2_147_483_647;
/**
 * The longest batch text sent. The CSV reader caps a name at 120 and a description at 2000 code
 * points, so a batch of rows from it stays far below this even with every character escaped.
 */
const BATCH_TEXT_MAX = 2_000_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The reason given when the model flags a listing without saying why. */
const FLAGGED = 'flagged as text aimed at AI agents';

/**
 * One listing as the model writes it. The JSON schema sent is strict (no other fields, every field
 * required); fields a reply adds anyway, such as a price, are dropped when it is read.
 */
const CatalogItem = z.object({
  sku: z.string(),
  title: z.string(),
  description: z.string(),
  /**
   * A category id. Checked here rather than in the schema, because the SDK cannot send an enum as a
   * constraint, and one stray category would otherwise fail the whole batch.
   */
  category: z.string(),
  screening: z.object({ suspicious: z.boolean(), reason: z.string().nullable() }),
});
type CatalogItem = z.infer<typeof CatalogItem>;

export const CatalogOutput = z.object({ items: z.array(CatalogItem) });

/**
 * Listing drafts for a seller's CSV rows and photos: the rows in batches of `BATCH_SIZE`, one model
 * call each, then the photos in one call. Drafts come back in the order given, rows first. A row the
 * model leaves out is drafted from its own text in category `other`. Any failed call fails the
 * build with that call's failure, and no further calls are made; on success `callId` is the last
 * call's. Throws `CatalogInputError` before any call for input it cannot list.
 */
export async function buildListings(deps: LlmDeps, input: BuildInput): Promise<LlmResult<ListingDraft[]>> {
  const rows = input.rows ?? [];
  const photos = input.images ?? [];
  checkRows(rows);
  checkPhotos(photos);
  if (rows.length === 0 && photos.length === 0) {
    throw new CatalogInputError('Give at least one row or photo to build listings from');
  }

  const drafts: ListingDraft[] = [];
  let callId = '';
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const reply = await callStructured(deps, 'catalog_build', {
      system: CATALOG_SYSTEM_PROMPT,
      messages: [rowsMessage(batch)],
      schema: CatalogOutput,
    });
    if (!reply.ok) return reply;
    drafts.push(...rowDrafts(batch, reply.value.items));
    callId = reply.callId;
  }

  if (photos.length > 0) {
    const reply = await callStructured(deps, 'catalog_build', {
      system: CATALOG_SYSTEM_PROMPT,
      messages: [photosMessage(photos)],
      schema: CatalogOutput,
    });
    if (!reply.ok) return reply;
    const { items } = reply.value;
    if (items.length !== photos.length) {
      const detail = `The reply listed ${items.length} of ${photos.length} photos`;
      return { ok: false, error: 'invalid_output', callId: reply.callId, detail };
    }
    const claimed = new Set(rows.map((r) => r.sku.toUpperCase()));
    drafts.push(...photos.map((photo, index) => photoDraft(photo, index + 1, items[index], claimed)));
    callId = reply.callId;
  }

  return { ok: true, value: drafts, callId };
}

/** Rows are matched to listings by SKU, so two rows may not share one. */
function checkRows(rows: CatalogRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.sku.toUpperCase();
    if (seen.has(key)) throw new CatalogInputError(`SKU ${row.sku} is on more than one row`);
    seen.add(key);
  }
}

function checkPhotos(photos: ListingPhoto[]): void {
  if (photos.length > MAX_PHOTOS) {
    throw new CatalogInputError(`At most ${MAX_PHOTOS} photos can be listed at once, got ${photos.length}`);
  }
  photos.forEach((photo, index) => {
    const which = `Photo ${index + 1}`;
    if (!(PHOTO_TYPES as readonly string[]).includes(photo.mediaType)) {
      throw new CatalogInputError(`${which} must be a JPEG, PNG or WebP image, not ${JSON.stringify(photo.mediaType)}`);
    }
    if (typeof photo.base64 !== 'string' || !BASE64.test(photo.base64)) {
      throw new CatalogInputError(`${which} must be base64 image data without a data: prefix`);
    }
    if (!isWholeNumber(photo.priceCents, 1)) {
      throw new CatalogInputError(`${which} needs a price in whole cents from 1 to ${INT_MAX}`);
    }
    if (photo.stock != null && !isWholeNumber(photo.stock, 0)) {
      throw new CatalogInputError(`${which} stock must be a whole number from 0 to ${INT_MAX}`);
    }
  });
}

function isWholeNumber(value: unknown, min: number): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= INT_MAX;
}

/** The listed category a piece of text names, read case-insensitively with spaces, dashes or underscores between words, or null. */
function categoryOf(text: string | null): Category | null {
  const id = (text ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '_');
  return isCategory(id) ? id : null;
}

/** The batch's rows as untrusted seller text. Prices and stock are left out: the model has no use for them. */
function rowsMessage(batch: CatalogRow[]): BetaMessageParam {
  const rows = batch.map((row) => ({
    sku: row.sku,
    name: row.name,
    description: row.description,
    sellerCategory: row.category,
    categoryHint: categoryOf(row.category),
  }));
  const wrapped = wrapUntrusted('seller_listing', JSON.stringify(rows), BATCH_TEXT_MAX);
  return { role: 'user', content: `Write one listing for each of the ${batch.length} rows below.\n\n${wrapped}` };
}

/** Each photo as an image block after its label, so the model can keep them in order. */
function photosMessage(photos: ListingPhoto[]): BetaMessageParam {
  const content: BetaContentBlockParam[] = photos.flatMap((photo, index): BetaContentBlockParam[] => [
    { type: 'text', text: `Photo ${index + 1}` },
    { type: 'image', source: { type: 'base64', media_type: photo.mediaType, data: photo.base64 } },
  ]);
  content.push({
    type: 'text',
    text: `Write one listing for each of the ${photos.length} photos, in the order of the photos.`,
  });
  return { role: 'user', content };
}

/** A draft for each row in the batch: from the first listing whose SKU matches it in any case, or from the row alone. */
function rowDrafts(batch: CatalogRow[], items: CatalogItem[]): ListingDraft[] {
  const bySku = new Map<string, CatalogItem>();
  for (const item of items) {
    const key = item.sku.trim().toUpperCase();
    if (!bySku.has(key)) bySku.set(key, item);
  }
  return batch.map((row) => {
    const item = bySku.get(row.sku.toUpperCase());
    return item ? rowDraft(row, item) : fallbackDraft(row);
  });
}

function rowDraft(row: CatalogRow, item: CatalogItem): ListingDraft {
  const title = oneLine(item.title, TITLE_MAX) || oneLine(row.name, TITLE_MAX);
  const description = multiLine(item.description, DESCRIPTION_MAX) || multiLine(row.description, DESCRIPTION_MAX);
  return {
    sku: row.sku,
    title,
    description,
    category: categoryOf(item.category) ?? 'other',
    priceCents: row.priceCents,
    stock: row.stock,
    screening: screening(item.screening, [sourceText(row), `${title}\n${description}`]),
  };
}

/** A row the model left out, listed as the seller wrote it. */
function fallbackDraft(row: CatalogRow): ListingDraft {
  return {
    sku: row.sku,
    title: oneLine(row.name, TITLE_MAX),
    description: multiLine(row.description, DESCRIPTION_MAX),
    category: 'other',
    priceCents: row.priceCents,
    stock: row.stock,
    screening: screening({ suspicious: false, reason: null }, [sourceText(row)]),
  };
}

/** The seller's name and description screened together, so a phrase split across them is still caught. */
function sourceText(row: CatalogRow): string {
  return `${row.name}\n${row.description}`;
}

function photoDraft(photo: ListingPhoto, number: number, item: CatalogItem, claimed: Set<string>): ListingDraft {
  const title = oneLine(item.title, TITLE_MAX) || `Photo ${number}`;
  const description = multiLine(item.description, DESCRIPTION_MAX);
  return {
    sku: photoSku(item.sku, number, claimed),
    title,
    description,
    category: categoryOf(item.category) ?? 'other',
    priceCents: photo.priceCents,
    stock: photo.stock ?? null,
    screening: screening(item.screening, [`${title}\n${description}`]),
  };
}

/**
 * The SKU the model proposed for a photo when it is a valid SKU no other listing in the build uses,
 * otherwise `PHOTO-<number>`, or `PHOTO-<number>-2` and so on when that is taken. Claims what it returns.
 */
function photoSku(proposed: string, number: number, claimed: Set<string>): string {
  let sku = proposed.trim();
  for (let attempt = 1; !SKU_PATTERN.test(sku) || claimed.has(sku.toUpperCase()); attempt += 1) {
    sku = attempt === 1 ? `PHOTO-${number}` : `PHOTO-${number}-${attempt}`;
  }
  claimed.add(sku.toUpperCase());
  return sku;
}

/**
 * Suspicious when the model says so or the fixed screen flags any of `texts`. The reason is the
 * model's when it flagged the listing, otherwise the first phrase the screen matched, strong first.
 */
function screening(model: CatalogItem['screening'], texts: string[]): ListingDraft['screening'] {
  const matched = texts.map(screenText).find((result) => result.suspicious);
  if (!model.suspicious && !matched) return { suspicious: false, reason: null };
  const modelReason = model.suspicious ? oneLine(model.reason ?? '', REASON_MAX) : '';
  const matchedReason = matched ? `matched: ${matched.strong[0] ?? matched.weak[0]}` : FLAGGED;
  return { suspicious: true, reason: modelReason || matchedReason };
}
