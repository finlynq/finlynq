const React = require("react");

const useNavigation = jest.fn(() => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  dispatch: jest.fn(),
  setOptions: jest.fn(),
  reset: jest.fn(),
  addListener: jest.fn(() => jest.fn()),
}));

const useRoute = jest.fn(() => ({
  params: {},
}));

const useIsFocused = jest.fn(() => true);

const NavigationContainer = ({ children }) =>
  React.createElement("NavigationContainer", null, children);

const DefaultTheme = {
  dark: false,
  colors: {
    primary: "#4f46e5",
    background: "#f7f7fa",
    card: "#ffffff",
    text: "#0f0f17",
    border: "#e2e2e8",
    notification: "#e53e3e",
  },
};

const DarkTheme = {
  dark: true,
  colors: {
    primary: "#6366f1",
    background: "#0f0f17",
    card: "#1a1a24",
    text: "#f0f0f5",
    border: "#27273a",
    notification: "#ef4444",
  },
};

module.exports = {
  useNavigation,
  useRoute,
  useIsFocused,
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  createNavigationContainerRef: jest.fn(),
};
