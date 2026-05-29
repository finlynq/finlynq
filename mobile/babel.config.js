module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // NOTE: do NOT add loose-mode private-field/class-property transforms here.
    // They were briefly used to satisfy the stale local Windows-ARM64 hermesc,
    // but EAS's Linux Hermes handles private fields natively, and `loose: true`
    // broke event-target-shim (RN fetch/AbortController) with
    // "cannot assign to read-only property 'NONE'" — every fetch threw.
    plugins: ["react-native-worklets/plugin"],
  };
};
