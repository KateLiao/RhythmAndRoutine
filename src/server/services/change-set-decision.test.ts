import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChangeSetStatus } from "@/generated/prisma/enums";
import { isIdempotentChangeSetRejection } from "@/server/services/change-sets";

describe("ChangeSet decision convergence", () => {
  it("treats a repeated rejection as idempotent success", () => {
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.REJECTED, false), true);
  });

  it("does not treat approval or other terminal states as an idempotent rejection", () => {
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.REJECTED, true), false);
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.APPLIED, false), false);
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.AWAITING_CONFIRMATION, false), false);
  });
});
