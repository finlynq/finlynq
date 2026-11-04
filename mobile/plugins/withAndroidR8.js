// Expo config plugin — turn R8 on for Android release builds.
//
// Google Play's production track flagged the app: "DEX code optimization is below
// our threshold: Obfuscation (1%)", fix by Feb 2027. Expo's prebuild template
// ships R8 off behind this gradle property.
//
// The property's NAME belongs to Expo's template (node_modules/expo/template.tgz,
// android/app/build.gradle) and a wrong name does nothing at all, silently: the
// SDK 54 template doesn't read the older `android.enableProguardInReleaseBuilds`.
// The release workflow fails if a build comes out without a mapping file, which
// is what catches a rename on an Expo upgrade.
//
// Resource shrinking stays off on purpose. Play did not ask for it, and React
// Native looks its image assets up by name at runtime, where a shrinker can't see.

const { withGradleProperties } = require("expo/config-plugins");

const KEY = "android.enableMinifyInReleaseBuilds";

module.exports = function withAndroidR8(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === "property" && item.key === KEY)
    );
    cfg.modResults.push({ type: "property", key: KEY, value: "true" });
    return cfg;
  });
};
