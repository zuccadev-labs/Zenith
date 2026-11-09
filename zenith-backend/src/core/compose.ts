/**
 * @module @zenith/core/compose
 *
 * Trait composition for Zenith on top of barrits.
 *
 * barrits orders creation by `requires` (trait names) and only checks `consumes` once everything is
 * built. A trait that reads a capability while it is being created therefore depends on whatever
 * alphabetical order the names happen to have. `composeZenith` derives `requires` from capabilities
 * instead, so every provider is created before its consumers:
 *
 * - `consumes`: capabilities the trait cannot work without. Composition fails if one is missing.
 * - tag `uses:<capability>`: optional capabilities (feature-flagged traits). Ordered if present,
 *   `undefined` if not — the trait must check before using them.
 *
 * Traits read capabilities from `deps.traits`, the live composed object.
 */
import { composeTraitDescriptors, createTraitDescriptor } from "@zuccadev-labs/barrits";

type Descriptor = {
  name: string;
  summary?: string;
  requires: readonly string[];
  conflicts: readonly string[];
  state: readonly string[];
  consumes: readonly string[];
  provides: readonly string[];
  tags: readonly string[];
  runtimes: readonly string[];
  create: (deps: any) => Record<string, unknown>;
};

/** Optional capabilities a descriptor declares with `uses:<capability>` tags. */
export const usesOf = (d: { tags?: readonly string[] }): string[] =>
  (d.tags ?? []).filter((t) => t.startsWith("uses:")).map((t) => t.slice(5));

/** Who provides each capability; a capability provided twice is a composition error. */
export function providerMap(descriptors: readonly Descriptor[]): Map<string, string> {
  const by = new Map<string, string>();
  for (const d of descriptors) {
    for (const cap of d.provides) {
      const prev = by.get(cap);
      if (prev && prev !== d.name) {
        throw new Error(`Capability "${cap}" is provided by both "${prev}" and "${d.name}".`);
      }
      by.set(cap, d.name);
    }
  }
  return by;
}

/** Composes `descriptors` with creation order derived from `consumes` and `uses:` tags. */
export function composeZenith(descriptors: readonly unknown[]) {
  const list = descriptors as readonly Descriptor[];
  const provider = providerMap(list);
  const ordered = list.map((d) => {
    const need = [...d.consumes, ...usesOf(d)];
    const requires = new Set(d.requires);
    for (const cap of need) {
      const p = provider.get(cap);
      if (p && p !== d.name) requires.add(p);
    }
    return createTraitDescriptor({
      name: d.name,
      summary: d.summary,
      requires: [...requires],
      conflicts: [...d.conflicts],
      state: [...d.state],
      consumes: [...d.consumes],
      provides: [...d.provides],
      tags: [...d.tags],
      runtimes: [...d.runtimes],
      create: d.create,
    } as any);
  });
  return composeTraitDescriptors(ordered as any);
}
