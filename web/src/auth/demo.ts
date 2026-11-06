// The seed creates fan1@taquilla.test to fan1000@taquilla.test (FR-SEAT-4).
export const DEMO_FANS = 1_000;

// A random seeded fan, so two people trying the demo at once are almost never the same fan.
// `random` returns a number in [0, 1), as Math.random does.
export function demoFanEmail(random: () => number = Math.random): string {
  return `fan${1 + Math.floor(random() * DEMO_FANS)}@taquilla.test`;
}
