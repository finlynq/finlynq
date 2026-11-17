// One AI guidance note (FINLYNQ-219): read it, edit it, see its history, or
// retire it; or write a new one (no `id`). Same routes as the web's Settings →
// AI guidance page.
//
// Every save sends the version the user opened, so an edit made while the
// assistant changed the note is refused (the server says so) and the typed
// text stays in the form. The save route has no idempotency key, hence the ref
// a double tap reads before the re-render disables the button.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  KeyboardAvoidingView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import { MarkdownText } from "../components/MarkdownText";
import {
  NETWORK_ERROR,
  NOTE_LOAD_ERROR,
  NOTE_MAX_TOKENS,
  NOTE_RETIRE_ERROR,
  NOTE_SAVE_ERROR,
  RETIRE_BODY,
  RETIRE_TITLE,
  UNREADABLE,
  UNREADABLE_DETAIL,
  changedLine,
  checkNote,
  estimateTokens,
  revisionLine,
  saveErrorText,
  type NoteFull,
  type NoteRevision,
} from "../lib/guidance";
import type { MoreStackParamList } from "../navigation/MoreStack";

interface Draft {
  path: string;
  title: string;
  summary: string;
  body: string;
}

const EMPTY: Draft = { path: "", title: "", summary: "", body: "" };

export default function GuidanceNoteScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void; setParams: (p: { id?: number }) => void }>();
  const params = useRoute<RouteProp<MoreStackParamList, "GuidanceNote">>().params ?? {};
  const [noteId, setNoteId] = useState<number | undefined>(params.id);
  const [note, setNote] = useState<NoteFull | null>(null);
  const [history, setHistory] = useState<NoteRevision[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(params.id == null ? EMPTY : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (id: number) => {
    setLoadError(null);
    try {
      const res = await endpoints.getGuidanceNote(id);
      if (!alive.current) return;
      if (res.success) {
        setNote(res.data.note);
        setHistory(res.data.history ?? []);
      } else {
        logger.warn("guidance", "note failed", { error: res.error });
        setLoadError(saveErrorText(res.error, NOTE_LOAD_ERROR));
      }
    } catch (e) {
      logger.error("guidance", "note threw", { detail: String(e) });
      if (alive.current) setLoadError(NOTE_LOAD_ERROR);
    }
  }, []);

  useEffect(() => {
    if (noteId != null) load(noteId);
  }, [noteId, load]);

  const isNew = noteId == null;

  const save = useCallback(async () => {
    if (!draft || savingRef.current) return;
    const checked = checkNote(isNew ? draft : { ...draft, path: note?.path ?? draft.path });
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await endpoints.saveGuidanceNote({ ...checked.note, expectedVersion: isNew ? 0 : note?.version ?? 0 });
      if (!alive.current) return;
      if (res.success) {
        const saved = res.data.note;
        setNote(saved);
        setDraft(null);
        if (isNew) {
          setNoteId(saved.id);
          navigation.setParams({ id: saved.id });
        } else {
          load(saved.id);
        }
      } else {
        logger.warn("guidance", "save failed", { error: res.error });
        setError(saveErrorText(res.error, NOTE_SAVE_ERROR));
      }
    } catch (e) {
      logger.error("guidance", "save threw", { detail: String(e) });
      if (alive.current) setError(NETWORK_ERROR);
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }, [draft, isNew, note, navigation, load]);

  const retire = useCallback(async () => {
    if (!note || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await endpoints.retireGuidanceNote(note.id, note.version);
      if (!alive.current) return;
      if (res.success) navigation.goBack();
      else setError(saveErrorText(res.error, NOTE_RETIRE_ERROR));
    } catch (e) {
      logger.error("guidance", "retire threw", { detail: String(e) });
      if (alive.current) setError(NETWORK_ERROR);
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }, [note, navigation]);

  const confirmRetire = () =>
    Alert.alert(RETIRE_TITLE, RETIRE_BODY, [
      { text: "Cancel", style: "cancel" },
      { text: "Retire", style: "destructive", onPress: retire },
    ]);

  const title = draft ? (isNew ? "New note" : "Edit note") : note?.unreadable ? UNREADABLE : note?.title ?? "Note";
  const tokens = draft ? estimateTokens(draft.body) : 0;
  const input = [styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Back">
            <Icon name="back" size={20} color={colors.primary} />
            <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {title}
          </Text>
          <View style={{ width: 70 }} />
        </View>

        <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {draft ? (
            <>
              {isNew ? (
                <View style={styles.field}>
                  <Text style={[styles.label, { color: colors.foreground }]}>File name</Text>
                  <TextInput
                    style={input}
                    value={draft.path}
                    onChangeText={(path) => setDraft({ ...draft, path })}
                    placeholder="banks/rbc-chequing.md"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel="File name"
                  />
                </View>
              ) : (
                <Text style={[styles.path, { color: colors.mutedForeground }]}>{note?.path}</Text>
              )}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>Title</Text>
                <TextInput style={input} value={draft.title} onChangeText={(t) => setDraft({ ...draft, title: t })} accessibilityLabel="Title" />
              </View>
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>One-line summary (optional)</Text>
                <TextInput
                  style={input}
                  value={draft.summary}
                  onChangeText={(summary) => setDraft({ ...draft, summary })}
                  accessibilityLabel="One-line summary"
                />
              </View>
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>Note (Markdown)</Text>
                <TextInput
                  style={[input, styles.bodyInput]}
                  value={draft.body}
                  onChangeText={(body) => setDraft({ ...draft, body })}
                  multiline
                  textAlignVertical="top"
                  autoCapitalize="sentences"
                  accessibilityLabel="Note"
                />
                <Text style={[styles.meta, { color: tokens > NOTE_MAX_TOKENS ? colors.destructive : colors.mutedForeground }]}>
                  About {tokens} of {NOTE_MAX_TOKENS} tokens
                </Text>
              </View>
              {error ? (
                <Text accessibilityRole="alert" style={[styles.body, { color: colors.destructive }]}>
                  {error}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Save"
                  accessibilityState={{ disabled: saving, busy: saving }}
                  disabled={saving}
                  onPress={saving ? undefined : save}
                  style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: saving ? 0.6 : 1 }]}
                >
                  {saving ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : null}
                  <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>{saving ? "Saving…" : "Save"}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  onPress={() => {
                    setError(null);
                    if (isNew) navigation.goBack();
                    else setDraft(null);
                  }}
                  style={[styles.secondaryBtn, { borderColor: colors.border }]}
                >
                  <Text style={[styles.secondaryText, { color: colors.foreground }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : loadError && !note ? (
            <View accessibilityRole="alert">
              <Text style={[styles.body, { color: colors.destructive }]}>{loadError}</Text>
              {noteId != null ? (
                <TouchableOpacity onPress={() => load(noteId)} accessibilityRole="button" style={styles.retry}>
                  <Text style={[styles.link, { color: colors.primary }]}>Try again</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : !note ? (
            <ActivityIndicator style={{ marginVertical: 32 }} size="large" color={colors.primary} />
          ) : (
            <>
              {note.unreadable ? null : <Text style={[styles.path, { color: colors.mutedForeground }]}>{note.path}</Text>}
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>{changedLine(note)}</Text>
              {note.unreadable ? (
                <Text style={[styles.body, { color: colors.mutedForeground }]}>{UNREADABLE_DETAIL}</Text>
              ) : (
                <MarkdownText markdown={note.body} />
              )}
              {error ? (
                <Text accessibilityRole="alert" style={[styles.body, { color: colors.destructive }]}>
                  {error}
                </Text>
              ) : null}
              <View style={styles.actions}>
                {note.unreadable ? null : (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Edit"
                    onPress={() => {
                      setError(null);
                      setDraft({ path: note.path, title: note.title, summary: note.summary ?? "", body: note.body });
                    }}
                    style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>Edit</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={showHistory ? "Hide history" : "History"}
                  onPress={() => setShowHistory((v) => !v)}
                  style={[styles.secondaryBtn, { borderColor: colors.border }]}
                >
                  <Text style={[styles.secondaryText, { color: colors.foreground }]}>{showHistory ? "Hide history" : "History"}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Retire"
                  disabled={saving}
                  onPress={saving ? undefined : confirmRetire}
                  style={[styles.secondaryBtn, { borderColor: colors.border }]}
                >
                  <Text style={[styles.secondaryText, { color: colors.destructive }]}>Retire</Text>
                </TouchableOpacity>
              </View>
              {showHistory ? (
                <View style={[styles.history, { borderTopColor: colors.border }]}>
                  {history.map((h) => (
                    <View key={`${h.version}-${h.action}-${h.createdAt}`} style={styles.revision}>
                      <Text style={[styles.meta, { color: colors.mutedForeground }]}>{revisionLine(h)}</Text>
                      {note.unreadable ? null : <MarkdownText markdown={h.body} />}
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  scroll: { padding: 16, paddingBottom: 32, gap: 12 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: "600" },
  input: {
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    minHeight: 44,
  },
  bodyInput: { minHeight: 200, fontFamily: "monospace", fontSize: 14 },
  path: { fontSize: 12, fontFamily: "monospace" },
  meta: { fontSize: 12 },
  body: { fontSize: 14, lineHeight: 20 },
  retry: { marginTop: 4, alignSelf: "flex-start", paddingVertical: 6 },
  link: { fontSize: 14, fontWeight: "700" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 10,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  primaryText: { fontSize: 15, fontWeight: "700" },
  secondaryBtn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  secondaryText: { fontSize: 15, fontWeight: "600" },
  history: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 14 },
  revision: { gap: 6 },
});
