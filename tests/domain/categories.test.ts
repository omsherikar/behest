import { expect, it } from 'vitest';
import { CATEGORIES, categoryLabel } from '@/lib/domain/categories';

it('shows a one-word category as it is', () => expect(categoryLabel('groceries')).toBe('groceries'));
it('shows underscores as spaces', () => {
  expect(categoryLabel('personal_care')).toBe('personal care');
  expect(categoryLabel('gift_cards')).toBe('gift cards');
});
it('gives every category a label of lower-case words', () =>
  CATEGORIES.forEach((c) => expect(categoryLabel(c)).toMatch(/^[a-z]+( [a-z]+)*$/)));
