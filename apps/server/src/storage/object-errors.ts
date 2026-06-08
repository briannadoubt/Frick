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

/**
 * Thrown by {@link ObjectStore} write paths (FR-37) when an app attempts to
 * write an object whose `(tenant_id, object_type, object_id)` row is already
 * owned by a *different* app. The `objects` primary key is
 * `(tenant_id, object_type, object_id)` (app_id is an additive column, FR-36),
 * so without this guard a second app's write would silently clobber the first
 * app's row — a cross-app data leak. Reads already filter by `app_id`, so this
 * closes the write side of the boundary. The HTTP layer maps this to a 409.
 */
export class FrickCrossAppAccessError extends Error {
  readonly code = "storage.crossAppDenied" as const;
  readonly reason = "appMismatch" as const;
  readonly requestedAppId: string;
  readonly ownerAppId: string;
  readonly tenantId: string;
  readonly objectType: string;
  readonly objectId: string;

  constructor(args: {
    requestedAppId: string;
    ownerAppId: string;
    tenantId: string;
    objectType: string;
    objectId: string;
  }) {
    super(
      `Cross-app access denied on ${args.objectType}/${args.objectId}: app '${args.requestedAppId}' may not write a row owned by app '${args.ownerAppId}'`,
    );
    this.name = "FrickCrossAppAccessError";
    this.requestedAppId = args.requestedAppId;
    this.ownerAppId = args.ownerAppId;
    this.tenantId = args.tenantId;
    this.objectType = args.objectType;
    this.objectId = args.objectId;
  }
}
