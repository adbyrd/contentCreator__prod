/**
 * [ FILE NAME : project.web.js : v2.8.0 ]
 *
 * Service: Project Service
 * Path: /backend/services/project.web.js
 * Version: [ PROJECT SERVICE : v2.8.0 ]
 *
 * Changelog v2.7.0 → v2.8.0
 * ─────────────────────────────────────────────────────────────────────────────
 * [FIX-07] getAuthenticatedMember() — Role.name type error
 *
 *   ERROR:  Property 'name' does not exist on type 'Role'.
 *
 *   ROOT CAUSE:
 *     The Wix IDE TypeScript definition for the Role type returned by
 *     getRoles() does not declare 'name' in its type stub, even though the
 *     Wix documentation explicitly states that the admin role object has
 *     name === 'Admin' at runtime (see getRoles() reference table). This is
 *     a typedef gap in the Wix IDE, not a runtime API change.
 *
 *   FIX:
 *     Access the name property via bracket notation (r['name']) to bypass
 *     the TypeScript stub check while preserving the runtime behaviour.
 *     Alternatively, cast each role to a plain object: (r as any).name.
 *     Bracket notation is used here as it requires no cast keyword and
 *     remains readable.
 *
 * [FIX-08] getMyProjects() — WixDataQueryResult.cursors type error
 *
 *   ERROR:  Property 'cursors' does not exist on type 'WixDataQueryResult'.
 *
 *   ROOT CAUSE:
 *     WixDataQueryResult does not have a 'cursors' property. Wix Data
 *     pagination is page-based, not cursor-based. The correct properties are:
 *       results.hasNext()  — boolean, true if more pages exist
 *       results.next()     — returns the next WixDataQueryResult page
 *       results.currentPage — zero-based index of the current page
 *       results.totalPages  — total number of pages
 *     There is no opaque cursor string to pass between calls.
 *
 *   FIX:
 *     Replaced cursor-based approach with skip()-based offset pagination.
 *     The frontend passes a 'cursor' value which is now treated as a
 *     numeric page offset string (e.g. "25", "50"). The backend converts it
 *     to an integer skip value: skip = parseInt(cursor) || 0.
 *
 *     nextCursor returned to the frontend is:
 *       - A string representation of the next page's skip offset if more
 *         results exist (e.g. "25").
 *       - null if this is the last page.
 *
 *     This is a non-breaking change for the frontend (project-explorer.page.js)
 *     which treats nextCursor as an opaque string and passes it back
 *     unchanged. The only constraint is that the frontend must not interpret
 *     the cursor value itself — which it does not.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Changelog v2.6.0 → v2.7.0
 * ─────────────────────────────────────────────────────────────────────────────
 * [FIX-05] getAuthenticatedMember() — Member.roles type error resolved.
 *   Moved role check to separate currentMember.getRoles() call (parallel).
 * [FIX-06] getMyProjects() — skipTo type error resolved.
 *   (Superseded by FIX-08 in this version.)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Changelog v2.5.0 → v2.6.0
 * ─────────────────────────────────────────────────────────────────────────────
 * [BUG-01] updateProject() — Storyboard field preservation.
 *   wixData.update() replaces the full document. All storyboard system fields
 *   are now preserved from the existing record to prevent data wipe on edit.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Permissions, webMethod } from 'wix-web-module';
import wixData                    from 'wix-data';
import { currentMember }          from 'wix-members-backend';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const VERSION             = '[ PROJECT SERVICE : v2.8.0 ]';

const COLLECTION_PROJECTS = 'projects';
const COLLECTION_PROFILES = 'profiles';   // read-only reference — profile writes stay in profile.web.js
const DB_OPTIONS          = { suppressAuth: true };
const ROLE_ADMIN          = 'Admin';
const PROJECT_LIMIT       = 25;

// ─── INTERNAL HELPERS ─────────────────────────────────────────────────────────

/**
 * Resolves the currently authenticated member's ID and admin status.
 *
 * [FIX-05] v2.7.0 — Roles fetched via currentMember.getRoles() (parallel).
 * [FIX-07] v2.8.0 — Role.name accessed via bracket notation to satisfy the
 *   Wix IDE TypeScript stub, which does not declare 'name' on the Role type
 *   despite it being present at runtime per the Wix getRoles() docs.
 *
 * @returns {{ memberId: string|null, isAdmin: boolean }}
 */
async function getAuthenticatedMember() {
  try {
    // Parallel fetch — getRoles() returns Role[], getMember() returns Member.
    const [member, roles] = await Promise.all([
      currentMember.getMember({ fieldsets: ['PUBLIC'] }),
      currentMember.getRoles(),
    ]);

    if (!member) return { memberId: null, isAdmin: false };

    // [FIX-07] Bracket notation bypasses the incomplete Wix IDE type stub.
    // At runtime, admin role objects carry name === 'Admin' per Wix docs.
    const isAdmin = Array.isArray(roles)
      ? roles.some((r) => r['name'] === ROLE_ADMIN)
      : false;

    return { memberId: member._id, isAdmin };
  } catch (err) {
    console.error(`${VERSION} getAuthenticatedMember failure:`, err);
    return { memberId: null, isAdmin: false };
  }
}

// ─── CREATE PROJECT ───────────────────────────────────────────────────────────

/**
 * Creates a new project record owned by the authenticated member.
 *
 * The `owner` field is written alongside the Wix-native `_owner` for
 * backward compatibility with records created under v1.3.x. Once a data
 * migration consolidates all records to `_owner`, the `owner` mirror can
 * be removed from the insert payload (SC-07 long-term cleanup).
 *
 * @param {object} projectData
 * @returns {{ ok: boolean, data?: object, error?: object }}
 */
export const createProject = webMethod(Permissions.SiteMember, async (projectData) => {
  try {
    const { memberId } = await getAuthenticatedMember();
    if (!memberId) {
      console.warn(`${VERSION} createProject: Unauthenticated attempt.`);
      return { ok: false, error: { type: 'AUTH_REQUIRED', message: 'Authentication required.' } };
    }

    const payload = {
      title:              projectData.title,
      description:        projectData.description,
      companyName:        projectData.companyName,
      companyDescription: projectData.companyDescription,
      primaryCategory:    projectData.primaryCategory,
      customerType:       projectData.customerType,
      goal:               projectData.goal,
      offer:              projectData.offer,
      targetAudience:     projectData.targetAudience ?? projectData.target_audience ?? projectData.audience,
      misconception:      projectData.misconception,
      // SC-07: write both fields during the _owner transition window.
      owner: memberId,
    };

    const result = await wixData.insert(COLLECTION_PROJECTS, payload, DB_OPTIONS);
    console.log(`${VERSION} createProject: Created ${result._id} for member: ${memberId}`);
    return { ok: true, data: result };

  } catch (err) {
    console.error(`${VERSION} createProject failure:`, err);
    return { ok: false, error: { type: 'INTERNAL', message: err.message } };
  }
});

// ─── VERIFY PROJECT ACCESS ────────────────────────────────────────────────────

/**
 * Authorization gate for the Project Detail dynamic page.
 * Access is granted only to the project owner or a site admin.
 * Returns no project data on denial to prevent information leakage.
 *
 * @param {string} projectId
 * @returns {{ ok: boolean, authorized: boolean, data?: object, error?: object }}
 */
export const verifyProjectAccess = webMethod(Permissions.Anyone, async (projectId) => {
  try {
    if (!projectId) {
      console.warn(`${VERSION} verifyProjectAccess: Called without a projectId.`);
      return {
        ok: false, authorized: false,
        error: { type: 'MISSING_ID', message: 'Project ID is required.' },
      };
    }

    const { memberId, isAdmin } = await getAuthenticatedMember();
    if (!memberId) {
      console.warn(`${VERSION} verifyProjectAccess: Unauthenticated attempt. Project: ${projectId}`);
      return {
        ok: true, authorized: false,
        error: { type: 'AUTH_REQUIRED', message: 'Authentication required.' },
      };
    }

    const project = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
    if (!project) {
      console.warn(`${VERSION} verifyProjectAccess: Not found. ID: ${projectId}`);
      return {
        ok: false, authorized: false,
        error: { type: 'NOT_FOUND', message: 'Project not found.' },
      };
    }

    if (project._owner === memberId) {
      console.log(`${VERSION} verifyProjectAccess: GRANTED (owner). Member: ${memberId}`);
      return { ok: true, authorized: true, data: project };
    }

    if (isAdmin) {
      console.log(`${VERSION} verifyProjectAccess: GRANTED (admin). Member: ${memberId}`);
      return { ok: true, authorized: true, data: project };
    }

    console.warn(`${VERSION} verifyProjectAccess: DENIED. Member: ${memberId}`);
    return {
      ok: true, authorized: false,
      error: { type: 'FORBIDDEN', message: 'You do not have permission to view this project.' },
    };

  } catch (err) {
    console.error(`${VERSION} verifyProjectAccess failure:`, err);
    return { ok: false, authorized: false, error: { type: 'INTERNAL', message: err.message } };
  }
});

// ─── UPDATE PROJECT ───────────────────────────────────────────────────────────

/**
 * Updates an existing project record. Owner-only — admin read access does
 * not confer write access by design.
 *
 * [BUG-01] v2.6.0 — Storyboard field preservation.
 *   wixData.update() replaces the full document. The payload MUST include
 *   every field that should survive the write. Storyboard system fields are
 *   read from `existing` (already in scope from the ownership check) and
 *   forwarded unchanged. They are never sourced from the incoming projectData
 *   argument — those fields are owned exclusively by the storyboard pipeline.
 *
 * @param {string} projectId
 * @param {object} projectData
 * @returns {{ ok: boolean, data?: object, error?: object }}
 */
export const updateProject = webMethod(Permissions.SiteMember, async (projectId, projectData) => {
  try {
    if (!projectId) {
      console.warn(`${VERSION} updateProject: Called without a projectId.`);
      return { ok: false, error: { type: 'MISSING_ID', message: 'Project ID is required.' } };
    }

    const { memberId } = await getAuthenticatedMember();
    if (!memberId) {
      console.warn(`${VERSION} updateProject: Unauthorized attempt.`);
      return { ok: false, error: { type: 'AUTH_REQUIRED', message: 'Authentication required.' } };
    }

    const existing = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
    if (!existing) {
      console.error(`${VERSION} updateProject: Not found. ID: ${projectId}`);
      return { ok: false, error: { type: 'NOT_FOUND', message: 'Project not found.' } };
    }

    if (existing._owner !== memberId) {
      console.warn(`${VERSION} updateProject: Ownership mismatch. Member: ${memberId}`);
      return { ok: false, error: { type: 'FORBIDDEN', message: 'You do not have permission to edit this project.' } };
    }

    const updatePayload = {
      // ── Identity & ownership (never changed by user) ──────────────────────
      _id:                existing._id,
      _owner:             existing._owner,
      owner:              existing.owner,          // SC-07: preserve mirror field during transition

      // ── User-editable fields (sourced from modal form) ────────────────────
      title:              projectData.title,
      description:        projectData.description,
      companyName:        projectData.companyName,
      companyDescription: projectData.companyDescription,
      primaryCategory:    projectData.primaryCategory,
      customerType:       projectData.customerType,
      goal:               projectData.goal,
      offer:              projectData.offer,
      targetAudience:     projectData.targetAudience ?? projectData.target_audience,
      misconception:      projectData.misconception,

      // ── Storyboard system fields: PRESERVED from existing record ──────────
      // These fields are written exclusively by the storyboard pipeline
      // (generateStoryboard.web.js, cancelStoryboard, receiveFrames.web.js).
      // A user-facing form save must never overwrite them.
      // [BUG-01] Previously absent — caused full wipe on every project edit.
      storyboardStatus:     existing.storyboardStatus     ?? null,
      storyboardStartedAt:  existing.storyboardStartedAt  ?? null,
      storyboardFrameCount: existing.storyboardFrameCount ?? null,
      completedAt:          existing.completedAt          ?? null,
      cancelledAt:          existing.cancelledAt          ?? null,
      firstFrameImage:      existing.firstFrameImage      ?? null,
    };

    const result = await wixData.update(COLLECTION_PROJECTS, updatePayload, DB_OPTIONS);
    console.log(`${VERSION} updateProject: Updated ${result._id} by member: ${memberId}`);
    return { ok: true, data: result };

  } catch (err) {
    console.error(`${VERSION} updateProject failure:`, err);
    return { ok: false, error: { type: 'INTERNAL', message: err.message } };
  }
});

// ─── GET USER PROJECT COUNT ───────────────────────────────────────────────────

/**
 * Returns the total project count for the authenticated member.
 * SC-07: queries on _owner (Wix-native indexed field), not the mirror field.
 *
 * @returns {{ ok: boolean, count: number, error?: object }}
 */
export const getUserProjectCount = webMethod(Permissions.Anyone, async () => {
  try {
    const { memberId } = await getAuthenticatedMember();
    if (!memberId) return { ok: true, count: 0 };

    const count = await wixData
      .query(COLLECTION_PROJECTS)
      .eq('_owner', memberId)
      .count(DB_OPTIONS);

    console.log(`${VERSION} getUserProjectCount: ${count} projects for member: ${memberId}`);
    return { ok: true, count };

  } catch (err) {
    console.error(`${VERSION} getUserProjectCount failure:`, err);
    return { ok: false, count: 0, error: { type: 'INTERNAL', message: err.message } };
  }
});

// ─── GET MY PROJECTS ──────────────────────────────────────────────────────────

/**
 * Returns a paginated list of projects owned by the authenticated member.
 *
 * SC-02: Enforces PROJECT_LIMIT (25) at the data layer.
 * SC-07: Queries on _owner (Wix-native indexed field).
 *
 * [FIX-08] v2.8.0 — Pagination redesign.
 *   WixDataQueryResult has no 'cursors' property. Wix Data pagination uses
 *   page-based navigation (hasNext() / next()) or skip()-based offsets.
 *   This implementation uses skip()-based offsets, expressed as an opaque
 *   string cursor for the frontend ("0", "25", "50", ...).
 *
 *   Cursor contract (backend-internal, frontend treats as opaque string):
 *     cursor === null   → start from the beginning (skip 0)
 *     cursor === "N"    → skip N items (N is a multiple of PROJECT_LIMIT)
 *
 *   nextCursor returned:
 *     string "N"   → next page starts at offset N; more results exist
 *     null         → this is the last page
 *
 *   This is a non-breaking change for the frontend. project-explorer.page.js
 *   passes the cursor back unchanged and only checks for null to hide the
 *   Load More button — both behaviours are preserved.
 *
 * @param {{ limit?: number, cursor?: string|null }} [options]
 * @returns {{ ok: boolean, data: array, nextCursor: string|null, error?: object }}
 */
export const getMyProjects = webMethod(Permissions.Anyone, async ({ limit = PROJECT_LIMIT, cursor = null } = {}) => {
  try {
    const { memberId } = await getAuthenticatedMember();
    if (!memberId) return { ok: true, data: [], nextCursor: null };

    const safeLimit  = Math.min(limit, PROJECT_LIMIT);

    // [FIX-08] Convert opaque cursor string to a numeric skip offset.
    // parseInt returns NaN for null/undefined/non-numeric strings; || 0
    // collapses those to zero (first page).
    const skipOffset = parseInt(cursor, 10) || 0;

    const results = await wixData
      .query(COLLECTION_PROJECTS)
      .eq('_owner', memberId)
      .descending('_createdDate')
      .limit(safeLimit)
      .skip(skipOffset)
      .find(DB_OPTIONS);

    // [FIX-08] Use hasNext() (boolean method) to determine if another page
    // exists. If yes, the next cursor is the skip offset for that page.
    const nextCursor = results.hasNext()
      ? String(skipOffset + safeLimit)
      : null;

    console.log(`${VERSION} getMyProjects: ${results.items.length} projects for member: ${memberId}. hasMore: ${!!nextCursor}`);
    return { ok: true, data: results.items, nextCursor };

  } catch (err) {
    console.error(`${VERSION} getMyProjects failure:`, err);
    return { ok: false, data: [], nextCursor: null, error: { type: 'INTERNAL', message: err.message } };
  }
});

// ─── Debug exports ────────────────────────────────────────────────────────────

export function debugProjectService() {
  console.log(`${VERSION} Config: PROJECT_LIMIT=${PROJECT_LIMIT}`);
  return { debug: true, version: VERSION, timestamp: new Date().toISOString() };
}