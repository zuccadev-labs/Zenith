/**
 * ZenithFavoritesTags — SDK client for /zen/favorites and /zen/tags
 */
import type { Zenith } from "../core/Zenith.ts";

export interface ZenithFavorite  { objectId: string; user: any; targetClassName: string; targetId: string; position: number; createdAt: string; }
export interface ZenithTag       { objectId: string; name: string; color: string; icon?: string; description?: string; workspaceId?: string; createdAt: string; }
export interface ZenithTagAssign { objectId: string; tag: any; targetClassName: string; targetId: string; assignedBy?: any; createdAt: string; }

export class ZenithFavoritesTags {
  private readonly base: string;
  private readonly h: () => Record<string, string>;

  constructor(z: Zenith) {
    this.base = (z as any)._serverURL;
    this.h    = () => ({
      "content-type": "application/json",
      "x-parse-application-id": (z as any)._applicationId,
      "x-parse-session-token":  (z as any).User?.current()?.getSessionToken() ?? "",
    });
  }

  // ── Favorites ──────────────────────────────────────────────────────────────

  async listFavorites(): Promise<{ results: ZenithFavorite[] }> {
    return (await fetch(`${this.base}/zen/favorites`, { headers: this.h() })).json();
  }

  /** Toggle: agrega si no existe, quita si existe */
  async toggleFavorite(targetClassName: string, targetId: string): Promise<{ added: boolean; favorite?: ZenithFavorite }> {
    return (await fetch(`${this.base}/zen/favorites/toggle`, {
      method: "POST", headers: this.h(),
      body: JSON.stringify({ targetClassName, targetId }),
    })).json();
  }

  /** Drag & drop — enviar array de objectIds en el nuevo orden */
  async reorderFavorites(ids: string[]): Promise<{ success: boolean }> {
    return (await fetch(`${this.base}/zen/favorites/reorder`, {
      method: "PUT", headers: this.h(), body: JSON.stringify({ ids }),
    })).json();
  }

  // ── Tags CRUD ──────────────────────────────────────────────────────────────

  async listTags(workspaceId?: string): Promise<{ results: ZenithTag[] }> {
    const q = workspaceId ? `?workspaceId=${workspaceId}` : "";
    return (await fetch(`${this.base}/zen/tags${q}`, { headers: this.h() })).json();
  }

  async createTag(data: { name: string; color?: string; icon?: string; description?: string; workspaceId?: string }): Promise<ZenithTag> {
    return (await fetch(`${this.base}/zen/tags`, { method: "POST", headers: this.h(), body: JSON.stringify(data) })).json();
  }

  async updateTag(objectId: string, data: Partial<ZenithTag>): Promise<ZenithTag> {
    return (await fetch(`${this.base}/zen/tags/${objectId}`, { method: "PUT", headers: this.h(), body: JSON.stringify(data) })).json();
  }

  async deleteTag(objectId: string): Promise<{ success: boolean; removedAssignments: number }> {
    return (await fetch(`${this.base}/zen/tags/${objectId}`, { method: "DELETE", headers: this.h() })).json();
  }

  // ── Tag Assignments ────────────────────────────────────────────────────────

  async assignTag(tagId: string, targetClassName: string, targetId: string): Promise<ZenithTagAssign> {
    return (await fetch(`${this.base}/zen/tags/${tagId}/assign`, {
      method: "POST", headers: this.h(), body: JSON.stringify({ targetClassName, targetId }),
    })).json();
  }

  async unassignTag(tagId: string, targetClassName: string, targetId: string): Promise<{ success: boolean }> {
    return (await fetch(`${this.base}/zen/tags/${tagId}/unassign`, {
      method: "POST", headers: this.h(), body: JSON.stringify({ targetClassName, targetId }),
    })).json();
  }

  async getTagsForRecord(targetClassName: string, targetId: string): Promise<{ results: ZenithTag[] }> {
    return (await fetch(`${this.base}/zen/tags/record/${targetClassName}/${targetId}`, { headers: this.h() })).json();
  }

  async getRecordsByTag(tagId: string): Promise<{ results: ZenithTagAssign[] }> {
    return (await fetch(`${this.base}/zen/tags/${tagId}/records`, { headers: this.h() })).json();
  }
}
