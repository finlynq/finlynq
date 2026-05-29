// Standard Expo Metro config. Extending expo/metro-config silences the
// expo-doctor "custom metro config" check and ensures Expo's transformer/resolver.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

module.exports = config;
