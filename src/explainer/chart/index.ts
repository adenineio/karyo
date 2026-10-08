// Explainer charts (docs/EXPLAINERS.md "Charts"): an SVG chart layer with no dependencies. A component hosts one
// with `data-k-chart="line|bars|donut|sparkline"` in its template; the plate renders it from the element's props.
export { niceDomain, ticks, tickStep, linear, bands, points, parseDate, timeTicks } from './scale';
export { formatNumber, formatValue, formatDate, formatDay, type FormatOpts, type NumberFormat } from './format';
export { frameOf, chartIssues, partProblem, partKinds, chartKindOf, seriesOf, seriesKey, CHART_KINDS, type ChartKind, type Frame, type ChartCtx, type Parts } from './data';
export { lerpFrame, birthFrame, mergeKeyed } from './tween';
export { renderChart, estimate, dodge, CHART_CSS, type Measure, type Hit, type Hover } from './render';
export { chartSummary, chartTable } from './a11y';
