/**
 * Controlled vocabularies, as `as const` tuples.
 *
 * The single source of truth for every closed set of values that crosses a
 * boundary — Convex validators (`literalUnion` in convex/lib/validators.ts),
 * UI labels, and the Python pipeline, which mirrors these tuples by hand in
 * `camsocs_pipeline` (see the note on each). No server imports here, so the
 * client bundle and `bun test` can both use it. Pattern from salo-ba
 * lib/research/vocab.ts and Bundestracker.
 *
 * Domain vocabularies (verification statuses, entity kinds, …) belong here too
 * once docs/data-model.md fixes them; only the pipeline-run ones exist so far.
 */

/**
 * The state of one pipeline run (`harvestRuns.status`).
 *
 *  - `running`  — `runs.start` was called and `runs.finish` was not (yet). A run
 *                 that stays here crashed or was killed; it is evidence, not noise.
 *  - `success`  — every requested stage finished without error.
 *  - `partial`  — at least one stage failed and at least one succeeded.
 *  - `failed`   — every stage failed, or the run reported a run-level error.
 *
 * Mirrored in pipeline/src/camsocs_pipeline/pipeline/report.py (`RUN_STATUSES`).
 */
export const HARVEST_RUN_STATUSES = ["running", "success", "partial", "failed"] as const
export type HarvestRunStatus = (typeof HARVEST_RUN_STATUSES)[number]

/**
 * The outcome of one stage within a run.
 *
 *  - `ok`      — the stage ran to completion (possibly with nothing to do).
 *  - `failed`  — the stage raised; its partial counts are still reported.
 *  - `not_run` — the stage was requested but skipped because a stage it
 *                depends on failed.
 *
 * Mirrored in pipeline/src/camsocs_pipeline/pipeline/report.py (`STAGE_STATUSES`).
 */
export const HARVEST_STAGE_STATUSES = ["ok", "failed", "not_run"] as const
export type HarvestStageStatus = (typeof HARVEST_STAGE_STATUSES)[number]
