import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./bookmarks-and-notes.server";
import {
  approveRefundRequest,
  raiseRefundRequest,
} from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesLater(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];
let student: number;
let otherStudent: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  student = base.user.id;
  otherStudent = db
    .insert(schema.users)
    .values({ name: "Other", email: "other@example.com", role: UserRole.Student })
    .returning()
    .get().id;

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

describe("toggling a Bookmark", () => {
  it("bookmarks a Lesson with no Bookmark", () => {
    expect(toggleBookmark(db, student, lessonIds[0], NOW)).toBe(true);
    expect(isBookmarked(db, student, lessonIds[0])).toBe(true);
  });

  it("removes the Bookmark when toggled again", () => {
    toggleBookmark(db, student, lessonIds[0], NOW);

    expect(toggleBookmark(db, student, lessonIds[0], minutesLater(1))).toBe(
      false
    );
    expect(isBookmarked(db, student, lessonIds[0])).toBe(false);
  });

  it("never leaves two Bookmarks on the same Lesson", () => {
    toggleBookmark(db, student, lessonIds[0], NOW);
    toggleBookmark(db, student, lessonIds[0], minutesLater(1));
    toggleBookmark(db, student, lessonIds[0], minutesLater(2));

    expect(listBookmarks(db, student)).toHaveLength(1);
  });

  it("does not touch another Student's Bookmark", () => {
    toggleBookmark(db, otherStudent, lessonIds[0], NOW);

    expect(isBookmarked(db, student, lessonIds[0])).toBe(false);
    expect(toggleBookmark(db, student, lessonIds[0], NOW)).toBe(true);
    expect(isBookmarked(db, otherStudent, lessonIds[0])).toBe(true);
  });
});

describe("saving a Note", () => {
  it("creates a Note with the body trimmed", () => {
    const result = saveNote(db, student, lessonIds[0], "  Revisit closures  ", NOW);

    expect(result).toEqual({
      ok: true,
      note: { body: "Revisit closures", updatedAt: NOW.toISOString() },
    });
    expect(getNote(db, student, lessonIds[0])).toEqual({
      body: "Revisit closures",
      updatedAt: NOW.toISOString(),
    });
  });

  it("has no Note on a Lesson the Student has not written about", () => {
    expect(getNote(db, student, lessonIds[0])).toBeUndefined();
  });

  it("replaces the body and moves the last-edited time on a re-save", () => {
    saveNote(db, student, lessonIds[0], "First draft", NOW);
    const later = minutesLater(5);

    saveNote(db, student, lessonIds[0], "Second draft", later);

    expect(getNote(db, student, lessonIds[0])).toEqual({
      body: "Second draft",
      updatedAt: later.toISOString(),
    });
    expect(listNotes(db, student)).toHaveLength(1);
  });

  it("keeps the text exactly as typed, Markdown characters included", () => {
    saveNote(db, student, lessonIds[0], "# not a heading\n*not bold*", NOW);

    expect(getNote(db, student, lessonIds[0])?.body).toBe(
      "# not a heading\n*not bold*"
    );
  });

  it("accepts a Note of exactly 2,000 characters", () => {
    expect(saveNote(db, student, lessonIds[0], "a".repeat(2000), NOW).ok).toBe(
      true
    );
  });

  it("refuses a Note over 2,000 characters with a message", () => {
    expect(saveNote(db, student, lessonIds[0], "a".repeat(2001), NOW)).toEqual({
      ok: false,
      error: "A note must be 2,000 characters or fewer.",
    });
    expect(getNote(db, student, lessonIds[0])).toBeUndefined();
  });

  it("refuses an empty Note", () => {
    expect(saveNote(db, student, lessonIds[0], "   ", NOW).ok).toBe(false);
  });
});

describe("the Saved lists", () => {
  it("lists only the Student's own Bookmarks, newest first, with Lesson and Course", () => {
    toggleBookmark(db, student, lessonIds[0], NOW);
    toggleBookmark(db, student, lessonIds[2], minutesLater(2));
    toggleBookmark(db, student, lessonIds[1], minutesLater(1));
    toggleBookmark(db, otherStudent, lessonIds[0], minutesLater(3));

    expect(listBookmarks(db, student)).toEqual([
      expect.objectContaining({
        lessonId: lessonIds[2],
        lessonTitle: "Lesson 3",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      }),
      expect.objectContaining({ lessonId: lessonIds[1] }),
      expect.objectContaining({ lessonId: lessonIds[0] }),
    ]);
  });

  it("lists only the Student's own Notes, last edited first, with Lesson and Course", () => {
    saveNote(db, student, lessonIds[0], "Oldest", NOW);
    saveNote(db, student, lessonIds[1], "Middle", minutesLater(1));
    saveNote(db, student, lessonIds[0], "Edited last", minutesLater(2));
    saveNote(db, otherStudent, lessonIds[2], "Not mine", minutesLater(3));

    expect(listNotes(db, student)).toEqual([
      expect.objectContaining({
        lessonId: lessonIds[0],
        body: "Edited last",
        lessonTitle: "Lesson 1",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      }),
      expect.objectContaining({ lessonId: lessonIds[1], body: "Middle" }),
    ]);
  });
});

describe("approving a Refund", () => {
  it("keeps the Student's Bookmarks and Notes", async () => {
    const notifications = fakeNotifications();
    const platformAdmin = db
      .insert(schema.users)
      .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: student,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: student, courseId: base.course.id })
      .run();
    toggleBookmark(db, student, lessonIds[0], NOW);
    saveNote(db, student, lessonIds[0], "Keep me", NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      student,
      "It was not what I expected.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(approved.ok).toBe(true);
    expect(isBookmarked(db, student, lessonIds[0])).toBe(true);
    expect(getNote(db, student, lessonIds[0])?.body).toBe("Keep me");
  });
});
