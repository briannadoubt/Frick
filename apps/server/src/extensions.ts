export interface FrickExtensionRef {
  id: string;
}

export interface FrickExtensionRegistry {
  policies: FrickExtensionRef[];
  projections: FrickExtensionRef[];
  jobs: FrickExtensionRef[];
  blobProcessors: FrickExtensionRef[];
  searchAdapters: FrickExtensionRef[];
  notificationIntents: FrickExtensionRef[];
  observabilityHooks: FrickExtensionRef[];
}

export type FrickExtensionRegistryInput = Partial<FrickExtensionRegistry>;

export function createFrickExtensionRegistry(input: FrickExtensionRegistryInput = {}): FrickExtensionRegistry {
  return {
    policies: [...(input.policies ?? [])],
    projections: [...(input.projections ?? [])],
    jobs: [...(input.jobs ?? [])],
    blobProcessors: [...(input.blobProcessors ?? [])],
    searchAdapters: [...(input.searchAdapters ?? [])],
    notificationIntents: [...(input.notificationIntents ?? [])],
    observabilityHooks: [...(input.observabilityHooks ?? [])],
  };
}
