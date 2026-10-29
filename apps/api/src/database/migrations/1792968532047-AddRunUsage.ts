import { MigrationInterface, QueryRunner } from 'typeorm';

/** The runner's own failures around the agent: a plugin check or a transcript write. */
const RUNNER_FAILED = `("error" LIKE 'Claude''s plugins failed: %'
  OR "error" LIKE 'Claude exited without reporting system/init%'
  OR "error" LIKE 'Failed to store the transcript: %')`;

export class AddRunUsage1792968532047 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task"
        ADD "issueLabels" text[] NULL,
        ADD "issueAuthor" varchar(255) NULL,
        ADD "issueAssignees" text[] NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "task"
        DROP CONSTRAINT "CHK_task_kind",
        ADD CONSTRAINT "CHK_task_kind" CHECK (
          ("fireTime" IS NULL AND "cron" IS NULL
            AND num_nulls("projectId", "issueIid", "issueTitle", "issueUrl", "changeKind", "changeId", "changeDate") = 0
            AND num_nonnulls("mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl",
              "sourceBranch", "targetBranch") = 0)
          OR ("fireTime" IS NOT NULL AND "cron" IS NOT NULL
            AND num_nonnulls("projectId", "issueIid", "issueTitle", "issueUrl", "changeKind", "changeId", "changeDate",
              "changeActor", "issueLabels", "issueAuthor", "issueAssignees", "mergeRequestIid", "mergeRequestEvent",
              "mergeRequestTitle", "mergeRequestUrl", "sourceBranch", "targetBranch") = 0)
          OR (num_nulls("projectId", "mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl",
              "sourceBranch", "targetBranch") = 0
            AND num_nonnulls("fireTime", "cron", "changeKind", "changeId", "changeDate", "changeActor", "issueLabels",
              "issueAuthor", "issueAssignees") = 0
            AND num_nulls("issueIid", "issueTitle", "issueUrl") IN (0, 3))
        )
    `);

    await queryRunner.query(`
      ALTER TABLE "run"
        ADD "agentName" text NULL,
        ADD "agentModel" text NULL,
        ADD "agentAuth" varchar(16) NULL,
        ADD "endReason" varchar(16) NULL,
        ADD "turns" int4 NULL,
        ADD "inputTokens" int8 NULL,
        ADD "outputTokens" int8 NULL,
        ADD "cacheReadTokens" int8 NULL,
        ADD "cacheWriteTokens" int8 NULL,
        ADD "costUsd" numeric NULL
    `);

    // Only an agent's run has a container. A static step's `result` is a plain summary, never a `result` line.
    await queryRunner.query(`
      WITH "line" AS (
        SELECT "id", CASE WHEN pg_input_is_valid("result", 'jsonb') THEN "result"::jsonb END AS "json"
          FROM "run"
          WHERE "containerId" IS NOT NULL AND "result" IS NOT NULL
      ), "usage" AS (
        SELECT "id", "json", "json" -> 'usage' AS "tokens"
          FROM "line"
          WHERE jsonb_typeof("json") = 'object' AND "json" ->> 'type' = 'result'
      )
      UPDATE "run" SET
        "turns" = CASE WHEN jsonb_typeof("json" -> 'num_turns') = 'number'
          THEN ("json" ->> 'num_turns')::numeric::int4 END,
        "inputTokens" = CASE WHEN jsonb_typeof("tokens" -> 'input_tokens') = 'number'
          THEN ("tokens" ->> 'input_tokens')::numeric::int8 END,
        "outputTokens" = CASE WHEN jsonb_typeof("tokens" -> 'output_tokens') = 'number'
          THEN ("tokens" ->> 'output_tokens')::numeric::int8 END,
        "cacheReadTokens" = CASE WHEN jsonb_typeof("tokens" -> 'cache_read_input_tokens') = 'number'
          THEN ("tokens" ->> 'cache_read_input_tokens')::numeric::int8 END,
        "cacheWriteTokens" = CASE WHEN jsonb_typeof("tokens" -> 'cache_creation_input_tokens') = 'number'
          THEN ("tokens" ->> 'cache_creation_input_tokens')::numeric::int8 END,
        "costUsd" = CASE WHEN jsonb_typeof("json" -> 'total_cost_usd') = 'number'
          THEN ("json" ->> 'total_cost_usd')::numeric END
        FROM "usage"
        WHERE "run"."id" = "usage"."id"
    `);

    // The messages are the runner's and the engine's own, unchanged since each was written. A run with no container
    // and no static step's error was refused before its agent existed, which only the runner does.
    await queryRunner.query(`
      UPDATE "run" SET "endReason" = CASE
          WHEN "outcome" = 'succeeded' THEN 'success'
          WHEN "error" LIKE 'Timed out after %' THEN 'timeout'
          WHEN "deploymentFault" IS NOT NULL THEN 'runnerError'
          WHEN ${RUNNER_FAILED} THEN 'runnerError'
          WHEN "error" LIKE '% could not be judged%'
            OR "error" LIKE 'Failed to read the issue''s labels to judge the run: %'
            OR "error" LIKE '% is no longer in the config'
            OR "error" LIKE 'The config revision the task is pinned to, %' THEN 'runnerError'
          WHEN "error" LIKE 'The run ended without the issue carrying %' THEN 'error'
          WHEN "containerId" IS NULL
            AND "error" NOT SIMILAR TO '(steps|failureSteps)\\[[0-9]+\\] \\((relabel|comment|assign)\\) failed: %'
            THEN 'runnerError'
          ELSE 'error'
        END
        WHERE "outcome" IS NOT NULL
    `);

    // A report stored but not yet judged keeps the runner's view, which its judgement then keeps.
    await queryRunner.query(`
      UPDATE "run" SET "endReason" = CASE
          WHEN "error" LIKE 'Timed out after %' THEN 'timeout'
          WHEN ${RUNNER_FAILED} THEN 'runnerError'
        END
        WHERE "outcome" IS NULL AND "endDate" IS NOT NULL
    `);
  }

  public async down(): Promise<void> {
    // Not required
  }
}
