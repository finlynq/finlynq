// The WidgetKit extension (GH #392). @bacons/apple-targets links this folder into
// the Xcode project at prebuild, so every file here is part of the extension.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "FinlynqWidget",
  displayName: "Finlynq",
  bundleIdentifier: ".widgets",
  // Lock Screen widgets start at iOS 16; the plugin links ActivityKit, new in 16.1.
  deploymentTarget: "16.1",
  colors: {
    $accent: "#f5a623",
    $widgetBackground: { color: "#ffffff", darkColor: "#101317" },
  },
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
