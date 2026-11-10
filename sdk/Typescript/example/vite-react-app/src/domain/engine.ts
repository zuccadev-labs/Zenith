import { composeTraitDescriptors, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { Zenith } from "@zuccadev-labs/zenith";

/** A form as the createForm/getForms cloud functions return it. */
export interface Form {
  objectId: string;
  title: string;
  description?: string;
  [field: string]: unknown;
}

// ─── Frontend Barrits Traits ──────────────────────────────────────────────

/**
 * Trait that encapsulates domain logic for Form Submission.
 * It provides a method that the React UI can call, keeping the UI dumb.
 */
const FormsTrait = createTraitDescriptor({
  name: "Forms",
  provides: ["forms"],
  runtimes: ["browser"],
  create: () => ({
    forms: {
      async createForm(title: string, description: string): Promise<string> {
        if (title.length < 3) throw new Error("Title too short.");
        const res = await Zenith.Cloud.run("createForm", { title, description });
        return res.objectId || res._id;
      },
      async getForms(): Promise<Form[]> {
        return await Zenith.Cloud.run("getForms", {});
      },
      async updateForm(objectId: string, title: string, description: string): Promise<void> {
        await Zenith.Cloud.run("updateForm", { objectId, title, description });
      },
      async deleteForm(objectId: string): Promise<void> {
        await Zenith.Cloud.run("deleteForm", { objectId });
      }
    }
  }),
});

/**
 * Trait that handles formatting or string manipulation for the UI.
 */
const FormattingTrait = createTraitDescriptor({
  name: "Formatting",
  provides: ["formatting"],
  runtimes: ["browser"],
  create: () => ({
    formatting: {
      formatAddress(address: string): string {
        if (!address) return "";
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
      }
    }
  }),
});

// ─── Compose Engine ───────────────────────────────────────────────────────

/**
 * We use Barrits to compose our frontend Domain Engine.
 * This ensures the UI layer only depends on the Engine methods, 
 * decoupling React from direct Zenith SDK calls in complex domains.
 */
const composed = composeTraitDescriptors([FormsTrait, FormattingTrait]);

export const FrontendEngine = {
  ...composed.traits.forms,
  ...composed.traits.formatting,
} as {
  createForm(title: string, description: string): Promise<string>;
  getForms(): Promise<Form[]>;
  updateForm(objectId: string, title: string, description: string): Promise<void>;
  deleteForm(objectId: string): Promise<void>;
  formatAddress(address: string): string;
};
