import { describe, expect, it } from 'vitest';
import * as builder from '@/lib/catalog/build';
import * as csv from '@/lib/catalog/csv';
import {
  CSV_MAX_BYTES,
  CSV_MB,
  CSV_ROW_LIMIT,
  csvSizeProblem,
  MAX_PHOTOS,
  onboardRequest,
  PHOTO_BASE64_MAX,
  PHOTO_MB,
  PHOTOS_BASE64_MAX,
  PHOTOS_MB,
  type OnboardForm,
  type PhotoEntry,
} from '@/lib/seller-pages/onboard-request';

const CSV = 'sku,name,price\nTUR-100,Turmeric,4.50\n';

function photo(overrides: Partial<PhotoEntry> = {}): PhotoEntry {
  return { mediaType: 'image/jpeg', base64: '/9j/4AAQ', price: '4.50', stock: '', ...overrides };
}

function form(overrides: Partial<OnboardForm> = {}): OnboardForm {
  return {
    name: "Ravi's Spice Co.",
    slug: 'ravi-spices',
    payoutEmail: 'payouts@ravi-spices.example.com',
    csvText: CSV,
    photos: [],
    ...overrides,
  };
}

function refusal(input: OnboardForm): string {
  const result = onboardRequest(input);
  if (result.ok) throw new Error('expected the form to be refused');
  return result.message;
}

describe('onboardRequest', () => {
  it('sends the shop details and the CSV, with no images when there are no photos', () => {
    expect(onboardRequest(form())).toEqual({
      ok: true,
      body: { name: "Ravi's Spice Co.", slug: 'ravi-spices', payoutEmail: 'payouts@ravi-spices.example.com', csvText: CSV },
    });
  });

  it('trims the name and payout email but sends the CSV exactly as read', () => {
    const csvText = '  sku,name,price\r\nA,B,1\r\n';
    const result = onboardRequest(form({ name: '  Ravi  ', payoutEmail: ' ravi@example.com ', csvText }));
    expect(result).toMatchObject({ ok: true, body: { name: 'Ravi', payoutEmail: 'ravi@example.com', csvText } });
  });

  it('sends each photo with its price in whole cents and its stock when given', () => {
    const result = onboardRequest(
      form({
        csvText: null,
        photos: [photo({ price: '4.35', stock: '12' }), photo({ base64: 'iVBORw0K', mediaType: 'image/png', price: '$1,234.5' })],
      }),
    );
    expect(result).toEqual({
      ok: true,
      body: {
        name: "Ravi's Spice Co.",
        slug: 'ravi-spices',
        payoutEmail: 'payouts@ravi-spices.example.com',
        images: [
          { mediaType: 'image/jpeg', base64: '/9j/4AAQ', priceCents: 435, stock: 12 },
          { mediaType: 'image/png', base64: 'iVBORw0K', priceCents: 123450 },
        ],
      },
    });
  });

  it('sends the CSV and the photos together', () => {
    const result = onboardRequest(form({ photos: [photo()] }));
    expect(result).toMatchObject({ ok: true, body: { csvText: CSV, images: [{ priceCents: 450 }] } });
  });

  it('asks for a name and a payout email', () => {
    expect(refusal(form({ name: '   ' }))).toBe("Enter your shop's name.");
    expect(refusal(form({ payoutEmail: '' }))).toBe('Enter the PayPal email your payouts go to.');
  });

  it('asks for a CSV or photos, and refuses an empty CSV', () => {
    expect(refusal(form({ csvText: null, photos: [] }))).toBe('Add a catalog CSV, product photos or both.');
    expect(refusal(form({ csvText: ' \n ' }))).toBe('Your CSV file is empty.');
  });

  it('asks for a positive price on each photo, counting photos from 1', () => {
    expect(refusal(form({ photos: [photo(), photo({ price: '' })] }))).toBe('Give photo 2 a price in dollars, such as 4.50.');
    expect(refusal(form({ photos: [photo({ price: '0.00' })] }))).toBe('Give photo 1 a price in dollars, such as 4.50.');
    expect(refusal(form({ photos: [photo({ price: '4.505' })] }))).toBe('Give photo 1 a price in dollars, such as 4.50.');
  });

  it('refuses a price larger than the catalog can store', () => {
    expect(refusal(form({ photos: [photo({ price: '21474836.48' })] }))).toBe(
      "Photo 1's price can be at most $21,474,836.47.",
    );
    expect(onboardRequest(form({ photos: [photo({ price: '21474836.47' })] }))).toMatchObject({ ok: true });
  });

  it('takes stock as a whole number or nothing', () => {
    const message = "Photo 1's stock must be a whole number. Leave it blank if you don't count stock.";
    for (const stock of ['1.5', '-1', 'ten', '2147483648']) {
      expect(refusal(form({ photos: [photo({ stock })] })), stock).toBe(message);
    }
    expect(onboardRequest(form({ photos: [photo({ stock: ' 0 ' })] }))).toMatchObject({ ok: true, body: { images: [{ stock: 0 }] } });
    const blank = onboardRequest(form({ photos: [photo({ stock: '  ' })] }));
    expect(blank.ok && blank.body.images?.[0]).not.toHaveProperty('stock');
  });

  it('refuses more photos than one onboarding can list', () => {
    const photos = Array.from({ length: MAX_PHOTOS + 1 }, () => photo());
    expect(refusal(form({ photos }))).toBe(`Add at most ${MAX_PHOTOS} photos at a time.`);
  });

  it('refuses a photo over the size limit, and photos over the total limit', () => {
    const big = 'A'.repeat(PHOTO_BASE64_MAX + 4);
    expect(refusal(form({ photos: [photo(), photo({ base64: big })] }))).toBe(
      `Photo 2 is larger than ${PHOTO_MB} MB even after resizing. Use a smaller photo.`,
    );
    const quarter = 'A'.repeat(PHOTOS_BASE64_MAX / 4);
    expect(onboardRequest(form({ photos: [1, 2, 3, 4].map(() => photo({ base64: quarter })) }))).toMatchObject({ ok: true });
    const over = [1, 2, 3, 4, 5].map(() => photo({ base64: quarter }));
    expect(refusal(form({ photos: over }))).toBe(
      `Your photos come to more than ${PHOTOS_MB} MB together. Remove some and try again.`,
    );
  });
});

describe('csvSizeProblem', () => {
  it('accepts a CSV file up to 1 MiB', () => {
    expect(csvSizeProblem('ravi-spices.csv', 0)).toBeNull();
    expect(csvSizeProblem('ravi-spices.csv', CSV_MAX_BYTES)).toBeNull();
  });

  it('refuses a larger one by name, giving the limit', () => {
    expect(csvSizeProblem('everything.csv', CSV_MAX_BYTES + 1)).toBe(
      'everything.csv is larger than 1 MB, the most a catalog CSV can be.',
    );
  });
});

describe('limits', () => {
  it("match the catalog builder's, so the form refuses what the server would", () => {
    expect(MAX_PHOTOS).toBe(builder.MAX_PHOTOS);
    expect(PHOTO_BASE64_MAX).toBe(builder.PHOTO_BASE64_MAX);
    expect(PHOTOS_BASE64_MAX).toBe(builder.PHOTOS_BASE64_MAX);
    expect(CSV_ROW_LIMIT).toBe(csv.ROW_LIMIT);
  });

  it('are given to sellers in MB', () => {
    expect(PHOTO_MB).toBe(3.75);
    expect(PHOTOS_MB).toBe(15);
    expect(CSV_MAX_BYTES).toBe(1024 * 1024);
    expect(CSV_MB).toBe(1);
  });
});
