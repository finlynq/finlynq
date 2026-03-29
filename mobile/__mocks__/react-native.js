const React = require("react");

// Minimal React Native mock for testing
const createComponent = (name) => {
  const Component = ({ children, ...props }) =>
    React.createElement(name, props, children);
  Component.displayName = name;
  return Component;
};

const View = createComponent("View");
const Text = createComponent("Text");
const ScrollView = createComponent("ScrollView");
const FlatList = ({ data, renderItem, keyExtractor, ListEmptyComponent, ...props }) => {
  if (!data || data.length === 0) {
    const Empty = ListEmptyComponent;
    return React.createElement(View, props, Empty ? (typeof Empty === "function" ? React.createElement(Empty) : Empty) : null);
  }
  return React.createElement(
    View,
    props,
    data.map((item, index) =>
      React.createElement(React.Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index }))
    )
  );
};
const TouchableOpacity = ({ children, onPress, onLongPress, ...props }) =>
  React.createElement("TouchableOpacity", { ...props, onClick: onPress, onPress, onLongPress }, children);
const TextInput = React.forwardRef(({ onChangeText, onSubmitEditing, ...props }, ref) =>
  React.createElement("TextInput", { ...props, ref, onChangeText, onSubmitEditing })
);
TextInput.displayName = "TextInput";
const ActivityIndicator = (props) => React.createElement("ActivityIndicator", props);
const Switch = (props) => React.createElement("Switch", props);
const Alert = {
  alert: jest.fn(),
};
const Animated = {
  Value: jest.fn(() => ({ interpolate: jest.fn() })),
  View: createComponent("Animated.View"),
  Text: createComponent("Animated.Text"),
  event: jest.fn(),
  timing: jest.fn(() => ({ start: jest.fn() })),
  spring: jest.fn(() => ({ start: jest.fn() })),
  createAnimatedComponent: (component) => component,
};
const StyleSheet = {
  create: (styles) => styles,
  hairlineWidth: 1,
  flatten: (style) => (Array.isArray(style) ? Object.assign({}, ...style) : style || {}),
};
const Platform = {
  OS: "ios",
  select: (obj) => obj.ios || obj.default,
};
const Dimensions = {
  get: () => ({ width: 375, height: 812 }),
};
const AppState = {
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  currentState: "active",
};
const useColorScheme = jest.fn(() => "light");
const RefreshControl = (props) => React.createElement("RefreshControl", props);
const KeyboardAvoidingView = createComponent("KeyboardAvoidingView");

module.exports = {
  View,
  Text,
  ScrollView,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Switch,
  Alert,
  Animated,
  StyleSheet,
  Platform,
  Dimensions,
  AppState,
  useColorScheme,
  RefreshControl,
  KeyboardAvoidingView,
};
