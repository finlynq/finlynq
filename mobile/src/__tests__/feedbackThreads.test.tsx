// Your feedback on mobile (in-app feedback #30: replies could only be read by
// email or on the website).
import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Linking } from "react-native";
import FeedbackThreadsScreen from "../screens/FeedbackThreadsScreen";
import FeedbackThreadScreen from "../screens/FeedbackThreadScreen";
import FeedbackScreen from "../screens/FeedbackScreen";
import MoreScreen from "../screens/MoreScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import {
  FEEDBACK_NETWORK_ERROR,
  FEEDBACK_REPLY_ERROR,
  attachmentLabel,
  countUnreadThreads,
  feedbackMeta,
  feedbackWebUrl,
  replyCountLabel,
  replyErrorText,
  threadTitle,
  withReply,
} from "../lib/feedback";
import type { FeedbackMessage, FeedbackThread, FeedbackThreadSummary } from "../../../shared/types";

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockPopTo = jest.fn();
let mockFocused = true;
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, popTo: mockPopTo }),
  useIsFocused: () => mockFocused,
  useRoute: () => ({ params: { id: 12 } }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getFeedbackThreads: jest.fn(),
    getFeedbackThread: jest.fn(),
    replyToFeedback: jest.fn(),
    markFeedbackRead: jest.fn(),
    submitFeedback: jest.fn(),
    loadSampleData: jest.fn(),
  },
  getServerUrl: () => "https://finlynq.example",
}));

jest.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ signOut: jest.fn() }),
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

const getThreads = endpoints.getFeedbackThreads as jest.Mock;
const getThread = endpoints.getFeedbackThread as jest.Mock;
const sendReply = endpoints.replyToFeedback as jest.Mock;
const markRead = endpoints.markFeedbackRead as jest.Mock;
const ok = <T,>(data: T) => ({ success: true, data });

const summary = (over: Partial<FeedbackThreadSummary> = {}): FeedbackThreadSummary => ({
  id: 12,
  type: "idea",
  status: "triaged",
  seed: "Can I read replies on my phone?",
  createdAt: "2026-10-30T12:00:00.000Z",
  updatedAt: "2026-10-31T12:00:00.000Z",
  lastMessageAt: "2026-10-31T12:00:00.000Z",
  lastMessagePreview: "Yes, we are working on it.",
  messageCount: 1,
  unread: false,
  ...over,
});

const teamMessage: FeedbackMessage = {
  id: 90,
  feedbackId: 12,
  authorRole: "admin",
  body: "Yes, we are working on it.",
  createdAt: "2026-10-31T12:00:00.000Z",
  mine: false,
  attachment: null,
};

const thread = (over: Partial<FeedbackThread> = {}): FeedbackThread => ({
  ...summary(),
  pageUrl: null,
  appVersion: "mobile",
  attachment: null,
  messages: [teamMessage],
  ...over,
});

const myReply: FeedbackMessage = {
  id: 91,
  feedbackId: 12,
  authorRole: "user",
  body: "Thank you!",
  createdAt: "2026-10-31T13:00:00.000Z",
  mine: true,
  attachment: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
  markRead.mockResolvedValue(ok({ ok: true }));
});

describe("feedback wording", () => {
  it("counts replies, not the original message", () => {
    expect(replyCountLabel(0)).toBeNull();
    expect(replyCountLabel(1)).toBe("1 reply");
    expect(replyCountLabel(4)).toBe("4 replies");
  });

  it("counts the threads with an unread reply", () => {
    expect(countUnreadThreads([summary(), summary({ id: 2, unread: true }), summary({ id: 3, unread: true })])).toBe(2);
    expect(countUnreadThreads([])).toBe(0);
  });

  it("names the thread and who wrote each message", () => {
    expect(threadTitle(null)).toBe("Feedback");
    expect(threadTitle({ type: "bug" })).toBe("Bug feedback");
    const now = new Date(2026, 9, 31, 18, 0);
    expect(feedbackMeta("user", new Date(2026, 9, 31, 17, 5).toISOString(), now)).toBe("You · today, 5:05 PM");
    expect(feedbackMeta("admin", new Date(2026, 9, 30, 9, 0).toISOString(), now)).toBe(
      "Finlynq team · yesterday, 9:00 AM",
    );
  });

  it("labels an attachment by name and size", () => {
    expect(attachmentLabel({ filename: "shot.png", mime: "image/png", size: 2048 })).toBe("shot.png (2 KB)");
    expect(attachmentLabel({ filename: "log.txt", mime: null, size: 512 })).toBe("log.txt (512 B)");
    expect(attachmentLabel({ filename: null, mime: null, size: 3 * 1024 * 1024 })).toBe("attachment (3.0 MB)");
    expect(attachmentLabel({ filename: "a.pdf", mime: null, size: null })).toBe("a.pdf");
  });

  it("keeps the server's refusal but rewords what only makes sense in a log", () => {
    expect(replyErrorText("Too many replies. Please try again later.")).toBe(
      "Too many replies. Please try again later.",
    );
    expect(replyErrorText("Network error: TypeError: Network request failed")).toBe(FEEDBACK_NETWORK_ERROR);
    expect(replyErrorText("HTTP 502")).toBe(FEEDBACK_REPLY_ERROR);
    expect(replyErrorText(undefined)).toBe(FEEDBACK_REPLY_ERROR);
  });

  it("adds a reply to the end of the thread", () => {
    const next = withReply(thread(), myReply);
    expect(next.messages.map((m) => m.id)).toEqual([90, 91]);
    expect(next.messageCount).toBe(2);
  });

  it("points attachments at the website's page", () => {
    expect(feedbackWebUrl("https://finlynq.example")).toBe("https://finlynq.example/feedback");
  });
});

describe("FeedbackThreadsScreen", () => {
  it("lists the threads and marks only the unread one", async () => {
    getThreads.mockResolvedValue(
      ok([
        summary({ id: 1, type: "bug", status: "new", lastMessagePreview: "It crashed", messageCount: 0 }),
        summary({ id: 2, unread: true, messageCount: 2, lastMessagePreview: "Fixed in the next build" }),
      ]),
    );
    const { getByText, getAllByText, queryAllByText } = render(themed(<FeedbackThreadsScreen />));
    await waitFor(() => expect(getByText("It crashed")).toBeTruthy());
    expect(getByText("Fixed in the next build")).toBeTruthy();
    expect(getByText("Bug")).toBeTruthy();
    expect(getByText("Triaged")).toBeTruthy();
    expect(queryAllByText("New reply")).toHaveLength(1);
    expect(getAllByText(/2 replies/)).toHaveLength(1);
    expect(queryAllByText(/\d replies?$/)).toHaveLength(1);
  });

  it("opens a thread", async () => {
    getThreads.mockResolvedValue(ok([summary({ id: 7 })]));
    const { getByLabelText } = render(themed(<FeedbackThreadsScreen />));
    await waitFor(() => expect(getByLabelText("Open Idea feedback")).toBeTruthy());
    fireEvent.press(getByLabelText("Open Idea feedback"));
    expect(mockNavigate).toHaveBeenCalledWith("FeedbackThread", { id: 7 });
  });

  it("says so when there is nothing yet, and offers to send some", async () => {
    getThreads.mockResolvedValue(ok([]));
    const { getByText, getByLabelText } = render(themed(<FeedbackThreadsScreen />));
    await waitFor(() => expect(getByText("You haven't sent any feedback yet.")).toBeTruthy());
    fireEvent.press(getByLabelText("Send feedback"));
    expect(mockNavigate).toHaveBeenCalledWith("Feedback");
  });

  it("shows the failure and can try again", async () => {
    getThreads.mockResolvedValueOnce({ success: false, error: "HTTP 500" });
    getThreads.mockResolvedValueOnce(ok([summary({ lastMessagePreview: "Back again" })]));
    const { getByText } = render(themed(<FeedbackThreadsScreen />));
    await waitFor(() => expect(getByText("Failed to load your feedback.")).toBeTruthy());
    fireEvent.press(getByText("Try again"));
    await waitFor(() => expect(getByText("Back again")).toBeTruthy());
  });

  it("survives a thrown fetch", async () => {
    getThreads.mockRejectedValue(new Error("boom"));
    const { getByText } = render(themed(<FeedbackThreadsScreen />));
    await waitFor(() => expect(getByText("Failed to load your feedback.")).toBeTruthy());
  });

  // Coming back from a thread must drop its "New reply".
  it("reloads each time the screen regains focus", async () => {
    getThreads.mockResolvedValueOnce(ok([summary({ unread: true })]));
    getThreads.mockResolvedValueOnce(ok([summary({ unread: false })]));
    const { queryByText, rerender } = render(themed(<FeedbackThreadsScreen />));
    await waitFor(() => expect(queryByText("New reply")).toBeTruthy());
    mockFocused = false;
    rerender(themed(<FeedbackThreadsScreen />));
    mockFocused = true;
    rerender(themed(<FeedbackThreadsScreen />));
    // Not toBeNull(): each miss prints the whole element tree, slow enough to
    // use up waitFor's second.
    await waitFor(() => expect(queryByText("New reply") === null).toBe(true));
    expect(getThreads).toHaveBeenCalledTimes(2);
  });
});

describe("FeedbackThreadScreen", () => {
  it("shows the original message and the replies, each with its author", async () => {
    getThread.mockResolvedValue(ok(thread()));
    const { getByText, getAllByText } = render(themed(<FeedbackThreadScreen />));
    await waitFor(() => expect(getByText("Can I read replies on my phone?")).toBeTruthy());
    expect(getThread).toHaveBeenCalledWith(12);
    expect(getByText("Idea feedback")).toBeTruthy();
    expect(getByText("Yes, we are working on it.")).toBeTruthy();
    expect(getAllByText(/^You · /)).toHaveLength(1);
    expect(getAllByText(/^Finlynq team · /)).toHaveLength(1);
  });

  it("marks an unread thread read once it has loaded", async () => {
    getThread.mockResolvedValue(ok(thread({ unread: true })));
    render(themed(<FeedbackThreadScreen />));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(12));
  });

  it("does not write anything when there is nothing new", async () => {
    getThread.mockResolvedValue(ok(thread({ unread: false })));
    const { findByText } = render(themed(<FeedbackThreadScreen />));
    await findByText("Idea feedback");
    expect(markRead).not.toHaveBeenCalled();
  });

  // The web marks read as it opens; here a failed load keeps the marker, since
  // the reply was never on screen.
  it("does not mark read when the thread failed to load", async () => {
    getThread.mockResolvedValue({ success: false, error: "Not found." });
    const { getByText, queryByLabelText } = render(themed(<FeedbackThreadScreen />));
    await waitFor(() => expect(getByText("Failed to load this thread.")).toBeTruthy());
    expect(markRead).not.toHaveBeenCalled();
    expect(queryByLabelText("Send reply")).toBeNull();
  });

  it("retries a failed load", async () => {
    getThread.mockResolvedValueOnce({ success: false, error: "HTTP 500" });
    getThread.mockResolvedValueOnce(ok(thread()));
    const { getByText } = render(themed(<FeedbackThreadScreen />));
    await waitFor(() => expect(getByText("Try again")).toBeTruthy());
    fireEvent.press(getByText("Try again"));
    await waitFor(() => expect(getByText("Can I read replies on my phone?")).toBeTruthy());
  });

  it("shows attachments by name, with a link to the website", async () => {
    getThread.mockResolvedValue(
      ok(
        thread({
          attachment: { filename: "shot.png", mime: "image/png", size: 2048 },
          messages: [{ ...teamMessage, attachment: { filename: "fix.pdf", mime: "application/pdf", size: 1024 } }],
        }),
      ),
    );
    const { getByText, getAllByText } = render(themed(<FeedbackThreadScreen />));
    await waitFor(() => expect(getByText("shot.png (2 KB)")).toBeTruthy());
    expect(getByText("fix.pdf (1 KB)")).toBeTruthy();
    fireEvent.press(getAllByText("Open on the website")[0]);
    expect(Linking.openURL).toHaveBeenCalledWith("https://finlynq.example/feedback");
  });

  describe("replying", () => {
    async function ready() {
      getThread.mockResolvedValue(ok(thread()));
      const utils = render(themed(<FeedbackThreadScreen />));
      await waitFor(() => expect(utils.getByLabelText("Send reply")).toBeTruthy());
      return utils;
    }

    it("sends the trimmed text, adds it to the thread and clears the box", async () => {
      sendReply.mockResolvedValue(ok(myReply));
      const { getByLabelText, getByText, getAllByText } = await ready();
      fireEvent.changeText(getByLabelText("Write a reply"), "  Thank you!  ");
      fireEvent.press(getByLabelText("Send reply"));
      await waitFor(() => expect(getByText("Thank you!")).toBeTruthy());
      expect(sendReply).toHaveBeenCalledWith(12, "Thank you!");
      expect(getByLabelText("Write a reply").props.value).toBe("");
      expect(getAllByText(/^You · /)).toHaveLength(2);
    });

    it("does not send an empty reply", async () => {
      const { getByLabelText } = await ready();
      fireEvent.press(getByLabelText("Send reply"));
      fireEvent.changeText(getByLabelText("Write a reply"), "   ");
      fireEvent.press(getByLabelText("Send reply"));
      expect(sendReply).not.toHaveBeenCalled();
    });

    // The route has no idempotency key: two presses before the re-render would
    // post the message twice.
    it("sends once on a double tap", async () => {
      let resolve: (v: unknown) => void = () => {};
      sendReply.mockReturnValue(new Promise((r) => (resolve = r)));
      const { getByLabelText, getByText } = await ready();
      fireEvent.changeText(getByLabelText("Write a reply"), "Twice?");
      const button = getByLabelText("Send reply");
      const press = button.props.onPress;
      act(() => {
        press();
        press();
      });
      fireEvent.press(getByLabelText("Send reply"));
      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(getByText("Sending…")).toBeTruthy();
      await act(async () => resolve(ok({ ...myReply, body: "Twice?" })));
      expect(getByText("Twice?")).toBeTruthy();
      expect(getByText("Send reply")).toBeTruthy();
    });

    it("keeps the draft and shows the server's reason when a reply is refused", async () => {
      sendReply.mockResolvedValue({ success: false, error: "Too many replies. Please try again later." });
      const { getByLabelText, getByText, queryByText } = await ready();
      fireEvent.changeText(getByLabelText("Write a reply"), "Please keep me");
      fireEvent.press(getByLabelText("Send reply"));
      await waitFor(() => expect(getByText("Too many replies. Please try again later.")).toBeTruthy());
      expect(getByLabelText("Write a reply").props.value).toBe("Please keep me");
      expect(queryByText("Please keep me")).toBeNull(); // Not added to the thread.

      // The next try clears the error and goes through.
      sendReply.mockResolvedValue(ok({ ...myReply, body: "Please keep me" }));
      fireEvent.press(getByLabelText("Send reply"));
      await waitFor(() => expect(getByText("Please keep me")).toBeTruthy());
      expect(queryByText("Too many replies. Please try again later.")).toBeNull();
    });

    it("says it could not reach the server when the connection drops", async () => {
      sendReply.mockResolvedValue({ success: false, error: "Network error: TypeError: Network request failed" });
      const { getByLabelText, getByText } = await ready();
      fireEvent.changeText(getByLabelText("Write a reply"), "Offline");
      fireEvent.press(getByLabelText("Send reply"));
      await waitFor(() => expect(getByText(FEEDBACK_NETWORK_ERROR)).toBeTruthy());
      expect(getByLabelText("Write a reply").props.value).toBe("Offline");
    });

    it("survives a thrown send", async () => {
      sendReply.mockRejectedValue(new Error("boom"));
      const { getByLabelText, getByText } = await ready();
      fireEvent.changeText(getByLabelText("Write a reply"), "Offline");
      fireEvent.press(getByLabelText("Send reply"));
      await waitFor(() => expect(getByText(FEEDBACK_NETWORK_ERROR)).toBeTruthy());
      expect(getByLabelText("Write a reply").props.value).toBe("Offline");
    });
  });
});

describe("getting there", () => {
  it("More shows Your feedback with the unread count", async () => {
    getThreads.mockResolvedValue(ok([summary({ unread: true }), summary({ id: 2, unread: true }), summary({ id: 3 })]));
    const { getByText } = render(themed(<MoreScreen />));
    await waitFor(() => expect(getByText("2")).toBeTruthy());
    fireEvent.press(getByText("Your feedback"));
    expect(mockNavigate).toHaveBeenCalledWith("FeedbackThreads");
    fireEvent.press(getByText("Send feedback"));
    expect(mockNavigate).toHaveBeenCalledWith("Feedback");
  });

  it("More shows no count when nothing is unread or the fetch fails", async () => {
    getThreads.mockResolvedValue(ok([summary()]));
    const quiet = render(themed(<MoreScreen />));
    await waitFor(() => expect(getThreads).toHaveBeenCalled());
    expect(quiet.queryByText("0")).toBeNull();
    quiet.unmount();

    getThreads.mockRejectedValue(new Error("boom"));
    const failed = render(themed(<MoreScreen />));
    await act(async () => {});
    expect(failed.getByText("Your feedback")).toBeTruthy();
  });

  it("the send form links to the threads without pushing behind its modal", () => {
    const { getByText } = render(themed(<FeedbackScreen />));
    fireEvent.press(getByText("See your feedback and replies"));
    expect(mockPopTo).toHaveBeenCalledWith("FeedbackThreads");
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
