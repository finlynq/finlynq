// AI guidance on the phone (FINLYNQ-219): the note rules + Markdown reader
// mirror the web's (same cases as pf-app tests/guidance-notes-rules.test.ts),
// and the screens read and write notes through the web's routes.
import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import GuidanceScreen from "../screens/GuidanceScreen";
import GuidanceNoteScreen from "../screens/GuidanceNoteScreen";
import GuideScreen from "../screens/GuideScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import {
  NOTES_LOCKED,
  NOTE_MAX_TOKENS,
  UNREADABLE,
  changedLine,
  checkNote,
  normalizeNotePath,
  notePathError,
  saveErrorText,
  type NoteFull,
} from "../lib/guidance";
import { parseInline, parseMarkdown } from "../lib/guidance-markdown";

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetParams = jest.fn();
let mockParams: Record<string, unknown> = {};
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setParams: mockSetParams }),
  useIsFocused: () => true,
  useRoute: () => ({ params: mockParams }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getGuides: jest.fn(),
    getGuidanceNotes: jest.fn(),
    getGuidanceNote: jest.fn(),
    saveGuidanceNote: jest.fn(),
    retireGuidanceNote: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function themed(node: React.ReactElement) {
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {node}
    </ThemeContext.Provider>
  );
}

const ok = <T,>(data: T) => ({ success: true, data });
const getGuides = endpoints.getGuides as jest.Mock;
const getNotes = endpoints.getGuidanceNotes as jest.Mock;
const getNote = endpoints.getGuidanceNote as jest.Mock;
const saveNote = endpoints.saveGuidanceNote as jest.Mock;
const retireNote = endpoints.retireGuidanceNote as jest.Mock;

const note = (over: Partial<NoteFull> = {}): NoteFull => ({
  id: 7,
  path: "banks/rbc-chequing.md",
  title: "RBC chequing",
  summary: "Signs are reversed",
  version: 2,
  updatedBy: "assistant",
  updatedAt: "2026-11-16T12:00:00.000Z",
  body: "Amounts in the **CSV** have reversed signs.",
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
});

const base = { path: "banks/rbc-chequing.md", title: "RBC chequing", body: "Amounts in the CSV have reversed signs." };

describe("note rules (mirror of the web)", () => {
  it("normalises what a person types", () => {
    expect(normalizeNotePath("  Banks/RBC-Chequing ")).toBe("banks/rbc-chequing.md");
    expect(normalizeNotePath("/payees.md")).toBe("payees.md");
    expect(normalizeNotePath("a\\b")).toBe("a/b.md");
  });

  it("accepts folders and rejects anything that could escape or look odd", () => {
    expect(notePathError("banks/rbc-chequing.md")).toBeNull();
    expect(notePathError("payees_2026.md")).toBeNull();
    for (const bad of ["", "../x.md", "a//b.md", "a b.md", "-x.md", "x.txt", "a/.md", "a/../b.md"]) {
      expect(notePathError(bad)).not.toBeNull();
    }
    expect(notePathError("a".repeat(118) + ".md")).not.toBeNull();
  });

  it("returns a tidied note", () => {
    const r = checkNote({ ...base, title: "  RBC chequing ", summary: "  ", body: "line\r\n\r\nmore\n" });
    expect(r).toEqual({ ok: true, note: { path: "banks/rbc-chequing.md", title: "RBC chequing", summary: null, body: "line\n\nmore" } });
  });

  it("refuses an empty title or body, and a note over the cap", () => {
    expect(checkNote({ ...base, title: " " }).ok).toBe(false);
    expect(checkNote({ ...base, body: "\n " }).ok).toBe(false);
    const r = checkNote({ ...base, body: "x".repeat(NOTE_MAX_TOKENS * 4 + 4) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too long.*Split it/);
    expect(checkNote({ ...base, body: "x".repeat(NOTE_MAX_TOKENS * 4) }).ok).toBe(true);
    expect(checkNote({ ...base, title: "t".repeat(121) }).ok).toBe(false);
    expect(checkNote({ ...base, summary: "s".repeat(201) }).ok).toBe(false);
  });

  it("words the save errors", () => {
    expect(saveErrorText("session_locked")).toBe(NOTES_LOCKED);
    expect(saveErrorText("HTTP 500", "Couldn't save the note.")).toBe("Couldn't save the note.");
    expect(saveErrorText("Network error: timeout")).toMatch(/still here/);
    expect(saveErrorText("Someone changed this note (now version 3).")).toMatch(/version 3/);
    expect(changedLine(note())).toBe("Version 2 · changed by your assistant, Nov 16, 2026");
  });
});

describe("parseMarkdown (mirror of the web)", () => {
  it("reads headings, paragraphs, lists and code", () => {
    const blocks = parseMarkdown(
      "# Title\n\nSome `code` and **bold**\ncontinued.\n\n- one\n- two\n  wrapped\n\n1. first\n2. second\n\n```\nraw *text*\n```\n",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list", "code"]);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      parts: [
        { kind: "text", text: "Some " },
        { kind: "code", text: "code" },
        { kind: "text", text: " and " },
        { kind: "bold", text: "bold" },
        { kind: "text", text: " continued." },
      ],
    });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
    expect(parseInline("one two wrapped")).toEqual([{ kind: "text", text: "one two wrapped" }]);
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[4]).toEqual({ kind: "code", text: "raw *text*" });
  });

  it("leaves HTML as plain text", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "paragraph", parts: [{ kind: "text", text: "<img src=x onerror=alert(1)>" }] },
    ]);
  });
});

describe("GuidanceScreen", () => {
  it("lists notes, marks unreadable ones, and opens a note or a new one", async () => {
    getNotes.mockResolvedValue(ok({ notes: [note(), note({ id: 8, unreadable: true, title: "", path: "" })], locked: false }));
    getGuides.mockResolvedValue(ok({ guides: [{ id: "reconcile", title: "Reconciling", summary: "How", markdown: "# R" }] }));
    const s = render(themed(<GuidanceScreen />));
    await waitFor(() => expect(s.getByText("RBC chequing")).toBeTruthy());
    expect(s.getByText(UNREADABLE)).toBeTruthy();
    expect(s.getAllByText("assistant")).toHaveLength(2);
    fireEvent.press(s.getByLabelText("RBC chequing"));
    expect(mockNavigate).toHaveBeenCalledWith("GuidanceNote", { id: 7 });
    fireEvent.press(s.getByLabelText("New note"));
    expect(mockNavigate).toHaveBeenCalledWith("GuidanceNote", {});
    fireEvent.press(s.getByText("Finlynq guides"));
    fireEvent.press(s.getByLabelText("Reconciling"));
    expect(mockNavigate).toHaveBeenCalledWith("Guide", { title: "Reconciling", markdown: "# R" });
  });

  it("says the notes are locked when the session has no key", async () => {
    getNotes.mockResolvedValue(ok({ notes: [], locked: true }));
    getGuides.mockResolvedValue(ok({ guides: [] }));
    const s = render(themed(<GuidanceScreen />));
    await waitFor(() => expect(s.getByText(NOTES_LOCKED)).toBeTruthy());
    expect(s.queryByLabelText("New note")).toBeNull();
  });
});

describe("GuidanceNoteScreen", () => {
  it("shows a note and saves an edit with the version it opened", async () => {
    mockParams = { id: 7 };
    getNote.mockResolvedValue(ok({ note: note(), history: [] }));
    saveNote.mockResolvedValue(ok({ note: note({ version: 3, updatedBy: "user", body: "New text" }) }));
    const s = render(themed(<GuidanceNoteScreen />));
    await waitFor(() => expect(s.getByText("RBC chequing")).toBeTruthy());
    expect(s.getByText("CSV")).toBeTruthy();
    fireEvent.press(s.getByLabelText("Edit"));
    fireEvent.changeText(s.getByLabelText("Note"), "New text");
    await act(async () => {
      fireEvent.press(s.getByLabelText("Save"));
    });
    expect(saveNote).toHaveBeenCalledWith({
      path: "banks/rbc-chequing.md",
      title: "RBC chequing",
      summary: "Signs are reversed",
      body: "New text",
      expectedVersion: 2,
    });
  });

  it("keeps the typed text when the assistant saved in between", async () => {
    mockParams = { id: 7 };
    getNote.mockResolvedValue(ok({ note: note(), history: [] }));
    saveNote.mockResolvedValue({ success: false, error: "This note was changed since you opened it (now version 3)." });
    const s = render(themed(<GuidanceNoteScreen />));
    await waitFor(() => expect(s.getByLabelText("Edit")).toBeTruthy());
    fireEvent.press(s.getByLabelText("Edit"));
    fireEvent.changeText(s.getByLabelText("Note"), "My careful text");
    await act(async () => {
      fireEvent.press(s.getByLabelText("Save"));
    });
    expect(s.getByText(/now version 3/)).toBeTruthy();
    expect(s.getByLabelText("Note").props.value).toBe("My careful text");
  });

  it("creates a new note at version 0 and checks it first", async () => {
    saveNote.mockResolvedValue(ok({ note: note({ id: 9, version: 1, updatedBy: "user" }) }));
    const s = render(themed(<GuidanceNoteScreen />));
    await act(async () => {
      fireEvent.press(s.getByLabelText("Save"));
    });
    expect(saveNote).not.toHaveBeenCalled();
    expect(s.getByText(/Give the note a file name/)).toBeTruthy();
    fireEvent.changeText(s.getByLabelText("File name"), "Payees");
    fireEvent.changeText(s.getByLabelText("Title"), "Payees");
    fireEvent.changeText(s.getByLabelText("Note"), "Costco is groceries.");
    getNote.mockResolvedValue(ok({ note: note({ id: 9 }), history: [] }));
    await act(async () => {
      fireEvent.press(s.getByLabelText("Save"));
    });
    expect(saveNote).toHaveBeenCalledWith({ path: "payees.md", title: "Payees", summary: null, body: "Costco is groceries.", expectedVersion: 0 });
    expect(mockSetParams).toHaveBeenCalledWith({ id: 9 });
  });

  it("retires a note after a confirmation", async () => {
    mockParams = { id: 7 };
    getNote.mockResolvedValue(ok({ note: note(), history: [] }));
    retireNote.mockResolvedValue(ok({ retired: true }));
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const s = render(themed(<GuidanceNoteScreen />));
    await waitFor(() => expect(s.getByLabelText("Retire")).toBeTruthy());
    fireEvent.press(s.getByLabelText("Retire"));
    const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((b) => b.text === "Retire")?.onPress?.();
    });
    expect(retireNote).toHaveBeenCalledWith(7, 2);
    expect(mockGoBack).toHaveBeenCalled();
    alert.mockRestore();
  });

  it("an unreadable note can't be edited", async () => {
    mockParams = { id: 8 };
    getNote.mockResolvedValue(ok({ note: note({ id: 8, unreadable: true, title: "", body: "" }), history: [] }));
    const s = render(themed(<GuidanceNoteScreen />));
    await waitFor(() => expect(s.getByText(UNREADABLE)).toBeTruthy());
    expect(s.queryByLabelText("Edit")).toBeNull();
    expect(s.getByLabelText("Retire")).toBeTruthy();
  });
});

describe("GuideScreen", () => {
  it("shows the guide it was handed", () => {
    mockParams = { title: "Reconciling", markdown: "## Steps\n\n- Upload the file" };
    const s = render(themed(<GuideScreen />));
    expect(s.getByText("Reconciling")).toBeTruthy();
    expect(s.getByText("Steps")).toBeTruthy();
    expect(s.getByText("Upload the file")).toBeTruthy();
  });
});
