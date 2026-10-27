/** Metadata enumeration and content reads have separate, fixed budgets. */
export const SOURCE_LIMITS = {
  inventory_entries: 16_384,
  git_listing_bytes: 2 * 1024 * 1024,
  source_files: 2_048,
  file_bytes: 1024 * 1024,
  total_bytes: 16 * 1024 * 1024,
  duration_ms: 1_000,
} as const;
