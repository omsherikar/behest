'use client';

import { buttonClass } from '@/components/ui/button';
import { startTour } from './tour-store';

// Starts the guided demo from its first step. It sits in the home page hero, which is where the
// first step is, so it starts the tour in place.

export function StartTourButton() {
  return (
    <button type="button" onClick={startTour} className={buttonClass('primary', 'large')}>
      Take the guided demo · 3 min
    </button>
  );
}
