// Jest setup for React Native testing
// Note: @testing-library/jest-native/extend-expect is in setupFilesAfterFramework

// Mock react-native-safe-area-context
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  return {
    SafeAreaProvider: ({ children }) => React.createElement("SafeAreaProvider", null, children),
    SafeAreaView: ({ children, ...props }) =>
      React.createElement("SafeAreaView", props, children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

// Mock react-native-gesture-handler
jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  return {
    GestureHandlerRootView: ({ children, ...props }) =>
      React.createElement("GestureHandlerRootView", props, children),
    Swipeable: "Swipeable",
    DrawerLayout: "DrawerLayout",
    State: {},
    PanGestureHandler: "PanGestureHandler",
    TapGestureHandler: "TapGestureHandler",
    FlingGestureHandler: "FlingGestureHandler",
    ForceTouchGestureHandler: "ForceTouchGestureHandler",
    LongPressGestureHandler: "LongPressGestureHandler",
    NativeViewGestureHandler: "NativeViewGestureHandler",
    ScrollView: "ScrollView",
    Slider: "Slider",
    Switch: "Switch",
    TextInput: "TextInput",
    ToolbarAndroid: "ToolbarAndroid",
    ViewPagerAndroid: "ViewPagerAndroid",
    DrawerLayoutAndroid: "DrawerLayoutAndroid",
    WebView: "WebView",
    NativeGestures: "NativeGestures",
    TouchableWithoutFeedback: "TouchableWithoutFeedback",
    TouchableOpacity: "TouchableOpacity",
    TouchableHighlight: "TouchableHighlight",
    TouchableNativeFeedback: "TouchableNativeFeedback",
    Directions: {},
    gestureHandlerRootHOC: (component) => component,
  };
});

// Mock expo-status-bar
jest.mock("expo-status-bar", () => ({
  StatusBar: "StatusBar",
}));

// Mock expo-local-authentication
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(false),
  isEnrolledAsync: jest.fn().mockResolvedValue(false),
  authenticateAsync: jest.fn().mockResolvedValue({ success: false }),
}));

// Mock expo-secure-store
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// Mock @react-native-async-storage/async-storage
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  multiGet: jest.fn().mockResolvedValue([]),
  multiSet: jest.fn().mockResolvedValue(undefined),
}));

// Mock expo-document-picker
jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true }),
}));

// Mock react-native-reanimated
jest.mock("react-native-reanimated", () => ({
  default: {
    call: () => {},
    createAnimatedComponent: (component) => component,
    Value: jest.fn(),
    event: jest.fn(),
    add: jest.fn(),
    eq: jest.fn(),
    set: jest.fn(),
    cond: jest.fn(),
    interpolate: jest.fn(),
    View: "View",
    ScrollView: "ScrollView",
    FlatList: "FlatList",
    Extrapolate: { CLAMP: "clamp" },
    Transition: {
      Together: "Together",
      Out: "Out",
      In: "In",
    },
    useSharedValue: jest.fn(() => ({ value: 0 })),
    useAnimatedStyle: jest.fn(() => ({})),
    withTiming: jest.fn((value) => value),
    withSpring: jest.fn((value) => value),
    withDecay: jest.fn((value) => value),
    runOnJS: jest.fn((fn) => fn),
  },
  useSharedValue: jest.fn(() => ({ value: 0 })),
  useAnimatedStyle: jest.fn(() => ({})),
  withTiming: jest.fn((value) => value),
  withSpring: jest.fn((value) => value),
  withDecay: jest.fn((value) => value),
  runOnJS: jest.fn((fn) => fn),
}));

// Silence warnings
jest.spyOn(console, "warn").mockImplementation(() => {});
