// The tour plate's data contract (src/model/tour.ts). The shapes live in src/model/model.ts, next to the
// model they are part of (`model.tours`); this module only re-exports them for callers that want the
// tour types alone.
export type { BuiltTour, BuiltStep, BuiltCode, BuiltTiming, MCode } from './model';
