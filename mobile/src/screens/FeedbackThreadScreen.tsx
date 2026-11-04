// One feedback thread: the original message, the replies, and a reply box
// (in-app feedback #30). Same routes as the web's thread dialog on /feedback.
//
// A thread is marked read only after its messages loaded, so a failed load keeps
// the "New reply" marker on a reply nobody has seen. A failed send keeps the
// draft in the box. The reply route has no idempotency key, hence the ref a
// double tap reads before the re-render disables the button.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  KeyboardAvoidingView,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints, getServerUrl } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import {
  FEEDBACK_NETWORK_ERROR,
  FEEDBACK_THREAD_ERROR,
  FEEDBACK_THREAD_HINT,
  attachmentLabel,
  feedbackMeta,
  feedbackWebUrl,
  replyErrorText,
  threadTitle,
  withReply,
} from "../lib/feedback";
import type { FeedbackAttachmentMeta, FeedbackThread } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

export default function FeedbackThreadScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();
  const { id } = useRoute<RouteProp<MoreStackParamList, "FeedbackThread">>().params;
  const [thread, setThread] = useState<FeedbackThread | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // Ignore a response that lands after the screen is gone.
  const alive = useRef(true);
  // The flag a double tap reads before the re-render that disables the button.
  const sendingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      setLoadError(null);
      try {
        const res = await endpoints.getFeedbackThread(id);
        if (!alive.current) return;
        if (res.success) {
          setThread(res.data);
          if (res.data.unread) endpoints.markFeedbackRead(id).catch(() => {});
        } else {
          logger.warn("feedback", "thread failed", { error: res.error });
          setLoadError(FEEDBACK_THREAD_ERROR);
        }
      } catch (e) {
        logger.error("feedback", "thread threw", { detail: String(e) });
        if (alive.current) setLoadError(FEEDBACK_THREAD_ERROR);
      } finally {
        if (alive.current) setRefreshing(false);
      }
    },
    [id],
  );

  useEffect(() => {
    load();
  }, [load]);

  const send = useCallback(async () => {
    const body = reply.trim();
    if (!body || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const res = await endpoints.replyToFeedback(id, body);
      if (!alive.current) return;
      if (res.success) {
        setThread((t) => (t ? withReply(t, res.data) : t));
        setReply("");
      } else {
        logger.warn("feedback", "reply failed", { error: res.error });
        setSendError(replyErrorText(res.error));
      }
    } catch (e) {
      logger.error("feedback", "reply threw", { detail: String(e) });
      if (alive.current) setSendError(FEEDBACK_NETWORK_ERROR);
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  }, [id, reply]);

  const canSend = !sending && reply.trim().length > 0;
  const openWeb = () => Linking.openURL(feedbackWebUrl(getServerUrl()));
  const toBottom = () => scrollRef.current?.scrollToEnd({ animated: false });

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      {/* "padding" on Android too: edge-to-edge is on (app.json), so the window can't
          be relied on to resize for the keyboard, and the reply box sits at the bottom. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity
            style={styles.back}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Icon name="back" size={20} color={colors.primary} />
            <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {threadTitle(thread)}
          </Text>
          <View style={{ width: 70 }} />
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={toBottom}
          onLayout={toBottom}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
        >
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>{FEEDBACK_THREAD_HINT}</Text>

          {loadError && !thread ? (
            <View accessibilityRole="alert">
              <Text style={[styles.body, { color: colors.destructive }]}>{loadError}</Text>
              <TouchableOpacity onPress={() => load()} accessibilityRole="button" style={styles.retry}>
                <Text style={[styles.retryText, { color: colors.primary }]}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : !thread ? (
            <ActivityIndicator style={{ marginVertical: 32 }} size="large" color={colors.primary} />
          ) : (
            <>
              <Bubble author="user" at={thread.createdAt} body={thread.seed} />
              {thread.attachment ? (
                <Attachment attachment={thread.attachment} author="user" onOpen={openWeb} />
              ) : null}
              {thread.messages.map((m) => (
                <View key={m.id}>
                  <Bubble author={m.authorRole} at={m.createdAt} body={m.body} />
                  {m.attachment ? (
                    <Attachment attachment={m.attachment} author={m.authorRole} onOpen={openWeb} />
                  ) : null}
                </View>
              ))}
            </>
          )}
        </ScrollView>

        {thread ? (
          <View style={[styles.composer, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            {sendError ? (
              <Text accessibilityRole="alert" style={[styles.body, styles.sendError, { color: colors.destructive }]}>
                {sendError}
              </Text>
            ) : null}
            <View style={styles.composerRow}>
              <TextInput
                style={[
                  styles.input,
                  {
                    color: colors.foreground,
                    backgroundColor: colors.secondary,
                    borderColor: colors.border,
                  },
                ]}
                value={reply}
                onChangeText={setReply}
                placeholder="Write a reply…"
                placeholderTextColor={colors.mutedForeground}
                accessibilityLabel="Write a reply"
                maxLength={4000}
                multiline
                textAlignVertical="top"
              />
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Send reply"
                accessibilityState={{ disabled: !canSend, busy: sending }}
                disabled={!canSend}
                activeOpacity={0.7}
                onPress={canSend ? send : undefined}
                style={[styles.sendBtn, { backgroundColor: colors.primary, opacity: canSend ? 1 : 0.6 }]}
              >
                {sending ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : null}
                <Text style={[styles.sendText, { color: colors.primaryForeground }]}>
                  {sending ? "Sending…" : "Send reply"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Bubble({ author, at, body }: { author: "user" | "admin"; at: string; body: string }) {
  const { colors } = useTheme();
  const mine = author === "user";
  return (
    <View style={[styles.bubbleWrap, mine ? styles.alignEnd : styles.alignStart]}>
      <View style={[styles.bubble, { backgroundColor: mine ? colors.accent : colors.muted }]}>
        <Text style={[styles.bubbleText, { color: mine ? colors.accentForeground : colors.foreground }]} selectable>
          {body}
        </Text>
      </View>
      <Text style={[styles.meta, { color: colors.mutedForeground }]}>{feedbackMeta(author, at)}</Text>
    </View>
  );
}

function Attachment({
  attachment,
  author,
  onOpen,
}: {
  attachment: FeedbackAttachmentMeta;
  author: "user" | "admin";
  onOpen: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.attachment, author === "user" ? styles.alignEnd : styles.alignStart]}>
      <View style={styles.attachmentName}>
        <Icon name="paperclip" size={13} color={colors.mutedForeground} />
        <Text style={[styles.meta, styles.attachmentText, { color: colors.mutedForeground }]} numberOfLines={1}>
          {attachmentLabel(attachment)}
        </Text>
      </View>
      <TouchableOpacity accessibilityRole="link" onPress={onOpen} hitSlop={8}>
        <Text style={[styles.attachmentLink, { color: colors.primary }]}>Open on the website</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { flexDirection: "row", alignItems: "center", gap: 2, width: 70 },
  backText: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  scroll: { padding: 16, paddingBottom: 16 },
  hint: { fontSize: 12, lineHeight: 17, marginBottom: 12 },
  body: { fontSize: 13, lineHeight: 19 },
  retry: { marginTop: 4, alignSelf: "flex-start", paddingVertical: 6 },
  retryText: { fontSize: 14, fontWeight: "700" },
  bubbleWrap: { marginBottom: 12 },
  alignEnd: { alignItems: "flex-end" },
  alignStart: { alignItems: "flex-start" },
  bubble: { maxWidth: "85%", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  meta: { fontSize: 11, marginTop: 4 },
  attachment: { marginTop: -6, marginBottom: 12 },
  attachmentName: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "85%" },
  attachmentText: { marginTop: 0, flexShrink: 1 },
  attachmentLink: { fontSize: 12, fontWeight: "700", marginTop: 2 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10 },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  sendError: { marginBottom: 6 },
  input: {
    flex: 1,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    minHeight: 40,
    maxHeight: 120,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 40,
  },
  sendText: { fontSize: 14, fontWeight: "700" },
});
