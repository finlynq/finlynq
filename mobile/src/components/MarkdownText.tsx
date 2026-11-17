// Renders a guide or a note (FINLYNQ-219) from the parsed blocks in
// lib/guidance-markdown.ts. Everything is plain Text: a note is never treated
// as markup.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "../theme";
import { parseMarkdown, type InlinePart } from "../lib/guidance-markdown";

function Inline({ parts, color }: { parts: InlinePart[]; color: string }) {
  const { colors } = useTheme();
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "code" ? (
          <Text key={i} style={[styles.code, { color, backgroundColor: colors.muted }]}>
            {p.text}
          </Text>
        ) : p.kind === "bold" ? (
          <Text key={i} style={styles.bold}>
            {p.text}
          </Text>
        ) : (
          <Text key={i}>{p.text}</Text>
        ),
      )}
    </>
  );
}

export function MarkdownText({ markdown }: { markdown: string }) {
  const { colors } = useTheme();
  const color = colors.foreground;
  return (
    <View style={styles.wrap}>
      {parseMarkdown(markdown).map((b, i) => {
        if (b.kind === "heading") {
          return (
            <Text
              key={i}
              accessibilityRole="header"
              style={[b.level === 1 ? styles.h1 : b.level === 2 ? styles.h2 : styles.h3, { color }]}
            >
              <Inline parts={b.parts} color={color} />
            </Text>
          );
        }
        if (b.kind === "list") {
          return (
            <View key={i} style={styles.list}>
              {b.items.map((item, j) => (
                <View key={j} style={styles.item}>
                  <Text style={[styles.body, styles.marker, { color: colors.mutedForeground }]}>
                    {b.ordered ? `${j + 1}.` : "•"}
                  </Text>
                  <Text style={[styles.body, styles.itemText, { color }]} selectable>
                    <Inline parts={item} color={color} />
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        if (b.kind === "code") {
          return (
            <Text key={i} style={[styles.codeBlock, { color, backgroundColor: colors.muted }]} selectable>
              {b.text}
            </Text>
          );
        }
        return (
          <Text key={i} style={[styles.body, { color }]} selectable>
            <Inline parts={b.parts} color={color} />
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  h1: { fontSize: 18, fontWeight: "700" },
  h2: { fontSize: 16, fontWeight: "700", marginTop: 4 },
  h3: { fontSize: 14, fontWeight: "700" },
  body: { fontSize: 14, lineHeight: 21 },
  bold: { fontWeight: "700" },
  code: { fontFamily: "monospace", fontSize: 13 },
  codeBlock: { fontFamily: "monospace", fontSize: 12, padding: 10, borderRadius: 8 },
  list: { gap: 4 },
  item: { flexDirection: "row", gap: 6 },
  marker: { minWidth: 16 },
  itemText: { flex: 1 },
});
