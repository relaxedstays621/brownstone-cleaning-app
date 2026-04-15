export const PROPERTIES = [
  "4006 - Suncadia Unit",
  "4008 - Suncadia Unit",
  "4006 & 4008 - Suncadia Unit",
  "5036 - Suncadia Unit",
  "2068 - Suncadia Unit",
  "Evergreen Getaway",
  "4070 - Suncadia Unit",
  "3022 - Suncadia Unit",
  "3023 - Suncadia Unit",
  "2038 - Suncadia Unit",
  "5058 - Suncadia Unit",
  "3033 - Suncadia Unit",
  "4038 - Suncadia Unit",
  "6052 - Suncadia Unit",
  "5040 - Suncadia Unit",
] as const;

export type Property = (typeof PROPERTIES)[number];
