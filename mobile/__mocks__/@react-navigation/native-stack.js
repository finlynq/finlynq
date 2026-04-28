const React = require("react");

const createNativeStackNavigator = () => ({
  Navigator: ({ children, ...props }) =>
    React.createElement("StackNavigator", props, children),
  Screen: ({ children, ...props }) =>
    React.createElement("StackScreen", props, children),
});

module.exports = { createNativeStackNavigator };
