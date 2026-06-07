import { composeTraits, createInitialState } from "@zuccadev-labs/barrits";
import { Zenith } from "@zuccadev-labs/zenith";

// ─── Frontend Barrits Traits ──────────────────────────────────────────────

/**
 * Trait that encapsulates domain logic for Form Submission.
 * It provides a method that the React UI can call, keeping the UI dumb.
 */
function FormsTrait() {
  return {
    methods: {
      async createForm(title: string, description: string): Promise<string> {
        if (title.length < 3) throw new Error("Title too short.");
        const res = await Zenith.Cloud.run("createForm", { title, description });
        return res.objectId || res._id;
      },
      async getForms(): Promise<any[]> {
        return await Zenith.Cloud.run("getForms", {});
      },
      async updateForm(objectId: string, title: string, description: string): Promise<void> {
        await Zenith.Cloud.run("updateForm", { objectId, title, description });
      },
      async deleteForm(objectId: string): Promise<void> {
        await Zenith.Cloud.run("deleteForm", { objectId });
      }
    }
  };
}

/**
 * Trait that handles formatting or string manipulation for the UI.
 */
function FormattingTrait() {
  return {
    methods: {
      formatAddress(address: string): string {
        if (!address) return "";
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
      }
    }
  };
}

// ─── Compose Engine ───────────────────────────────────────────────────────

/**
 * We use Barrits to compose our frontend Domain Engine.
 * This ensures the UI layer only depends on the Engine methods, 
 * decoupling React from direct Zenith SDK calls in complex domains.
 */
export const FrontendEngine = composeTraits([
  FormsTrait(),
  FormattingTrait(),
]);

// Initialize the static state
FrontendEngine.__state = createInitialState(FrontendEngine);
