import type { FrickSchema } from "@fricken/protocol";

// RangerCRM data model. Mirrors the legacy CoreData entities from
// RangerCoreData14.xcdatamodeld. Field names use camelCase per Frick
// conventions (the Swift adapter classes translate to the legacy snake-ish
// names like `accountFollowUpBool`).
//
// Stable ids matter — never reuse one. Each object's primary id is the
// Frick object id (a UUID string), which the iOS client seeds from the
// legacy CoreData accountID/contactID/etc. so the migration is idempotent.
//
// All five core objects are scoped to the signed-in user — the server's
// per-tenant scoping (configured at deploy time) plus a `userId` filter
// on each query keeps one person's accounts private to them.
export const schema: FrickSchema = {
  name: "rangercrm",
  schemaId: "rangercrm",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "rangercrm-0.1.0",
  objects: [
    {
      id: 1,
      name: "Account",
      fields: [
        { id: 1, name: "ownerUserId", kind: "string", required: true },
        { id: 2, name: "accountName", kind: "string", required: true },
        { id: 3, name: "accountPhoneOne", kind: "string", required: false },
        { id: 4, name: "accountPhoneTwo", kind: "string", required: false },
        { id: 5, name: "accountEmailAddressOne", kind: "string", required: false },
        { id: 6, name: "accountEmailAddressTwo", kind: "string", required: false },
        { id: 7, name: "accountWebsite", kind: "string", required: false },
        { id: 8, name: "accountStreetAddress", kind: "string", required: false },
        { id: 9, name: "accountCity", kind: "string", required: false },
        { id: 10, name: "accountProvinceState", kind: "string", required: false },
        { id: 11, name: "accountPostalZip", kind: "string", required: false },
        { id: 12, name: "accountUSStreetAddress", kind: "string", required: false },
        { id: 13, name: "accountUSCity", kind: "string", required: false },
        { id: 14, name: "accountUSState", kind: "string", required: false },
        { id: 15, name: "accountUSZipCode", kind: "string", required: false },
        { id: 16, name: "accountCountry", kind: "string", required: false },
        { id: 17, name: "accountManager", kind: "string", required: false },
        { id: 18, name: "accountCustomerType", kind: "string", required: false },
        { id: 19, name: "accountMarketType", kind: "string", required: false },
        { id: 20, name: "accountGeoLocation", kind: "bool", required: true },
        { id: 21, name: "accountGeoLocationEnter", kind: "bool", required: true },
        { id: 22, name: "accountGeoLocationExit", kind: "bool", required: true },
        { id: 23, name: "accountGeoLocationNote", kind: "string", required: false },
        // Lat/lng stored as strings to keep wire-stable across float
        // representations; the Swift side decodes back to Double.
        { id: 24, name: "accountCoordLatitude", kind: "string", required: false },
        { id: 25, name: "accountCoordLongitude", kind: "string", required: false },
        { id: 26, name: "accountIsFocused", kind: "bool", required: true },
        { id: 27, name: "accountDateAdded", kind: "timestamp", required: false },
        { id: 28, name: "accountDateFollowUp", kind: "timestamp", required: false },
        { id: 29, name: "accountFollowUpBool", kind: "bool", required: true },
        { id: 30, name: "accountFollowUpNote", kind: "string", required: false },
      ],
      indexes: [
        { id: 1, name: "byOwner", fields: ["ownerUserId"] },
        { id: 2, name: "byOwnerName", fields: ["ownerUserId", "accountName"] },
        { id: 3, name: "byOwnerFollowUp", fields: ["ownerUserId", "accountFollowUpBool"] },
      ],
      mergePolicy: "versionPrecondition",
    },
    {
      id: 2,
      name: "Contact",
      fields: [
        { id: 1, name: "ownerUserId", kind: "string", required: true },
        { id: 2, name: "accountId", kind: "ref", ref: "Account", required: false },
        { id: 3, name: "contactFirstName", kind: "string", required: false },
        { id: 4, name: "contactLastName", kind: "string", required: false },
        { id: 5, name: "contactEmailAddressOne", kind: "string", required: false },
        { id: 6, name: "contactEmailAddressTwo", kind: "string", required: false },
        { id: 7, name: "contactCellPhone", kind: "string", required: false },
        { id: 8, name: "contactOfficePhone", kind: "string", required: false },
        { id: 9, name: "contactAccountName", kind: "string", required: false },
        { id: 10, name: "contactAccManager", kind: "string", required: false },
        { id: 11, name: "contactPosition", kind: "string", required: false },
        { id: 12, name: "contactDepartment", kind: "string", required: false },
        { id: 13, name: "contactStreetAddress", kind: "string", required: false },
        { id: 14, name: "contactCity", kind: "string", required: false },
        { id: 15, name: "contactProvinceState", kind: "string", required: false },
        { id: 16, name: "contactPostalZip", kind: "string", required: false },
        { id: 17, name: "contactCountry", kind: "string", required: false },
        { id: 18, name: "contactDateAdded", kind: "timestamp", required: false },
        { id: 19, name: "contactDateFollowUp", kind: "timestamp", required: false },
        { id: 20, name: "contactFollowUpBool", kind: "bool", required: true },
        { id: 21, name: "contactFollowUpNote", kind: "string", required: false },
      ],
      indexes: [
        { id: 1, name: "byOwner", fields: ["ownerUserId"] },
        { id: 2, name: "byAccount", fields: ["accountId"] },
      ],
      mergePolicy: "versionPrecondition",
    },
    {
      id: 3,
      name: "Quote",
      fields: [
        { id: 1, name: "ownerUserId", kind: "string", required: true },
        { id: 2, name: "accountId", kind: "ref", ref: "Account", required: false },
        { id: 3, name: "quoteName", kind: "string", required: false },
        // Currency stored as integer cents on the wire to avoid float
        // drift, but exposed to Swift as Double for chart math compat.
        { id: 4, name: "quoteValueCents", kind: "int", required: true },
        { id: 5, name: "quoteNumber", kind: "string", required: false },
        { id: 6, name: "quoteSupplier", kind: "string", required: false },
        { id: 7, name: "quoteAccountQuoted", kind: "string", required: false },
        { id: 8, name: "quoteAccountCity", kind: "string", required: false },
        { id: 9, name: "quoteAccountFirstName", kind: "string", required: false },
        { id: 10, name: "quoteAccountLastName", kind: "string", required: false },
        { id: 11, name: "quoteContractorCompanyName", kind: "string", required: false },
        { id: 12, name: "quoteContractorFirstName", kind: "string", required: false },
        { id: 13, name: "quoteContractorLastName", kind: "string", required: false },
        { id: 14, name: "quoteContractorPhoneNumber", kind: "string", required: false },
        { id: 15, name: "quoteContractorEmail", kind: "string", required: false },
        { id: 16, name: "quoteSpecifierCompanyName", kind: "string", required: false },
        { id: 17, name: "quoteSpecifierFirstName", kind: "string", required: false },
        { id: 18, name: "quoteSpecifierLastName", kind: "string", required: false },
        { id: 19, name: "quoteSpecifierPhoneNumber", kind: "string", required: false },
        { id: 20, name: "quoteSpecifierEmail", kind: "string", required: false },
        { id: 21, name: "quoteDateEntered", kind: "timestamp", required: false },
        { id: 22, name: "quoteDateFollowUp", kind: "timestamp", required: false },
        { id: 23, name: "quoteFollowUpBool", kind: "bool", required: true },
        { id: 24, name: "quoteFollowUpNote", kind: "string", required: false },
        { id: 25, name: "quoteAlsoQuotedOtherAccount", kind: "string", required: false },
        { id: 26, name: "quoteAlsoQuotedOtherAccAmnt", kind: "string", required: false },
        {
          id: 27,
          name: "quoteStatus",
          kind: "enum",
          enumValues: ["open", "closed", "won", "lost"],
          required: true,
        },
      ],
      indexes: [
        { id: 1, name: "byOwner", fields: ["ownerUserId"] },
        { id: 2, name: "byAccount", fields: ["accountId"] },
        { id: 3, name: "byOwnerStatus", fields: ["ownerUserId", "quoteStatus"] },
      ],
      mergePolicy: "versionPrecondition",
    },
    {
      id: 4,
      name: "Note",
      fields: [
        { id: 1, name: "ownerUserId", kind: "string", required: true },
        { id: 2, name: "accountId", kind: "ref", ref: "Account", required: false },
        { id: 3, name: "noteTitle", kind: "string", required: false },
        { id: 4, name: "noteBodyText", kind: "string", required: false },
        { id: 5, name: "noteDateEntered", kind: "timestamp", required: false },
        { id: 6, name: "noteDateFollowUp", kind: "timestamp", required: false },
        { id: 7, name: "noteFollowUpBool", kind: "bool", required: true },
        { id: 8, name: "noteFollowUpNote", kind: "string", required: false },
      ],
      indexes: [
        { id: 1, name: "byOwner", fields: ["ownerUserId"] },
        { id: 2, name: "byAccount", fields: ["accountId"] },
      ],
      mergePolicy: "versionPrecondition",
    },
    {
      // App-specific profile bolted onto Frick's built-in identity. Frick
      // owns email + handle + passwordHash; we only persist the legacy
      // RangerCRM-isms (repType selection, security question for password
      // reset, region default, two-factor preference). Keyed by Frick
      // userId so there's exactly one UserProfile per user.
      id: 5,
      name: "UserProfile",
      fields: [
        { id: 1, name: "userId", kind: "string", required: true },
        { id: 2, name: "loginType", kind: "string", required: false },
        { id: 3, name: "isRoot", kind: "bool", required: true },
        { id: 4, name: "dateCreation", kind: "timestamp", required: false },
        { id: 5, name: "dateLastLogin", kind: "timestamp", required: false },
        { id: 6, name: "rememberMe", kind: "bool", required: true },
        { id: 7, name: "securityQuestion", kind: "string", required: false },
        { id: 8, name: "securityAnswer", kind: "string", required: false },
        { id: 9, name: "twoFactorAuth", kind: "bool", required: true },
        { id: 10, name: "defaultCountry", kind: "string", required: false },
        { id: 11, name: "repType", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "byUser", fields: ["userId"] }],
      mergePolicy: "versionPrecondition",
    },
  ],
  streams: [],
  events: [],
  presences: [],
  signals: [],
  blobs: [],
  jobs: [],
  projections: [],
};
