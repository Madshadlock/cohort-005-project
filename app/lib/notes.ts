import { z } from "zod";

export const MAX_NOTE_LENGTH = 2000;

// A Note body is plain text, trimmed, and refused (never truncated) when over
// the cap. Shared by the Lesson page form and the notes service so both
// enforce the same rule.
export const noteBodySchema = z
  .string()
  .trim()
  .min(1, "Write something before saving your note.")
  .max(
    MAX_NOTE_LENGTH,
    `A note must be ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters or fewer.`
  );
