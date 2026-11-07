import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { llmDeps } from '@/lib/app-deps';
import { CatalogInputError, type ListingPhoto, MAX_PHOTOS, PHOTOS_BASE64_MAX } from '@/lib/catalog/build';
import { CSV_MAX_BYTES } from '@/lib/catalog/csv';
import { OnboardError, type OnboardErrorCode, onboardSeller } from '@/lib/catalog/onboard';
import { readBody } from '@/lib/http/read-body';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Onboards a new seller: their shop name, address and payout email, and a catalog from a CSV, product
// photos or both. The catalog builder drafts and screens the listings, the market benchmarks them,
// and the seller and its products are stored together. Every refusal comes back with a message the
// seller can act on; nothing about the model call or the market search does.

const ROUTE = 'seller_onboard';

/** The largest body read: all the photos the builder takes, with a MiB to spare for the CSV and the rest. */
const MAX_BODY_BYTES = PHOTOS_BASE64_MAX + 1024 * 1024;

const NOT_JSON = 'Send the shop details and the catalog as JSON.';
const PHOTO = 'Each photo needs its image type, its image data in base64 and a price in cents.';
const CSV_TOO_LARGE = `The catalog CSV can be at most ${CSV_MAX_BYTES / (1024 * 1024)} MB. Split it into smaller files.`;
const TOO_MANY_PHOTOS = `At most ${MAX_PHOTOS} photos can be listed at once.`;

const Photo = z.object(
  {
    // The builder checks each photo's type, data, price and stock, with a message naming the photo.
    mediaType: z.string({ error: PHOTO }),
    base64: z.string({ error: PHOTO }),
    priceCents: z.number({ error: PHOTO }),
    stock: z.number({ error: 'A photo stock must be a whole number.' }).nullable().optional(),
  },
  { error: PHOTO },
);

const OnboardRequest = z.object(
  {
    name: z.string({ error: 'Give your shop a name.' }),
    slug: z.string({ error: 'Choose an address for your shop.' }),
    payoutEmail: z.string({ error: 'Give the email your payouts go to.' }),
    // Capped before the CSV is read, so reading it, and listing the lines it rejects, stays small.
    csvText: z
      .string({ error: 'Send the catalog CSV as text.' })
      .refine((text) => Buffer.byteLength(text, 'utf8') <= CSV_MAX_BYTES, { error: CSV_TOO_LARGE })
      .optional(),
    // Counted before any photo is checked, so a long list is refused for its length alone.
    images: z
      .array(z.unknown(), { error: PHOTO })
      .max(MAX_PHOTOS, { error: TOO_MANY_PHOTOS })
      .pipe(z.array(Photo))
      .optional(),
  },
  { error: NOT_JSON },
);

const STATUS: Record<OnboardErrorCode, number> = {
  invalid_name: 400,
  invalid_slug: 400,
  invalid_payout_email: 400,
  no_listings: 400,
  slug_taken: 409,
  build_failed: 502,
};

/** What the seller is told when the build fails, whatever the model call's failure was. */
const BUILD_FAILED = 'Behest could not draft listings from this catalog. Try again.';
const FAILED = 'Onboarding failed. Try again.';

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

function refused(failure: OnboardError): Response {
  const message = failure.code === 'build_failed' ? BUILD_FAILED : failure.message;
  const rejected = failure.code === 'no_listings' ? { rejected: failure.rejected } : {};
  return Response.json({ error: { code: failure.code, message, ...rejected } }, { status: STATUS[failure.code] });
}

/**
 * `POST { name, slug, payoutEmail, csvText?, images? }`: creates the seller and returns 201 with
 * `{ sellerId, created, flagged, rejected }`, where `rejected` lists the CSV lines that were not listed.
 */
export async function POST(request: NextRequest) {
  // Calls the model and writes to the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'seller');
  if (refusal) return refusal;
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:seller`, MODEL_ROUTE_LIMIT)) {
    return error(429, 'Too many requests at once. Try again in a minute.');
  }

  const raw = await readBody(request, MAX_BODY_BYTES);
  if (raw === null) return error(413, 'This request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error(400, NOT_JSON);
  }
  const parsed = OnboardRequest.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0].message);
  const { images, ...shop } = parsed.data;

  try {
    // The builder refuses any photo whose type is not one it lists, so the cast only names the type.
    const result = await onboardSeller(llmDeps(), { ...shop, images: images as ListingPhoto[] | undefined });
    return Response.json(result, { status: 201 });
  } catch (failure) {
    if (failure instanceof OnboardError) return refused(failure);
    if (failure instanceof CatalogInputError) return error(400, failure.message);
    console.error('[sellers] Onboarding failed:', failure);
    return error(500, FAILED);
  }
}
