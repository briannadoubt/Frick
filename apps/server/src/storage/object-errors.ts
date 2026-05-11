/**
 * Thrown by {@link ObjectStore.upsert} when an object with
 * `mergePolicy: "versionPrecondition"` is written with a stale or missing
 * `expectedVersion`. The HTTP layer maps this to a 409 response with a
 * {@link FrickErrorEnvelope} `code: "storage.conflict"`.
 */
export class FrickObjectVersionConflictError extends Error {
  readonly code = "storage.conflict" as const;
  readonly tenantId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly expectedVersion: number | undefined;
  readonly actualVersion: number;

  constructor(args: {
    tenantId: string;
    objectType: string;
    objectId: string;
    expectedVersion: number | undefined;
    actualVersion: number;
  }) {
    super(
      `Version conflict on ${args.objectType}/${args.objectId}: expected ${
        args.expectedVersion === undefined ? "create" : args.expectedVersion
      }, actual ${args.actualVersion}`,
    );
    this.name = "FrickObjectVersionConflictError";
    this.tenantId = args.tenantId;
    this.objectType = args.objectType;
    this.objectId = args.objectId;
    this.expectedVersion = args.expectedVersion;
    this.actualVersion = args.actualVersion;
  }
}
