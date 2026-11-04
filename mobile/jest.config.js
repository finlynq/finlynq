module.exports = {
  setupFiles: ["./jest.setup.js"],
  transform: {
    "\\.[jt]sx?$": "babel-jest",
  },
  transformIgnorePatterns: [],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  moduleNameMapper: {
    "^react-native$": "<rootDir>/__mocks__/react-native.js",
    "^react-native/(.*)$": "<rootDir>/__mocks__/react-native.js",
    "^react-native-safe-area-context$": "<rootDir>/__mocks__/react-native-safe-area-context.js",
    "^../../../shared/(.*)$": "<rootDir>/../shared/$1",
    "modules/finlynq-widgets$": "<rootDir>/__mocks__/finlynq-widgets.js",
    "modules/finlynq-app-update$": "<rootDir>/__mocks__/finlynq-app-update.js",
  },
  testPathIgnorePatterns: ["/node_modules/"],
  testEnvironment: "node",
  forceExit: true,
};
