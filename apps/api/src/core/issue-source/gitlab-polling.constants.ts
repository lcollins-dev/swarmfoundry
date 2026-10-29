/**
 * GitLab keeps `updated_at` for a label or assignee edit within about 60s of the issue's last update: on CE 19.4.1, edits
 * 3s, 6s and 30s after a bump kept it and one 63s after moved it. An issue read sooner than this after its `updated_at`
 * is read again on each poll. The 30s margin covers label events written after the labels, the `Date` header's whole
 * seconds and clock skew.
 */
export const SILENT_EDIT_WINDOW_MS = 90_000;

/**
 * Covers GitLab writes that commit out of `updated_at` order. Must exceed `SILENT_EDIT_WINDOW_MS`, so the listing keeps
 * returning an unsettled issue after newer changes move the watermark.
 */
export const WATERMARK_OVERLAP_MS = SILENT_EDIT_WINDOW_MS + 30_000;
