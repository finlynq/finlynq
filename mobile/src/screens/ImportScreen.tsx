import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import { useTheme } from "../theme";
import { getServerUrl } from "../api/client";

interface PreviewRow {
  date: string;
  account: string;
  amount: number;
  payee: string;
  category?: string;
  currency?: string;
  note?: string;
  hash?: string;
  rowIndex?: number;
}

interface PreviewResult {
  type: string;
  valid?: PreviewRow[];
  duplicates?: PreviewRow[];
  errors?: Array<{ rowIndex: number; message: string }>;
  transactionCount?: number;
  transactions?: PreviewRow[];
}

interface ImportResult {
  total: number;
  imported: number;
  skippedDuplicates: number;
  errors?: string[];
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
  }).format(amount);
}

export default function ImportScreen() {
  const theme = useTheme();
  const colors = theme.colors;

  const [step, setStep] = useState<"pick" | "preview" | "result">("pick");
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);

  const pickAndPreview = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "text/csv",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/pdf",
          "application/x-ofx",
          "application/ofx",
          "*/*",
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.length) return;

      const file = result.assets[0];
      setFileName(file.name);
      setLoading(true);

      const formData = new FormData();
      formData.append("file", {
        uri: file.uri,
        name: file.name,
        type: file.mimeType || "application/octet-stream",
      } as unknown as Blob);

      const res = await fetch(`${getServerUrl()}/api/import/preview`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.success) {
        setPreview(data.data);
        setStep("preview");
      } else {
        Alert.alert("Preview Error", data.error || "Failed to preview file");
      }
    } catch (err) {
      Alert.alert("Error", "Cannot connect to server or read file");
    } finally {
      setLoading(false);
    }
  };

  const executeImport = async () => {
    if (!preview) return;

    const rows = [
      ...(preview.valid || []),
      ...(preview.transactions || []),
      ...(includeDuplicates ? preview.duplicates || [] : []),
    ];

    if (rows.length === 0) {
      Alert.alert("No Rows", "There are no transactions to import.");
      return;
    }

    setLoading(true);
    try {
      const forceIndices = includeDuplicates
        ? (preview.duplicates || []).map((_, i) => (preview.valid?.length || 0) + i)
        : undefined;

      const res = await fetch(`${getServerUrl()}/api/import/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows,
          forceImportIndices: forceIndices,
        }),
      });
      const data = await res.json();

      if (data.success) {
        setImportResult(data.data);
        setStep("result");
      } else {
        Alert.alert("Import Error", data.error || "Failed to import");
      }
    } catch {
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep("pick");
    setPreview(null);
    setImportResult(null);
    setFileName("");
    setIncludeDuplicates(false);
  };

  const validCount = preview?.valid?.length || preview?.transactionCount || preview?.transactions?.length || 0;
  const dupCount = preview?.duplicates?.length || 0;
  const errCount = preview?.errors?.length || 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <Text style={[styles.header, { color: colors.foreground }]}>Import</Text>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Step: Pick File */}
        {step === "pick" && (
          <View style={styles.pickContainer}>
            <View
              style={[
                styles.dropZone,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.dropIcon, { color: colors.primary }]}>↓</Text>
              <Text style={[styles.dropTitle, { color: colors.foreground }]}>
                Import Transactions
              </Text>
              <Text style={[styles.dropSubtitle, { color: colors.mutedForeground }]}>
                Supports CSV, Excel, OFX, and PDF files
              </Text>
              <TouchableOpacity
                style={[styles.pickBtn, { backgroundColor: colors.primary }]}
                onPress={pickAndPreview}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.pickBtnText, { color: colors.primaryForeground }]}>
                    Choose File
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Step: Preview */}
        {step === "preview" && preview && (
          <View>
            <View
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Preview</Text>
              <Text style={[styles.fileName, { color: colors.mutedForeground }]}>{fileName}</Text>

              {/* Stats */}
              <View style={styles.statsRow}>
                <View style={[styles.stat, { backgroundColor: colors.chart3 + "15" }]}>
                  <Text style={[styles.statNum, { color: colors.chart3 }]}>{validCount}</Text>
                  <Text style={[styles.statLabel, { color: colors.chart3 }]}>Valid</Text>
                </View>
                {dupCount > 0 && (
                  <View style={[styles.stat, { backgroundColor: colors.chart4 + "15" }]}>
                    <Text style={[styles.statNum, { color: colors.chart4 }]}>{dupCount}</Text>
                    <Text style={[styles.statLabel, { color: colors.chart4 }]}>Duplicates</Text>
                  </View>
                )}
                {errCount > 0 && (
                  <View style={[styles.stat, { backgroundColor: colors.destructive + "15" }]}>
                    <Text style={[styles.statNum, { color: colors.destructive }]}>{errCount}</Text>
                    <Text style={[styles.statLabel, { color: colors.destructive }]}>Errors</Text>
                  </View>
                )}
              </View>
            </View>

            {/* Transaction preview list */}
            <View
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                Transactions to Import
              </Text>
              {(preview.valid || preview.transactions || []).slice(0, 10).map((row, i) => (
                <View
                  key={i}
                  style={[styles.previewRow, { borderBottomColor: colors.border }]}
                >
                  <View style={styles.previewLeft}>
                    <Text style={[styles.previewPayee, { color: colors.foreground }]} numberOfLines={1}>
                      {row.payee || "—"}
                    </Text>
                    <Text style={[styles.previewDate, { color: colors.mutedForeground }]}>
                      {row.date} • {row.account || "—"}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.previewAmount,
                      { color: row.amount >= 0 ? colors.chart3 : colors.foreground },
                    ]}
                  >
                    {formatCurrency(row.amount)}
                  </Text>
                </View>
              ))}
              {validCount > 10 && (
                <Text style={[styles.moreText, { color: colors.mutedForeground }]}>
                  +{validCount - 10} more rows
                </Text>
              )}
            </View>

            {/* Duplicates toggle */}
            {dupCount > 0 && (
              <TouchableOpacity
                style={[
                  styles.dupToggle,
                  {
                    backgroundColor: includeDuplicates ? colors.chart4 + "20" : colors.secondary,
                    borderColor: colors.border,
                  },
                ]}
                onPress={() => setIncludeDuplicates(!includeDuplicates)}
              >
                <Text style={[styles.dupToggleText, { color: colors.foreground }]}>
                  {includeDuplicates ? "✓" : "○"} Include {dupCount} duplicate
                  {dupCount > 1 ? "s" : ""}
                </Text>
              </TouchableOpacity>
            )}

            {/* Error list */}
            {errCount > 0 && (
              <View
                style={[
                  styles.card,
                  { backgroundColor: colors.destructive + "10", borderColor: colors.destructive + "30" },
                ]}
              >
                <Text style={[styles.cardTitle, { color: colors.destructive }]}>Errors</Text>
                {(preview.errors || []).slice(0, 5).map((err, i) => (
                  <Text key={i} style={[styles.errText, { color: colors.destructive }]}>
                    Row {err.rowIndex + 1}: {err.message}
                  </Text>
                ))}
              </View>
            )}

            {/* Actions */}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.cancelBtn, { borderColor: colors.border }]}
                onPress={reset}
              >
                <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.importBtn, { backgroundColor: colors.primary }]}
                onPress={executeImport}
                disabled={loading || validCount === 0}
              >
                {loading ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.importBtnText, { color: colors.primaryForeground }]}>
                    Import {validCount + (includeDuplicates ? dupCount : 0)} Rows
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Step: Result */}
        {step === "result" && importResult && (
          <View>
            <View
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Text style={[styles.successIcon, { color: colors.chart3 }]}>✓</Text>
              <Text style={[styles.successTitle, { color: colors.foreground }]}>
                Import Complete
              </Text>
              <Text style={[styles.successSubtitle, { color: colors.mutedForeground }]}>
                {importResult.imported} of {importResult.total} transactions imported
              </Text>
              {importResult.skippedDuplicates > 0 && (
                <Text style={[styles.resultDetail, { color: colors.chart4 }]}>
                  {importResult.skippedDuplicates} duplicates skipped
                </Text>
              )}
              {importResult.errors && importResult.errors.length > 0 && (
                <Text style={[styles.resultDetail, { color: colors.destructive }]}>
                  {importResult.errors.length} errors
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={[styles.importBtn, { backgroundColor: colors.primary }]}
              onPress={reset}
            >
              <Text style={[styles.importBtnText, { color: colors.primaryForeground }]}>
                Import Another File
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    fontSize: 28,
    fontWeight: "800",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  scroll: { padding: 16, paddingBottom: 32 },
  pickContainer: { flex: 1 },
  dropZone: {
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: "dashed",
    padding: 32,
    alignItems: "center",
  },
  dropIcon: { fontSize: 48, marginBottom: 12 },
  dropTitle: { fontSize: 20, fontWeight: "700", marginBottom: 8 },
  dropSubtitle: { fontSize: 14, textAlign: "center", marginBottom: 20, lineHeight: 20 },
  pickBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    minWidth: 160,
    alignItems: "center",
  },
  pickBtnText: { fontSize: 16, fontWeight: "700" },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  fileName: { fontSize: 13, marginBottom: 12 },
  statsRow: { flexDirection: "row", gap: 10 },
  stat: {
    flex: 1,
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  statNum: { fontSize: 24, fontWeight: "800" },
  statLabel: { fontSize: 11, fontWeight: "600", marginTop: 2 },
  previewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  previewLeft: { flex: 1, marginRight: 12 },
  previewPayee: { fontSize: 14, fontWeight: "500" },
  previewDate: { fontSize: 12, marginTop: 2 },
  previewAmount: { fontSize: 14, fontWeight: "600" },
  moreText: { fontSize: 12, textAlign: "center", marginTop: 8 },
  dupToggle: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 12,
    alignItems: "center",
  },
  dupToggleText: { fontSize: 14, fontWeight: "600" },
  errText: { fontSize: 13, marginBottom: 4 },
  actionRow: { flexDirection: "row", gap: 12, marginTop: 4 },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelBtnText: { fontSize: 15, fontWeight: "600" },
  importBtn: {
    flex: 2,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  importBtnText: { fontSize: 15, fontWeight: "700" },
  successIcon: { fontSize: 48, textAlign: "center", marginBottom: 8 },
  successTitle: { fontSize: 22, fontWeight: "700", textAlign: "center" },
  successSubtitle: { fontSize: 15, textAlign: "center", marginTop: 4 },
  resultDetail: { fontSize: 14, textAlign: "center", marginTop: 4 },
});
